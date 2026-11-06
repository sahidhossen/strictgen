/**
 * `strictgen fix`: rewrites schema files into the supported subset where it can, with rules that
 * run until nothing changes, then checks the result with the real generator. It works on the
 * schema text, not the model, so every part a rule doesn't touch stays as it was written.
 */
import type { BuildOptions } from "./build.js";
import { ANNOTATIONS, CONSTRAINTS } from "./build.js";
import { compare } from "./common.js";
import type { JMap, JValue } from "./fix-json.js";
import {
  edit,
  editArr,
  identical,
  insertBefore,
  isArr,
  isMap,
  JsonSyntaxError,
  parseJson,
  removeKey,
  render,
  renameKey,
  sameValue,
  setKey,
  styleOf,
} from "./fix-json.js";
import type { Target } from "./main.js";
import { generate } from "./main.js";
import { pascal } from "./naming.js";
import type { Json, JsonObject, SchemaOptions } from "./schema.js";
import { CodegenError, isObject, schemaSet } from "./schema.js";

/** The rewrite rules, each with a one line summary. A note names the rule that left something. */
export const FIX_RULES = {
  "merge-allof": "inlines an allOf whose parts are plain schemas that don't disagree",
  "tag-unions":
    "makes a oneOf whose branches each have a const property a tagged union: the tag required, a const, every branch an object",
  "close-objects":
    "closes open objects with additionalProperties false, or unevaluatedProperties false beside allOf, oneOf, anyOf or if",
  "hoist-defs":
    "moves definitions, nested $defs and schemas a $ref points into into the file's $defs, with generated names",
} as const satisfies Record<string, string>;

/** A rewrite rule id, like `close-objects`. */
export type FixRuleId = keyof typeof FIX_RULES;

/** Something a rule left as it was, and what to change by hand. */
export interface FixNote {
  /** The schema file, like `order.json`. */
  readonly file: string;
  /** A JSON Pointer into the file as fixed. */
  readonly pointer: string;
  readonly rule: FixRuleId;
  readonly reason: string;
  readonly hint: string;
}

/** Formats a note like `order.json#/allOf: merge-allof: <reason>. Hint: <hint>`. */
export function noteText(note: FixNote): string {
  return `${note.file}#${note.pointer}: ${note.rule}: ${note.reason}. Hint: ${note.hint}`;
}

/** One schema file to fix: its name without `.json`, and its text. */
export interface FixInput {
  readonly name: string;
  readonly text: string;
}

/** One schema file after fixing. `after` equals `before` when no rule changed it. */
export interface FixedFile {
  /** The file name, like `order.json`. */
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

/** What {@link fixSchemas} did. */
export interface FixResult {
  /** Every file, sorted by name. */
  readonly files: readonly FixedFile[];
  /** What the rules left, from the last pass, which changed nothing. */
  readonly notes: readonly FixNote[];
  /** How many passes ran, the last one changing nothing. */
  readonly passes: number;
  /** The first error generating from the fixed schemas, or undefined when generation passes. */
  readonly problem: CodegenError | undefined;
}

/** Options for {@link fixSchemas}: how to read the schemas and the targets to check them with. */
export interface FixOptions extends SchemaOptions, BuildOptions {
  readonly targets: readonly Target[];
  /** The most passes to run before giving up. Defaults to {@link MAX_PASSES}. */
  readonly maxPasses?: number;
}

/** Rules run in passes until one changes nothing. Real schemas settle in a few. */
export const MAX_PASSES = 32;
/** The most moves one pass of hoisting makes in the whole set. */
const MAX_MOVES = 10_000;

type Seg = string | number;

/** Keywords whose value is one schema, an array of schemas, or an object of schemas. */
const SINGLE = new Set([
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "additionalItems",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "contains",
  "contentSchema",
]);
const ARRAYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems", "items"]);
const MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
/** Where a schema sits: the keyword above it, and the schema holding that keyword. */
interface Place {
  readonly keyword: string | undefined;
  readonly parent: JMap | undefined;
}
const ROOT: Place = { keyword: undefined, parent: undefined };

/** The schemas directly inside `node`, with their path below it and the keyword that holds them. */
function children(node: JMap): { segs: Seg[]; child: JValue; keyword: string }[] {
  const found: { segs: Seg[]; child: JValue; keyword: string }[] = [];
  for (const [key, value] of node) {
    if (SINGLE.has(key) && !isArr(value)) found.push({ segs: [key], child: value, keyword: key });
    else if (ARRAYS.has(key) && isArr(value))
      value.forEach((child, i) => found.push({ segs: [key, i], child, keyword: key }));
    else if (MAPS.has(key) && isMap(value))
      for (const [name, child] of value) found.push({ segs: [key, name], child, keyword: key });
  }
  return found;
}

/** Replaces the value at `segs` below `node`, or removes it when `value` is undefined. */
function setAt(node: JValue, segs: readonly Seg[], value: JValue | undefined): JValue {
  const [head, ...rest] = segs;
  if (head === undefined) return value ?? null;
  if (isMap(node)) {
    const key = String(head);
    if (rest.length === 0 && value === undefined) return removeKey(node, key);
    const child = node.get(key);
    if (child === undefined && rest.length > 0) return node;
    const next = setAt(child ?? null, rest, value);
    return next === child ? node : setKey(node, key, next);
  }
  if (isArr(node)) {
    const index = Number(head);
    const child = node[index];
    if (child === undefined) return node;
    const next = setAt(child, rest, value);
    return next === child ? node : editArr(node, (d) => (d[index] = next));
  }
  return node;
}

/** The value at `segs` below `node`. */
function getAt(node: JValue | undefined, segs: readonly Seg[]): JValue | undefined {
  let current = node;
  for (const seg of segs) {
    if (isMap(current)) current = current.get(String(seg));
    else if (isArr(current) && /^(0|[1-9][0-9]*)$/.test(String(seg)))
      current = current[Number(seg)];
    else return undefined;
  }
  return current;
}

/** Applies `visit` to every schema object, top down: each node first, then the children it has. */
function mapSchemas(
  node: JValue,
  path: readonly Seg[],
  place: Place,
  visit: (node: JMap, path: readonly Seg[], place: Place) => JMap,
): JValue {
  if (!isMap(node)) return node;
  let current = visit(node, path, place);
  for (const { segs, child, keyword } of children(current)) {
    const next = mapSchemas(child, [...path, ...segs], { keyword, parent: current }, visit);
    if (next !== child) current = setAt(current, segs, next) as JMap;
  }
  return current;
}

/** Calls `visit` on every schema object below and including `node`. */
function eachSchema(
  node: JValue,
  path: readonly Seg[],
  visit: (node: JMap, path: readonly Seg[]) => void,
): void {
  if (!isMap(node)) return;
  visit(node, path);
  for (const { segs, child } of children(node)) eachSchema(child, [...path, ...segs], visit);
}

/** Formats path segments as a JSON Pointer. */
function pointer(segs: readonly Seg[]): string {
  return segs.map((s) => `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/** A place a `$ref` names: a schema file and a path into it. */
interface RefTarget {
  readonly file: string;
  readonly segs: readonly string[];
  /** The part before `#`, kept when the ref is rewritten. */
  readonly prefix: string;
}

/**
 * Reads a `$ref` the way the generator resolves it: `#<pointer>` in the same file, or
 * `<idBase><file>.json#<pointer>`. Anything else, like an anchor or an escaped `%`, is left alone.
 */
function parseRef(ref: string, file: string, base: string | undefined): RefTarget | undefined {
  const hash = ref.indexOf("#");
  const prefix = hash === -1 ? ref : ref.slice(0, hash);
  const fragment = hash === -1 ? "" : ref.slice(hash + 1);
  let target = file;
  if (prefix !== "") {
    if (base === undefined || !prefix.startsWith(base)) return undefined;
    const name = /^([a-z0-9-]+)\.json$/.exec(prefix.slice(base.length))?.[1];
    if (name === undefined) return undefined;
    target = name;
  }
  if (fragment === "") return { file: target, segs: [], prefix };
  if (!fragment.startsWith("/") || fragment.includes("%")) return undefined;
  const segs = fragment
    .slice(1)
    .split("/")
    .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  return { file: target, segs, prefix };
}

/** A `$def` name the generator takes in a `$ref` and turns into a type name. */
const DEF_NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function camel(words: string): string {
  const name = pascal(words);
  const safe = name === "" ? "Def" : /^[0-9]/.test(name) ? `Def${name}` : name;
  return safe.charAt(0).toLowerCase() + safe.slice(1);
}

/** The first candidate whose type name is free, else the last one with the lowest free number. */
function pickName(candidates: readonly string[], taken: (name: string) => boolean): string {
  for (const candidate of candidates) if (!taken(candidate)) return candidate;
  const last = candidates[candidates.length - 1] ?? "def";
  for (let n = 2; ; n++) if (!taken(`${last}${String(n)}`)) return `${last}${String(n)}`;
}

/**
 * Candidate def names for the schema at `segs`, from the property and def names on its path,
 * like `address`, then `shippingAddress`. Keywords add a word: `items` gives `linesItem`.
 */
function namesFor(file: string, segs: readonly Seg[]): string[] {
  const groups: string[][] = [];
  const word = (text: string): void => {
    const last = groups[groups.length - 1];
    if (last === undefined) groups.push([file, text]);
    else last.push(text);
  };
  for (let i = 0; i < segs.length; i++) {
    const seg = String(segs[i]);
    if (MAPS.has(seg) && i + 1 < segs.length) {
      groups.push([String(segs[i + 1])]);
      i++;
    } else if (ARRAYS.has(seg) && /^[0-9]+$/.test(String(segs[i + 1] ?? ""))) {
      word(
        `${seg === "items" || seg === "prefixItems" ? "item" : "variant"} ${String(Number(segs[i + 1]) + 1)}`,
      );
      i++;
    } else if (seg === "items") word("item");
    else if (seg === "additionalProperties") word("value");
    else word(seg);
  }
  if (groups.length === 0) groups.push([file]);
  return groups.map((_, k) =>
    camel(
      groups
        .slice(groups.length - k - 1)
        .flat()
        .join(" "),
    ),
  );
}

/** True when `segs` below a schema names a schema, not a keyword's other value. */
function isSchemaPath(segs: readonly string[]): boolean {
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] ?? "";
    if (MAPS.has(seg) || (ARRAYS.has(seg) && /^(0|[1-9][0-9]*)$/.test(segs[i + 1] ?? ""))) i++;
    else if (!SINGLE.has(seg)) return false;
    if (i >= segs.length) return false;
  }
  return true;
}

/** True when every key of `node` is in `allowed`. */
function onlyKeys(node: JMap, allowed: ReadonlySet<string>): boolean {
  return [...node.keys()].every((k) => allowed.has(k));
}

interface Pass {
  readonly trees: Map<string, JValue>;
  readonly base: string | undefined;
  readonly notes: FixNote[];
  /** `file#pointer` of every schema an allOf names with a `$ref`. Those stay open. */
  readonly bases: ReadonlySet<string>;
}

function note(
  pass: Pass,
  file: string,
  segs: readonly Seg[],
  rule: FixRuleId,
  reason: string,
  hint: string,
): void {
  const entry = { file: `${file}.json`, pointer: pointer(segs), rule, reason, hint };
  if (!pass.notes.some((n) => noteText(n) === noteText(entry))) pass.notes.push(entry);
}

function basesOf(trees: ReadonlyMap<string, JValue>, base: string | undefined): Set<string> {
  const bases = new Set<string>();
  for (const [file, tree] of trees) {
    eachSchema(tree, [], (node) => {
      const allOf = node.get("allOf");
      if (!isArr(allOf)) return;
      for (const entry of allOf) {
        const ref = isMap(entry) ? entry.get("$ref") : undefined;
        if (typeof ref !== "string") continue;
        const target = parseRef(ref, file, base);
        if (target !== undefined) bases.add(`${target.file}#${pointer(target.segs)}`);
      }
    });
  }
  return bases;
}

// merge-allof

/** Keywords an allOf part may hold to be merged: they mean the same beside each other. */
const MERGEABLE = new Set<string>([
  ...ANNOTATIONS,
  ...CONSTRAINTS,
  "type",
  "properties",
  "required",
  "format",
  "enum",
  "const",
  "items",
]);
/** Keywords beside an allOf whose meaning depends on the properties or items next to them. */
const SIBLING_DEPENDENT = [
  "$ref",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
];

function mergeAllOf(pass: Pass, file: string, node: JMap, path: readonly Seg[]): JMap {
  const allOf = node.get("allOf");
  if (!isArr(allOf) || allOf.length === 0) return node;
  const parts: JMap[] = [];
  for (const part of allOf) {
    if (!isMap(part) || !onlyKeys(part, MERGEABLE)) return node;
    parts.push(part);
  }
  if (SIBLING_DEPENDENT.some((k) => node.has(k))) return node;
  const merged = new Map<string, JValue>();
  const current = (key: string): JValue | undefined =>
    merged.has(key) ? merged.get(key) : node.get(key);
  const has = (key: string): boolean => merged.has(key) || node.has(key);
  const conflict = (what: string): JMap => {
    note(
      pass,
      file,
      [...path, "allOf"],
      "merge-allof",
      `the allOf parts disagree on ${what}, so they can't be merged`,
      "merge them by hand into one schema, keeping the value each part needs",
    );
    return node;
  };
  for (const part of parts) {
    for (const [key, value] of part) {
      const existing = current(key);
      if (!has(key)) merged.set(key, value);
      else if (key === "properties") {
        if (!isMap(existing) || !isMap(value)) return conflict("properties");
        for (const [name, schema] of value) {
          const other = existing.get(name);
          if (other !== undefined && !sameValue(other, schema))
            return conflict(`the schema of property ${name}`);
        }
        merged.set(
          key,
          edit(existing, (d) => {
            for (const [name, schema] of value) if (!d.has(name)) d.set(name, schema);
          }),
        );
      } else if (key === "required") {
        if (!isArr(existing) || !isArr(value)) return conflict("required");
        const add = value.filter((v) => !existing.some((e) => sameValue(e, v)));
        if (add.length > 0)
          merged.set(
            key,
            editArr(existing, (d) => d.push(...add)),
          );
      } else if (!sameValue(existing, value)) return conflict(key);
    }
  }
  return edit(node, (d) => {
    const entries = [...d];
    d.clear();
    for (const [key, value] of entries) {
      if (key === "allOf") {
        for (const [k, v] of merged) if (!node.has(k)) d.set(k, v);
      } else d.set(key, merged.has(key) ? (merged.get(key) ?? null) : value);
    }
  });
}

// tag-unions

const UNION_KEYS = new Set<string>([
  ...ANNOTATIONS,
  "type",
  "oneOf",
  "$schema",
  "$id",
  "$defs",
  "definitions",
]);
const TAG_KEYS = new Set<string>([...ANNOTATIONS, "const", "enum", "type"]);
const REF_BRANCH_KEYS = new Set(["$ref", "description", "$comment", "title"]);

/** The value of a tag property: a string const, or an enum of one string. */
function tagValue(schema: JValue | undefined): string | undefined {
  if (!isMap(schema) || !onlyKeys(schema, TAG_KEYS)) return undefined;
  const type = schema.get("type");
  if (type !== undefined && type !== "string") return undefined;
  const value = schema.get("const");
  const values = schema.get("enum");
  if (typeof value === "string" && values === undefined) return value;
  if (value === undefined && isArr(values) && values.length === 1 && typeof values[0] === "string")
    return values[0];
  return undefined;
}

interface UnionBranch {
  readonly schema: JMap;
  readonly properties: JMap;
  /** Where the branch is written, for a note. */
  readonly file: string;
  readonly segs: readonly Seg[];
  readonly inline: boolean;
}

function unionBranch(
  pass: Pass,
  file: string,
  value: JValue,
  segs: readonly Seg[],
): UnionBranch | undefined {
  if (!isMap(value)) return undefined;
  let branch = { schema: value, file, segs, inline: true };
  const ref = value.get("$ref");
  if (ref !== undefined) {
    if (typeof ref !== "string" || !onlyKeys(value, REF_BRANCH_KEYS)) return undefined;
    const target = parseRef(ref, file, pass.base);
    const schema =
      target === undefined ? undefined : getAt(pass.trees.get(target.file), target.segs);
    if (target === undefined || !isMap(schema) || schema.has("$ref")) return undefined;
    branch = { schema, file: target.file, segs: target.segs, inline: false };
  }
  const type = branch.schema.get("type");
  const properties = branch.schema.get("properties");
  if ((type !== undefined && type !== "object") || !isMap(properties)) return undefined;
  return { ...branch, properties };
}

function tagUnion(pass: Pass, file: string, node: JMap, path: readonly Seg[]): JMap {
  const oneOf = node.get("oneOf");
  if (!isArr(oneOf) || oneOf.length < 2 || !onlyKeys(node, UNION_KEYS)) return node;
  const type = node.get("type");
  if (type !== undefined && type !== "object") return node;
  const branches: UnionBranch[] = [];
  for (const [i, value] of oneOf.entries()) {
    const branch = unionBranch(pass, file, value, [...path, "oneOf", i]);
    if (branch === undefined) return node;
    branches.push(branch);
  }
  const [first] = branches;
  if (first === undefined) return node;
  const candidates = [...first.properties.keys()].filter((key) =>
    branches.every((b) => tagValue(b.properties.get(key)) !== undefined),
  );
  if (candidates.length === 0) return node;
  const valuesOf = (key: string): string[] =>
    branches.map((b) => tagValue(b.properties.get(key)) ?? "");
  const distinct = candidates.filter((key) => new Set(valuesOf(key)).size === branches.length);
  const requiredIn = (key: string): number =>
    branches.filter((b) => {
      const required = b.schema.get("required");
      return isArr(required) && required.includes(key);
    }).length;
  const tag = distinct.sort(
    (a, b) => requiredIn(b) - requiredIn(a) || candidates.indexOf(a) - candidates.indexOf(b),
  )[0];
  if (tag === undefined) {
    const [key = ""] = candidates;
    const values = valuesOf(key);
    const repeated = values.find((v, i) => values.indexOf(v) !== i) ?? "";
    note(
      pass,
      file,
      [...path, "oneOf"],
      "tag-unions",
      `two branches have the same value ${JSON.stringify(repeated)} for the tag ${key}`,
      `give every branch a different ${key} const`,
    );
    return node;
  }
  const rewritten: JValue[] = [];
  for (const [i, branch] of branches.entries()) {
    let schema = branch.schema;
    const changes: string[] = [];
    const prop = branch.properties.get(tag);
    const value = tagValue(prop);
    if (isMap(prop) && value !== undefined && prop.has("enum")) {
      changes.push(
        `"${tag}": { "const": ${JSON.stringify(value)} } in place of its one value enum`,
      );
      schema = setKey(
        schema,
        "properties",
        setKey(branch.properties, tag, setKey(renameKey(prop, "enum", "const"), "const", value)),
      );
    }
    const required = schema.get("required");
    if (!isArr(required) || !required.includes(tag)) {
      changes.push(`${tag} in "required"`);
      schema = isArr(required)
        ? setKey(
            schema,
            "required",
            editArr(required, (d) => d.push(tag)),
          )
        : setKey(schema, "required", [tag], "properties");
    }
    if (!schema.has("type")) {
      changes.push('"type": "object"');
      schema = insertBefore(schema, "type", "object", "properties");
    }
    if (changes.length > 0 && !branch.inline) {
      note(
        pass,
        branch.file,
        branch.segs,
        "tag-unions",
        `this branch of the union at ${file}.json#${pointer(path)} needs ${changes.join(", and ")}`,
        "change it by hand, since other schemas may use it too",
      );
      return node;
    }
    rewritten.push(branch.inline ? schema : (oneOf[i] ?? null));
  }
  let next = rewritten.every((v, i) => v === oneOf[i])
    ? node
    : setKey(
        node,
        "oneOf",
        editArr(oneOf, (d) => d.splice(0, d.length, ...rewritten)),
      );
  if (type !== undefined) next = removeKey(next, "type");
  return next;
}

// close-objects

/** Keywords under which a schema is a type of its own, not a part of the schema above it. */
const TYPE_PLACES = new Set([
  "$defs",
  "definitions",
  "properties",
  "items",
  "prefixItems",
  "additionalProperties",
  "patternProperties",
]);
const OPEN_CLOSERS = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "patternProperties",
];
const APPLICATORS = ["allOf", "oneOf", "anyOf", "if"];
/** Keywords that bring in keys of their own, so closing the object beside them narrows it. */
const REF_LIKE = ["$ref", "$dynamicRef", "dependentSchemas"];

function isTypePlace(place: Place): boolean {
  if (place.keyword === undefined) return true;
  if (TYPE_PLACES.has(place.keyword)) return true;
  // The branches of a union are types. Those of an object's oneOf only name keys.
  return (
    place.keyword === "oneOf" &&
    place.parent !== undefined &&
    !place.parent.has("type") &&
    !place.parent.has("properties")
  );
}

function closeObject(
  pass: Pass,
  file: string,
  node: JMap,
  path: readonly Seg[],
  place: Place,
): JMap {
  if (node.get("type") !== "object" || OPEN_CLOSERS.some((k) => node.has(k))) return node;
  if (!isTypePlace(place) || pass.bases.has(`${file}#${pointer(path)}`)) return node;
  const beside = REF_LIKE.find((k) => node.has(k));
  if (beside !== undefined) {
    note(
      pass,
      file,
      path,
      "close-objects",
      `an object with ${beside} beside its properties stays open, since closing it would reject keys ${beside} allows`,
      beside === "dependentSchemas"
        ? 'declare every key in "properties" and close the object by hand'
        : 'move the $ref into "allOf" and add "unevaluatedProperties": false',
    );
    return node;
  }
  const applicator = APPLICATORS.some((k) => node.has(k));
  if (!applicator && !node.has("properties")) {
    note(
      pass,
      file,
      path,
      "close-objects",
      "an object with no properties stays open, since closing it would allow only {}",
      'list its keys in "properties", or give "additionalProperties" the schema of its values to make it a map',
    );
    return node;
  }
  return setKey(node, applicator ? "unevaluatedProperties" : "additionalProperties", false);
}

// hoist-defs

interface Move {
  readonly file: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
}

/** Points every `$ref` into `move.from`, in every file, at `move.to` instead. */
function rewriteRefs(pass: Pass, move: Move): void {
  for (const [file, tree] of pass.trees) {
    const next = mapSchemas(tree, [], ROOT, (node) => {
      const ref = node.get("$ref");
      if (typeof ref !== "string") return node;
      const target = parseRef(ref, file, pass.base);
      if (target?.file !== move.file || target.segs.length < move.from.length) return node;
      if (!move.from.every((s, i) => target.segs[i] === s)) return node;
      const segs = [...move.to, ...target.segs.slice(move.from.length)];
      return setKey(node, "$ref", `${target.prefix}#${pointer(segs)}`);
    });
    if (next !== tree) pass.trees.set(file, next);
  }
}

/** True when a schema below the root of `tree` has its own `$id`, which changes what refs mean. */
function nestedId(tree: JValue): boolean {
  let found = false;
  eachSchema(tree, [], (node, path) => {
    if (path.length > 0 && node.has("$id")) found = true;
  });
  return found;
}

/**
 * Whether a def name would give a type name in use: by a def of `root`, or, for a new def,
 * `everywhere` (any def or root title of the set), so a new def never renames an existing type.
 */
function takenIn(pass: Pass, root: JMap, everywhere: boolean): (name: string) => boolean {
  const names = new Set<string>();
  const add = (tree: JValue | undefined, titles: boolean): void => {
    if (!isMap(tree)) return;
    const defs = tree.get("$defs");
    if (isMap(defs)) for (const key of defs.keys()) names.add(pascal(key));
    const title = tree.get("title");
    if (titles && typeof title === "string") names.add(pascal(title));
  };
  add(root, everywhere);
  if (everywhere) for (const tree of pass.trees.values()) add(tree, true);
  return (name) => names.has(pascal(name));
}

/** Adds `schema` to the root `$defs` of `file` as `name`, creating `$defs` last when missing. */
function addDef(pass: Pass, file: string, name: string, schema: JValue): void {
  const root = pass.trees.get(file);
  if (!isMap(root)) return;
  const defs = root.get("$defs");
  pass.trees.set(
    file,
    setKey(root, "$defs", isMap(defs) ? setKey(defs, name, schema) : new Map([[name, schema]])),
  );
}

/** One move of the hoist rule, or false when there is none left. */
function hoistOnce(pass: Pass): boolean {
  const blocked = new Set<string>();
  for (const [file, tree] of pass.trees) if (nestedId(tree)) blocked.add(file);
  const refuse = (file: string, segs: readonly Seg[]): void => {
    note(
      pass,
      file,
      segs,
      "hoist-defs",
      "a schema in this file has its own $id, which changes what its $refs point at",
      "remove the inner $id and move the schema into $defs by hand",
    );
  };
  for (const [file, tree] of [...pass.trees].sort(([a], [b]) => compare(a, b))) {
    if (!isMap(tree)) continue;
    const root = tree;
    const defs = root.get("$defs");
    // A root definitions object becomes $defs.
    const definitions = root.get("definitions");
    if (isMap(definitions) && (defs === undefined || isMap(defs))) {
      if (blocked.has(file)) {
        refuse(file, ["definitions"]);
      } else {
        const taken = takenIn(pass, root, false);
        const chosen = new Set<string>();
        const renames: [string, string][] = [];
        for (const name of definitions.keys()) {
          const used = (n: string): boolean => taken(n) || chosen.has(pascal(n));
          const next = DEF_NAME.test(name) && !used(name) ? name : pickName([camel(name)], used);
          chosen.add(pascal(next));
          renames.push([name, next]);
        }
        const moved = edit(definitions, (d) => {
          d.clear();
          for (const [from, to] of renames) d.set(to, definitions.get(from) ?? null);
        });
        const next = isMap(defs)
          ? removeKey(
              setKey(
                root,
                "$defs",
                edit(defs, (d) => {
                  for (const [k, v] of moved) d.set(k, v);
                }),
              ),
              "definitions",
            )
          : setKey(renameKey(root, "definitions", "$defs"), "$defs", moved);
        pass.trees.set(file, next);
        for (const [from, to] of renames)
          rewriteRefs(pass, { file, from: ["definitions", from], to: ["$defs", to] });
        return true;
      }
    }
    // Def containers inside a schema move up to the root $defs.
    let nested: { segs: readonly Seg[]; keyword: string; container: JMap } | undefined;
    eachSchema(root, [], (node, path) => {
      if (nested !== undefined || path.length === 0) return;
      for (const keyword of ["$defs", "definitions"]) {
        const container = node.get(keyword);
        if (isMap(container) && nested === undefined) nested = { segs: path, keyword, container };
      }
    });
    if (nested !== undefined && (defs === undefined || isMap(defs))) {
      if (blocked.has(file)) refuse(file, [...nested.segs, nested.keyword]);
      else {
        const { segs, keyword, container } = nested;
        pass.trees.set(file, setAt(root, [...segs, keyword], undefined));
        for (const [name, schema] of container) {
          const current = pass.trees.get(file);
          if (!isMap(current)) break;
          const taken = takenIn(pass, current, true);
          const wanted = [...segs, keyword, name];
          const next =
            DEF_NAME.test(name) && !taken(name) ? name : pickName(namesFor(file, wanted), taken);
          addDef(pass, file, next, schema);
          rewriteRefs(pass, { file, from: wanted.map(String), to: ["$defs", next] });
        }
        return true;
      }
    }
  }
  // A $ref that points anywhere but a $defs entry, or at one the generator can't name.
  const refs: { file: string; segs: readonly Seg[]; target: RefTarget }[] = [];
  for (const [file, tree] of pass.trees) {
    eachSchema(tree, [], (node, segs) => {
      const ref = node.get("$ref");
      const target = typeof ref === "string" ? parseRef(ref, file, pass.base) : undefined;
      if (target !== undefined && pass.trees.has(target.file)) refs.push({ file, segs, target });
    });
  }
  refs.sort((a, b) => compare(a.file, b.file) || compare(pointer(a.segs), pointer(b.segs)));
  for (const { target } of refs) {
    const { file, segs } = target;
    const root = pass.trees.get(file);
    if (!isMap(root) || segs.length === 0) continue;
    const isDef = segs.length === 2 && segs[0] === "$defs";
    if (isDef && DEF_NAME.test(segs[1] ?? "")) continue;
    const schema = getAt(root, segs);
    if (!isMap(schema) || !isSchemaPath(segs)) continue;
    const defs = root.get("$defs");
    if (defs !== undefined && !isMap(defs)) continue;
    if (blocked.has(file)) {
      refuse(file, segs);
      continue;
    }
    if (isDef && isMap(defs)) {
      // A def the generator can't name in a $ref, like order-item, gets a name it can.
      const from = segs[1] ?? "";
      const others = new Set([...defs.keys()].filter((k) => k !== from).map(pascal));
      const name = pickName([camel(from)], (n) => others.has(pascal(n)));
      pass.trees.set(file, setKey(root, "$defs", renameKey(defs, from, name)));
      rewriteRefs(pass, { file, from: segs, to: ["$defs", name] });
      return true;
    }
    const name = pickName(namesFor(file, segs), takenIn(pass, root, true));
    rewriteRefs(pass, { file, from: segs, to: ["$defs", name] });
    const current = pass.trees.get(file) ?? root;
    const moved = getAt(current, segs) ?? schema;
    pass.trees.set(file, setAt(current, segs, new Map([["$ref", `#/$defs/${name}`]])));
    addDef(pass, file, name, moved);
    return true;
  }
  return false;
}

function hoistDefs(pass: Pass): boolean {
  let moved = false;
  for (let moves = 0; hoistOnce(pass); moves++) {
    if (moves >= MAX_MOVES)
      throw new CodegenError(
        "schemas",
        "internal",
        `fix moved more than ${String(MAX_MOVES)} schemas in one pass`,
      );
    moved = true;
  }
  return moved;
}

// The loop

/** The `$id` base the generator would use: given, or taken from the first schema by name. */
function baseOf(
  trees: ReadonlyMap<string, JValue>,
  idBase: string | undefined,
): string | undefined {
  if (idBase !== undefined) return idBase;
  const [first] = [...trees.keys()].sort(compare);
  const root = first === undefined ? undefined : trees.get(first);
  const id = isMap(root) ? root.get("$id") : undefined;
  const tail = `${first ?? ""}.json`;
  return typeof id === "string" && id.endsWith(tail) ? id.slice(0, -tail.length) : undefined;
}

/**
 * Runs every rule over the schema trees until a pass changes nothing, and returns the trees, the
 * notes of that last pass and the number of passes. Throws when the rules don't settle.
 */
export function fixTrees(
  input: ReadonlyMap<string, JValue>,
  idBase?: string,
  maxPasses: number = MAX_PASSES,
): { trees: Map<string, JValue>; notes: FixNote[]; passes: number } {
  const trees = new Map(input);
  const base = baseOf(trees, idBase);
  const names = [...trees.keys()].sort(compare);
  for (let passes = 1; passes <= maxPasses; passes++) {
    const pass: Pass = { trees, base, notes: [], bases: basesOf(trees, base) };
    let changed = false;
    for (const name of names) {
      const tree = trees.get(name) ?? null;
      const next = mapSchemas(tree, [], ROOT, (node, path, place) => {
        let current = mergeAllOf(pass, name, node, path);
        current = tagUnion(pass, name, current, path);
        return closeObject(pass, name, current, path, place);
      });
      if (next !== tree) {
        trees.set(name, next);
        changed = true;
      }
    }
    if (hoistDefs(pass)) changed = true;
    if (!changed) return { trees, notes: pass.notes, passes };
  }
  throw new CodegenError(
    "schemas",
    "internal",
    `strictgen fix did not settle after ${String(maxPasses)} passes, a rule keeps undoing another`,
  );
}

/**
 * Fixes a set of schema files in memory: parses each, runs the rules until nothing changes,
 * writes each changed file back in its own formatting, reads it again to check it says what the rules
 * meant, then generates every target from the result. Throws a {@link CodegenError} for a file
 * that isn't valid JSON. Generation errors are returned as {@link FixResult.problem}.
 */
export function fixSchemas(inputs: readonly FixInput[], options: FixOptions): FixResult {
  const sorted = [...inputs].sort((a, b) => compare(a.name, b.name));
  const trees = new Map<string, JValue>();
  for (const { name, text } of sorted) {
    try {
      trees.set(name, parseJson(text));
    } catch (error) {
      if (!(error instanceof JsonSyntaxError)) throw error;
      throw new CodegenError(`${name}.json`, "invalid-json", `not valid JSON: ${error.message}`);
    }
  }
  const { trees: fixed, notes, passes } = fixTrees(trees, options.idBase, options.maxPasses);
  const files = sorted.map(({ name, text }): FixedFile => {
    const tree = fixed.get(name) ?? null;
    if (tree === trees.get(name)) return { file: `${name}.json`, before: text, after: text };
    const after = render(tree, styleOf(text));
    let again: JValue | undefined;
    try {
      again = parseJson(after);
    } catch {
      again = undefined;
    }
    if (again === undefined || !identical(again, tree))
      throw new CodegenError(
        `${name}.json`,
        "internal",
        "the rewritten schema doesn't read back the same",
      );
    return { file: `${name}.json`, before: text, after };
  });
  let problem: CodegenError | undefined;
  try {
    const parsed: Record<string, JsonObject> = {};
    for (const { file, after } of files) {
      const value = JSON.parse(after) as Json;
      if (!isObject(value))
        throw new CodegenError(file, "invalid-schema", "schema is not an object");
      parsed[file.slice(0, -".json".length)] = value;
    }
    const set = schemaSet(parsed, options.idBase === undefined ? {} : { idBase: options.idBase });
    generate(set, options.targets, {
      ...(options.ids === undefined ? {} : { ids: options.ids }),
      ...(options.validation === undefined ? {} : { validation: options.validation }),
    });
  } catch (error) {
    if (!(error instanceof CodegenError)) throw error;
    problem = error;
  }
  return { files, notes, passes, problem };
}
