/**
 * Projects a model type into the schema an LLM provider accepts for structured output, by the
 * rules of one profile. docs/llm.md describes the same rules for users:
 *
 * - every object is closed and lists every property as required. An optional field becomes
 *   required and nullable, as `anyOf: [<type>, { "type": "null" }]`
 * - a tagged union becomes `anyOf` of its branches, each with its tag as a `const` (or a one
 *   value `enum` where the profile has no `const`). An untagged union becomes `anyOf` too
 * - a type that isn't an object at the root is wrapped as `{ "value": <type> }`, since providers
 *   want an object there
 * - a map becomes an array of `{ key, value }` entries, or an object with an
 *   `additionalProperties` schema, as the profile says
 * - a constraint the profile doesn't accept is left out, and a short hint is added to the
 *   description instead, like "At most 80 characters."
 * - every other type is inlined, so a description never sits beside a `$ref`. Only a recursive
 *   type goes to `$defs`, when the profile accepts recursion
 *
 * Every change is listed, with its place in the projected schema, so a decoder can map the
 * model's output back to the real type and check what the schema couldn't say.
 */
import { numberText } from "./errors.js";
import type { Profile, ProfileKeyword } from "./llm-profile.js";
import { BOUNDED_KEYWORDS } from "./llm-profile.js";
import type {
  ArrayType,
  Decl,
  IntegerType,
  MapType,
  Model,
  NumberType,
  StringType,
  StructDecl,
  TypeExpr,
  UntaggedDecl,
} from "./model.js";
import type { Json, JsonObject, SchemaSet } from "./schema.js";
import { CodegenError, isObject } from "./schema.js";

/** The key a type that isn't an object is wrapped in at the root. */
export const WRAP_KEY = "value";

/**
 * What a projection changed, so the decoder has to make up for it:
 *
 * - `nullable`: an optional field is required and nullable. `null` decodes as absent
 * - `dropped`: a constraint the profile doesn't accept was left out. `keyword` and `value` say
 *   which, and the decoder checks it
 * - `entries`: a map is an array of `{ key, value }` entries. A key given twice fails. The map's
 *   `minProperties` and `maxProperties` become the array's `minItems` and `maxItems` (or a
 *   `dropped` change with those keywords), and they count keys: after a duplicate key fails,
 *   entries and keys are the same number
 * - `wrapped`: the root type is the `value` key of an object
 * - `union`: a tagged union is `anyOf` of its branches. `tag` names the tag key and `branches`
 *   the type each tag value decodes as
 */
export type LlmChangeKind = "nullable" | "dropped" | "entries" | "wrapped" | "union";

/** One change a projection made. */
export interface LlmChange {
  readonly kind: LlmChangeKind;
  /** Where it is in the projected schema, as a JSON Pointer. */
  readonly pointer: string;
  /** The model type the changed schema belongs to. */
  readonly type: string;
  /** The property, for a change to one field. */
  readonly field?: string;
  /** For `dropped`: the keyword left out, and its value. */
  readonly keyword?: string;
  readonly value?: Json;
  /** For `union`: the tag key, and the type each tag value decodes as. */
  readonly tag?: string;
  readonly branches?: Readonly<Record<string, string>>;
  /** One line for people, like `maxLength 80: at most 80 characters`. */
  readonly text: string;
}

/** A type's provider-ready schema and what moved to the decoder. */
export interface Projection {
  readonly type: string;
  readonly profile: string;
  readonly schema: JsonObject;
  readonly changes: readonly LlmChange[];
}

type Node = Record<string, Json>;

/** Escapes one JSON Pointer segment. */
function segment(s: string | number): string {
  return `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The description of a schema: the doc as a sentence, then the hints as one sentence. */
export function describe(doc: string, hints: readonly string[]): string {
  const parts: string[] = [];
  const text = doc.trim();
  if (text !== "") parts.push(/[.!?]$/.test(text) ? text : `${text}.`);
  if (hints.length > 0) {
    const sentence = hints.join(", ");
    parts.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  return parts.join(" ");
}

const FORMAT_HINTS: Readonly<Record<string, string>> = {
  "date-time": "an RFC 3339 date and time, like 2026-01-31T09:30:00Z",
  date: "an RFC 3339 date, like 2026-01-31",
  uuid: "a UUID, like 123e4567-e89b-12d3-a456-426614174000",
};

/** Where in the model a schema node comes from. */
interface Owner {
  readonly type: string;
  readonly field?: string;
}

/** The decls each decl names directly. */
function refsOf(decl: Decl): string[] {
  const out: string[] = [];
  const walk = (t: TypeExpr): void => {
    switch (t.kind) {
      case "ref":
        out.push(t.name);
        break;
      case "array":
        walk(t.items);
        break;
      case "map":
        walk(t.key);
        walk(t.value);
        break;
      default:
        break;
    }
  };
  switch (decl.kind) {
    case "struct":
      for (const f of decl.fields) walk(f.type);
      if (decl.rest !== undefined) {
        walk(decl.rest.key);
        walk(decl.rest.value);
      }
      break;
    case "tagged":
      for (const v of decl.variants) out.push(v.type);
      break;
    case "untagged":
      for (const v of decl.variants) walk(v.type);
      break;
    case "alias":
    case "id":
      walk(decl.type);
      break;
    case "enum":
      break;
  }
  return out;
}

/** The decls that contain themselves, through any chain of references. */
function recursiveDecls(model: Model): Set<string> {
  const edges = new Map(model.decls.map((d) => [d.name, refsOf(d)]));
  const out = new Set<string>();
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() ?? "";
      if (next === start) {
        out.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
  }
  return out;
}

class Projector {
  readonly decls: ReadonlyMap<string, Decl>;
  readonly recursive: ReadonlySet<string>;
  readonly defs = new Map<string, Node>();
  readonly changes: LlmChange[] = [];

  constructor(
    model: Model,
    readonly profile: Profile,
    readonly schemas: SchemaSet,
  ) {
    this.decls = new Map(model.decls.map((d) => [d.name, d]));
    this.recursive = recursiveDecls(model);
  }

  /**
   * The schema path of a field, like `event.json#/properties/payload`, when the schemas hold it
   * there, or else the path of the type that owns it.
   */
  fieldPath(owner: Owner): string {
    const path = this.decls.get(owner.type)?.path ?? owner.type;
    if (owner.field === undefined) return path;
    const hash = path.indexOf("#");
    const file = path.slice(0, hash).replace(/\.json$/, "");
    const pointer = `${path.slice(hash + 1)}/properties${segment(owner.field)}`;
    const root = this.schemas.find((s) => s.name === file)?.root;
    return root !== undefined && pointed(root, pointer) ? `${path}/properties${segment(owner.field)}` : path;
  }

  unsupported(path: string, reason: string, hint?: string): never {
    throw new CodegenError(path, "llm-unsupported", `profile ${this.profile.name}: ${reason}`, hint);
  }

  /** True when the profile keeps `keyword` with `value` in the schema. */
  keeps(keyword: ProfileKeyword, value?: number): boolean {
    if (!this.profile.keywords.has(keyword)) return false;
    const bounded = (BOUNDED_KEYWORDS as readonly string[]).includes(keyword);
    const most = bounded ? this.profile.keywordMaximums[keyword as (typeof BOUNDED_KEYWORDS)[number]] : undefined;
    return most === undefined || value === undefined || value <= most;
  }

  /**
   * Puts a constraint in `node` when the profile keeps it, or adds its hint to `hints` and lists
   * it as dropped.
   */
  constrain(
    node: Node,
    hints: string[],
    pointer: string,
    owner: Owner,
    keyword: ProfileKeyword,
    value: Json,
    hint: string,
    keep: boolean = this.keeps(keyword, typeof value === "number" ? value : undefined),
  ): void {
    if (keep) {
      node[keyword] = value;
      return;
    }
    hints.push(hint);
    this.changes.push({
      kind: "dropped",
      pointer,
      ...owner,
      keyword,
      value,
      text: `${keyword} ${typeof value === "string" ? value : JSON.stringify(value)}: ${hint}`,
    });
  }

  decl(decl: Decl, pointer: string, doc: string, field?: string): Node {
    const text = doc === "" ? decl.doc : doc;
    const owner: Owner = { type: decl.name, ...(field === undefined ? {} : { field }) };
    switch (decl.kind) {
      case "struct":
        return this.struct(decl, pointer, text);
      case "enum": {
        if (decl.values.length === 1 && this.profile.keywords.has("const")) {
          return withDescription({ type: "string", const: decl.values[0] ?? "" }, text, []);
        }
        return withDescription({ type: "string", enum: [...decl.values] }, text, []);
      }
      case "tagged": {
        const branches: Record<string, string> = {};
        const anyOf = decl.variants.map((v, i) => {
          branches[v.value] = v.type;
          return this.expr({ kind: "ref", name: v.type }, `${pointer}/anyOf/${String(i)}`, owner, "");
        });
        this.changes.push({
          kind: "union",
          pointer,
          ...owner,
          tag: decl.tag,
          branches,
          text: `a tagged union on ${JSON.stringify(decl.tag)}, as anyOf of its ${plural(decl.variants.length, "branch", "branches")}`,
        });
        return withDescription({ anyOf }, text, []);
      }
      case "untagged": {
        if (this.profile.maps === "entries") this.entriesBesideArray(decl);
        const anyOf = decl.variants.map((v, i) => this.expr(v.type, `${pointer}/anyOf/${String(i)}`, owner, ""));
        return withDescription({ anyOf }, text, []);
      }
      case "alias":
      case "id":
        return this.expr(decl.type, pointer, owner, text);
    }
  }

  /**
   * Fails for an untagged union with a map beside an array, for a profile that gives maps as
   * arrays of entries: both are JSON arrays then, so the decoder, which tries the variants in
   * order, could read the entries of a map as the array, like an empty map as an empty array.
   */
  entriesBesideArray(decl: UntaggedDecl): void {
    const shapes = decl.variants.map((v) => this.arrayShapes(v.type, new Set()));
    const map = shapes.findIndex((s) => s.has("map"));
    const list = shapes.findIndex((s, i) => s.has("list") && i !== map);
    if (map === -1 || list === -1) return;
    this.unsupported(
      decl.path,
      `${decl.name} has a map beside an array, and the profile gives a map as an array of entries, ` +
        "so a decoder couldn't tell them apart",
      "give the branches a tag, or use a profile that keeps maps as objects",
    );
  }

  /** The kinds of JSON array a type's value can be in the projection: a list, a map's entries, or both. */
  arrayShapes(type: TypeExpr, seen: Set<string>): Set<"map" | "list"> {
    if (type.kind === "array") return new Set(["list"]);
    if (type.kind === "map") return new Set(["map"]);
    if (type.kind !== "ref" || seen.has(type.name)) return new Set();
    seen.add(type.name);
    const decl = this.decls.get(type.name);
    if (decl?.kind === "alias") return this.arrayShapes(decl.type, seen);
    if (decl?.kind !== "untagged") return new Set();
    return new Set(decl.variants.flatMap((v) => [...this.arrayShapes(v.type, seen)]));
  }

  struct(decl: StructDecl, pointer: string, doc: string): Node {
    if (decl.rest !== undefined) {
      this.unsupported(
        decl.path,
        `${decl.name} has keys that are data beside its properties, which a closed object can't describe`,
        "move the extra keys into a map property of their own",
      );
    }
    const properties: Node = {};
    for (const f of decl.fields) {
      const at = `${pointer}/properties${segment(f.name)}`;
      const owner: Owner = { type: decl.name, field: f.name };
      if (f.required) {
        properties[f.name] = this.expr(f.type, at, owner, f.doc);
        continue;
      }
      if (this.isUnion(f.type)) {
        // A union's branches are never null, so null is one more branch, not a nested anyOf.
        const union = this.expr(f.type, at, owner, f.doc);
        const branches = Array.isArray(union.anyOf) ? union.anyOf : [];
        properties[f.name] = { ...union, anyOf: [...branches, { type: "null" }] };
      } else {
        const { description, ...inner } = this.expr(f.type, `${at}/anyOf/0`, owner, f.doc);
        properties[f.name] = {
          ...(description === undefined ? {} : { description }),
          anyOf: [inner, { type: "null" }],
        };
      }
      this.changes.push({
        kind: "nullable",
        pointer: at,
        ...owner,
        text: "optional, so required and nullable: null stands for absent",
      });
    }
    return withDescription(
      {
        type: "object",
        properties,
        required: decl.fields.map((f) => f.name),
        additionalProperties: false,
      },
      doc,
      [],
    );
  }

  /** True when `type` projects as an inline anyOf: a tagged or untagged union, through aliases. */
  isUnion(type: TypeExpr): boolean {
    if (type.kind !== "ref" || this.recursive.has(type.name)) return false;
    const decl = this.decls.get(type.name);
    if (decl === undefined) return false;
    if (decl.kind === "tagged" || decl.kind === "untagged") return true;
    return decl.kind === "alias" && this.isUnion(decl.type);
  }

  expr(type: TypeExpr, pointer: string, owner: Owner, doc: string): Node {
    switch (type.kind) {
      case "ref": {
        const target = this.decls.get(type.name);
        if (target === undefined) throw new Error(`no type ${type.name}`);
        if (!this.recursive.has(target.name)) return this.decl(target, pointer, doc, owner.field);
        if (!this.profile.recursion) {
          this.unsupported(
            target.path,
            `${target.name} contains itself, and the profile accepts no recursive schema`,
          );
        }
        if (!this.defs.has(target.name)) {
          this.defs.set(target.name, {});
          this.defs.set(target.name, this.decl(target, `/$defs${segment(target.name)}`, ""));
        }
        // A description can't sit beside a $ref, so the field's doc is only kept where the $ref
        // goes into an anyOf, for an optional field. stripRefDescriptions removes it elsewhere.
        return withDescription({ $ref: `#/$defs/${target.name.replaceAll("~", "~0").replaceAll("/", "~1")}` }, doc, []);
      }
      case "string":
        return this.string(type, pointer, owner, doc);
      case "integer":
      case "number":
        return this.number(type, pointer, owner, doc);
      case "boolean":
        return withDescription({ type: "boolean" }, doc, []);
      case "literal": {
        const kind = typeof type.value === "boolean" ? "boolean" : "integer";
        if (this.profile.keywords.has("const")) {
          return withDescription({ type: kind, const: type.value }, doc, []);
        }
        return withDescription({ type: kind, enum: [type.value] }, doc, []);
      }
      case "any":
      case "nonNull":
        return this.unsupported(
          this.fieldPath(owner),
          `${owner.field === undefined ? owner.type : `${owner.type}.${owner.field}`} takes any JSON value, which no structured output schema describes`,
          "give it a type",
        );
      case "array":
        return this.array(type, pointer, owner, doc);
      case "map":
        return this.map(type, pointer, owner, doc);
    }
  }

  string(type: StringType, pointer: string, owner: Owner, doc: string): Node {
    const node: Node = { type: "string" };
    const hints: string[] = [];
    const c = (keyword: ProfileKeyword, value: Json, hint: string, keep?: boolean): void => {
      this.constrain(node, hints, pointer, owner, keyword, value, hint, keep);
    };
    if (type.minLength !== undefined) {
      c("minLength", type.minLength, `at least ${plural(type.minLength, "character", "characters")}`);
    }
    if (type.maxLength !== undefined) {
      c("maxLength", type.maxLength, `at most ${plural(type.maxLength, "character", "characters")}`);
    }
    if (type.match !== undefined) {
      c("pattern", type.match.source, `matching the regular expression ${type.match.source}`);
    }
    if (type.format !== undefined) {
      const keep = this.keeps("format") && this.profile.formats.has(type.format);
      c("format", type.format, FORMAT_HINTS[type.format] ?? type.format, keep);
    }
    return withDescription(node, doc, hints);
  }

  number(type: IntegerType | NumberType, pointer: string, owner: Owner, doc: string): Node {
    const node: Node = { type: type.kind };
    const hints: string[] = [];
    const c = (keyword: ProfileKeyword, value: number | undefined, hint: string): void => {
      if (value !== undefined) this.constrain(node, hints, pointer, owner, keyword, value, `${hint} ${numberText(value)}`);
    };
    c("minimum", type.minimum, "at least");
    c("exclusiveMinimum", type.exclusiveMinimum, "greater than");
    c("maximum", type.maximum, "at most");
    c("exclusiveMaximum", type.exclusiveMaximum, "less than");
    if (type.kind === "integer") c("multipleOf", type.multipleOf, "a multiple of");
    return withDescription(node, doc, hints);
  }

  array(type: ArrayType, pointer: string, owner: Owner, doc: string): Node {
    const node: Node = { type: "array", items: this.expr(type.items, `${pointer}/items`, owner, "") };
    const hints: string[] = [];
    if (type.minItems !== undefined) {
      this.constrain(node, hints, pointer, owner, "minItems", type.minItems, `at least ${plural(type.minItems, "item", "items")}`);
    }
    if (type.maxItems !== undefined) {
      this.constrain(node, hints, pointer, owner, "maxItems", type.maxItems, `at most ${plural(type.maxItems, "item", "items")}`);
    }
    if (type.uniqueItems === true) {
      this.constrain(node, hints, pointer, owner, "uniqueItems", true, "no two items equal");
    }
    return withDescription(node, doc, hints);
  }

  map(type: MapType, pointer: string, owner: Owner, doc: string): Node {
    const hints: string[] = [];
    if (this.profile.maps === "object") {
      const node: Node = { type: "object" };
      const key = this.expr(type.key, `${pointer}/propertyNames`, owner, "");
      if (!isPlainString(key)) {
        if (this.profile.keywords.has("propertyNames")) node.propertyNames = key;
        else {
          const hint = `each key ${keyHint(key)}`;
          hints.push(hint);
          this.changes.push({
            kind: "dropped",
            pointer,
            ...owner,
            keyword: "propertyNames",
            value: key,
            text: `propertyNames: ${hint}`,
          });
        }
      }
      node.additionalProperties = this.expr(type.value, `${pointer}/additionalProperties`, owner, "");
      if (type.minProperties !== undefined) {
        this.constrain(node, hints, pointer, owner, "minProperties", type.minProperties, `at least ${plural(type.minProperties, "key", "keys")}`);
      }
      if (type.maxProperties !== undefined) {
        this.constrain(node, hints, pointer, owner, "maxProperties", type.maxProperties, `at most ${plural(type.maxProperties, "key", "keys")}`);
      }
      return withDescription(node, doc, hints);
    }
    const entry: Node = {
      type: "object",
      properties: {
        key: this.expr(type.key, `${pointer}/items/properties/key`, owner, ""),
        value: this.expr(type.value, `${pointer}/items/properties/value`, owner, ""),
      },
      required: ["key", "value"],
      additionalProperties: false,
    };
    const node: Node = { type: "array", items: entry };
    hints.push("each key at most once");
    this.changes.push({
      kind: "entries",
      pointer,
      ...owner,
      text: "a map, as an array of { key, value } entries: a key given twice fails",
    });
    // The entries are as many as the keys, so the key limits are item limits.
    if (type.minProperties !== undefined) {
      this.constrain(node, hints, pointer, owner, "minItems", type.minProperties, `at least ${plural(type.minProperties, "entry", "entries")}`);
    }
    if (type.maxProperties !== undefined) {
      this.constrain(node, hints, pointer, owner, "maxItems", type.maxProperties, `at most ${plural(type.maxProperties, "entry", "entries")}`);
    }
    return withDescription(node, doc, hints);
  }
}

function isPlainString(node: Node): boolean {
  return Object.keys(node).every((k) => k === "type" || k === "description") && node.type === "string";
}

/** A map key's schema in words, for a profile that can't take it as propertyNames. */
function keyHint(key: Node): string {
  if (Array.isArray(key.enum)) return `one of ${key.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (key.const !== undefined) return `exactly ${JSON.stringify(key.const)}`;
  const description = typeof key.description === "string" ? key.description : "";
  return `as described: ${description === "" ? JSON.stringify(key) : description}`;
}

/** True when `pointer` names a value in `root`. */
function pointed(root: Json, pointer: string): boolean {
  let current: Json | undefined = root;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !Object.hasOwn(current, key)) return false;
    current = current[key];
  }
  return current !== undefined;
}

/** `node` without a description beside a `$ref`, anywhere in it, which providers may refuse. */
function stripRefDescriptions(node: Json): Json {
  if (Array.isArray(node)) return node.map(stripRefDescriptions);
  if (!isObject(node)) return node;
  const out: Node = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && node.$ref !== undefined) continue;
    out[key] = stripRefDescriptions(value);
  }
  return out;
}

/** `node` with its description first, when there is one. */
function withDescription(node: Node, doc: string, hints: readonly string[]): Node {
  const description = describe(doc, hints);
  return description === "" ? node : { description, ...node };
}

/** The sizes a profile limits, measured on a projected schema. */
interface Measure {
  depth: number;
  deepest: string;
  properties: number;
  enumValues: number;
  stringSize: number;
  unions: number;
  /** The largest string enum over the large enum count, by its size. */
  largeEnum: { size: number; pointer: string } | undefined;
  /** The first `$ref` that goes back into a type it is inside, when there is one. */
  recursive: string | undefined;
}

function length(text: string): number {
  return [...text].length;
}

/**
 * Measures a projected schema the way a provider meets it: each `$ref` is followed to its
 * `$defs` entry at the place it is used, so a definition counts at the depth of each use, and its
 * properties, enum values and anyOf schemas count once per use. A `$ref` back into a definition
 * it is inside isn't followed again; `recursive` names the first one.
 */
function measure(schema: JsonObject, largeEnumValues: number | undefined): Measure {
  const m: Measure = {
    depth: 0,
    deepest: "",
    properties: 0,
    enumValues: 0,
    stringSize: 0,
    unions: 0,
    largeEnum: undefined,
    recursive: undefined,
  };
  const { $defs, ...root } = schema;
  const defs: JsonObject = isObject($defs) ? $defs : {};
  // A definition's name is written once, however often it is used.
  for (const name of Object.keys(defs)) m.stringSize += length(name);
  const walk = (node: Json | undefined, pointer: string, depth: number, open: readonly string[]): void => {
    if (!isObject(node)) return;
    if (typeof node.$ref === "string") {
      const name = node.$ref.slice("#/$defs/".length).replaceAll("~1", "/").replaceAll("~0", "~");
      if (open.includes(name)) {
        m.recursive ??= pointer;
        return;
      }
      walk(defs[name], `/$defs${segment(name)}`, depth, [...open, name]);
      return;
    }
    const nested = node.type === "object" || node.type === "array" ? depth + 1 : depth;
    if (nested > m.depth) {
      m.depth = nested;
      m.deepest = pointer;
    }
    if (Array.isArray(node.anyOf)) {
      m.unions++;
      node.anyOf.forEach((b, i) => {
        walk(b, `${pointer}/anyOf/${String(i)}`, nested, open);
      });
    }
    if (Array.isArray(node.enum)) {
      m.enumValues += node.enum.length;
      const strings = node.enum.filter((v): v is string => typeof v === "string");
      const size = strings.reduce((n, v) => n + length(v), 0);
      m.stringSize += size;
      if (largeEnumValues !== undefined && strings.length > largeEnumValues && size > (m.largeEnum?.size ?? -1)) {
        m.largeEnum = { size, pointer };
      }
    }
    if (typeof node.const === "string") m.stringSize += length(node.const);
    if (isObject(node.properties)) {
      for (const [name, value] of Object.entries(node.properties)) {
        m.properties++;
        m.stringSize += length(name);
        walk(value, `${pointer}/properties${segment(name)}`, nested, open);
      }
    }
    for (const key of ["items", "additionalProperties", "propertyNames"]) {
      walk(node[key], `${pointer}/${key}`, nested, open);
    }
  };
  walk(root, "", 0, []);
  return m;
}

/** Fails when the projected schema is over one of the profile's limits. */
function checkLimits(schema: JsonObject, decl: Decl, profile: Profile): void {
  const { limits } = profile;
  const m = measure(schema, limits.largeEnum?.values);
  const over = (what: string, found: number, most: number, at?: string): never => {
    throw new CodegenError(
      decl.path,
      "llm-limit",
      `the ${profile.name} schema for ${decl.name} has ${what} ${String(found)}` +
        `${at === undefined ? "" : `, at ${at === "" ? "the root" : at}`}, and the profile allows at most ${String(most)}`,
      "split the type into smaller ones, or use a profile with higher limits",
    );
  };
  // A type that contains itself nests without bound, and no provider says how it counts the
  // depth of one, so a profile with a depth limit fails it rather than guess.
  if (limits.maxDepth !== undefined && m.recursive !== undefined) {
    throw new CodegenError(
      decl.path,
      "llm-limit",
      `the ${profile.name} schema for ${decl.name} is recursive at ${m.recursive}, so its nesting has no bound, ` +
        `and the profile allows a depth of at most ${String(limits.maxDepth)}`,
      "remove the recursion, or use a profile file without limits.maxDepth if the provider takes the schema",
    );
  }
  if (limits.maxDepth !== undefined && m.depth > limits.maxDepth) {
    over("a nesting depth of", m.depth, limits.maxDepth, m.deepest);
  }
  if (limits.maxProperties !== undefined && m.properties > limits.maxProperties) {
    over("a property count of", m.properties, limits.maxProperties);
  }
  if (limits.maxEnumValues !== undefined && m.enumValues > limits.maxEnumValues) {
    over("an enum value count of", m.enumValues, limits.maxEnumValues);
  }
  if (limits.maxStringSize !== undefined && m.stringSize > limits.maxStringSize) {
    over("names and values of a total length of", m.stringSize, limits.maxStringSize);
  }
  if (limits.maxUnions !== undefined && m.unions > limits.maxUnions) {
    over("an anyOf count of", m.unions, limits.maxUnions);
  }
  if (limits.largeEnum !== undefined && m.largeEnum !== undefined && m.largeEnum.size > limits.largeEnum.maxSize) {
    over(
      `an enum of more than ${String(limits.largeEnum.values)} values with a total length of`,
      m.largeEnum.size,
      limits.largeEnum.maxSize,
      m.largeEnum.pointer,
    );
  }
}

/** The types a projection is written for: schema roots and `$defs` entries, sorted by name. */
export function projectedTypes(model: Model): Decl[] {
  return model.decls.filter((d) => d.source !== undefined);
}

/**
 * The provider-ready schema of the model type `name` for `profile`, and what moved to the
 * decoder. Throws a {@link CodegenError} naming the schema path when the type uses something no
 * structured output schema describes (`llm-unsupported`) or the projection is over a limit of the
 * profile (`llm-limit`). `schemas`, the set the model was built from, lets errors point at a
 * field's own place in its schema.
 */
export function projectType(
  model: Model,
  name: string,
  profile: Profile,
  schemas: SchemaSet = [],
): Projection {
  const decl = model.decls.find((d) => d.name === name);
  if (decl === undefined) throw new Error(`no type ${name}`);
  const p = new Projector(model, profile, schemas);
  let root: Node;
  if (decl.kind === "struct") {
    root = p.decl(decl, "", "");
  } else {
    root = {
      type: "object",
      properties: { [WRAP_KEY]: p.decl(decl, `/properties/${WRAP_KEY}`, "") },
      required: [WRAP_KEY],
      additionalProperties: false,
    };
    p.changes.unshift({
      kind: "wrapped",
      pointer: "",
      type: decl.name,
      text: `not an object, so wrapped as { "${WRAP_KEY}": ... }: the decoder reads the ${WRAP_KEY} key`,
    });
  }
  const defs = [...p.defs.keys()].sort();
  const written: Node =
    defs.length === 0
      ? root
      : { ...root, $defs: Object.fromEntries(defs.map((n) => [n, p.defs.get(n) ?? {}])) };
  const schema = stripRefDescriptions(written) as JsonObject;
  checkLimits(schema, decl, profile);
  const changes = [...p.changes].sort((a, b) => (a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0));
  return { type: decl.name, profile: profile.name, schema, changes };
}

/**
 * A projected schema as file contents: two space indent, keys in projection order, every
 * character past ASCII as a \u escape, and a final newline. So the files are the same bytes on
 * every machine and hold no character that is hard to see.
 */
export function schemaText(schema: JsonObject): string {
  const text = JSON.stringify(schema, null, 2);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out += unit < 0x7f ? text.charAt(i) : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return `${out}\n`;
}

/** The lines `strictgen llm` prints after the schema: what moved to the decoder. */
export function changeLines(projection: Projection): string[] {
  if (projection.changes.length === 0) return ["Nothing moved to the decoder."];
  return [
    "Moved to the decoder:",
    ...projection.changes.map((c) => `  ${c.pointer === "" ? "(root)" : c.pointer}: ${c.text}`),
  ];
}
