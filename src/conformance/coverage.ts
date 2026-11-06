/**
 * Which mapping rules and error codes the conformance cases cover. Every rule needs a valid case
 * and an invalid one, and every error code an invalid case, or the run fails, so a rule can't
 * lose its last case unnoticed.
 *
 * The rules are the constructs of the model (src/model.ts) and the constraints of spec section 8,
 * each with a stable id. Which ones a case covers is worked out from the case, never written by
 * hand, so it can't drift:
 *
 * - A valid case covers every rule its value goes through, read along the model the way the
 *   decoders read it: each type, each declaration and each constraint a value is checked against
 * - An invalid case covers the rules its expected error is about: the construct at the error's
 *   path, by the code. `too_long` at a string is `string.maxLength`, at an array
 *   `array.maxItems`; `too_small` is `minimum` or `exclusiveMinimum` by which bound the value
 *   breaks; an unknown key in a struct whose sibling branch names it is `object.exactly-one`. The
 *   declarations the failing value is read through (an alias, an id, a map key) count too
 *
 * A side of a rule no case can have, like an invalid value for `any`, is listed in the
 * manifest's `coverage` section with the reason, and that must stay true too.
 */

import { ERROR_CODES } from "../errors.js";
import type { Decl, IntegerType, NumberType, StructDecl, TypeExpr, UntaggedVariant } from "../model.js";
import type { Model } from "../model.js";
import type { Json } from "./canonical.js";
import { CanonicalError, JsonNumber, parseJson, pointerSegments } from "./canonical.js";
import type { Case } from "./cases.js";
import { ModelWalk } from "./walk.js";

/** One mapping rule: its stable id and what it is. */
export interface Rule {
  readonly id: string;
  readonly text: string;
}

/** Every mapping rule, in the order the report lists them. Ids are stable: a case's coverage names them. */
export const RULES: readonly Rule[] = [
  { id: "object", text: "a closed object with named properties: unknown keys rejected, or reported in report mode" },
  { id: "object.required", text: "a required property, which must be present" },
  { id: "object.optional", text: "an optional property, absent or present but never null" },
  { id: "object.exactly-one", text: "an object whose exactly-one oneOf forbids the keys of the sibling branches" },
  { id: "object.rest", text: "an object with properties and extra keys that are data, like a map" },
  { id: "object.recursive", text: "a property that closes a containment cycle, boxed in Rust" },
  { id: "tagged", text: "a oneOf whose branches share a string const tag: the tag picks the branch" },
  { id: "tagged.recursive", text: "a tagged union branch that closes a containment cycle, boxed in Rust" },
  { id: "untagged", text: "a oneOf without a tag: the branches are tried in a fixed order" },
  { id: "untagged.recursive", text: "an untagged union branch that closes a containment cycle, boxed in Rust" },
  { id: "enum", text: "a string enum: only the listed values" },
  { id: "const.string", text: "a string const, an enum of one value" },
  { id: "const.integer", text: "an integer const" },
  { id: "const.boolean", text: "a boolean const" },
  { id: "id", text: "an id: a string type of its own, so ids of different kinds don't mix" },
  { id: "alias", text: "a def that is another type: a $ref, a primitive with rules, an array or a map" },
  { id: "string", text: "a string" },
  { id: "integer", text: "an integer: no fraction, no exponent, no -0" },
  { id: "integer.int64", text: "an integer beyond 2^53 - 1, which Rust and Go hold and TypeScript refuses" },
  { id: "number", text: "a number, compared as the nearest 64-bit float" },
  { id: "boolean", text: "a boolean" },
  { id: "any", text: "any JSON value, null included" },
  { id: "non-null", text: "any JSON value but null" },
  { id: "array", text: "an array of one item type" },
  { id: "map", text: "an object used as a map of one value type" },
  { id: "map.key", text: "a map whose keys have a type of their own: an enum, a pattern or a length" },
  { id: "string.minLength", text: "minLength, in code points" },
  { id: "string.maxLength", text: "maxLength, in code points" },
  { id: "string.pattern", text: "pattern, in the portable subset" },
  { id: "format.date-time", text: "format date-time, RFC 3339" },
  { id: "format.date", text: "format date, RFC 3339 full-date" },
  { id: "format.uuid", text: "format uuid, RFC 9562 text form" },
  { id: "integer.minimum", text: "minimum on an integer" },
  { id: "integer.exclusiveMinimum", text: "exclusiveMinimum on an integer" },
  { id: "integer.maximum", text: "maximum on an integer" },
  { id: "integer.exclusiveMaximum", text: "exclusiveMaximum on an integer" },
  { id: "integer.multipleOf", text: "multipleOf, integers only" },
  { id: "number.minimum", text: "minimum on a number" },
  { id: "number.exclusiveMinimum", text: "exclusiveMinimum on a number" },
  { id: "number.maximum", text: "maximum on a number" },
  { id: "number.exclusiveMaximum", text: "exclusiveMaximum on a number" },
  { id: "array.minItems", text: "minItems" },
  { id: "array.maxItems", text: "maxItems" },
  { id: "array.uniqueItems", text: "uniqueItems, by canonical JSON" },
  { id: "map.minProperties", text: "minProperties on a map" },
  { id: "map.maxProperties", text: "maxProperties on a map" },
];

/*
 * Every flag and option of a model node an emitter reads has a rule above, or no rule for the
 * reason given here:
 *
 * - Field.required: object.required and object.optional. Field.boxed: object.recursive.
 *   TaggedVariant.boxed and UntaggedVariant.boxed: tagged.recursive and untagged.recursive
 * - StructDecl.forbidden: object.exactly-one. StructDecl.rest: object.rest
 * - StructDecl.closed: no rule. Decoders reject unknown keys unless a struct has `rest`, and
 *   closed is false only beside `rest`, so object and object.rest cover both. Otherwise it only
 *   picks the TypeScript type of a struct without fields
 * - StringType.pattern: no rule. It only gives the TypeScript type text, like `order.${string}`;
 *   StringType.match is what decoders check (string.pattern), and Pattern.source is the text
 *   errors show, compared in every case's error
 * - The constraints of strings, integers, numbers, arrays and maps: one rule each
 * - TaggedDecl.tag: tagged. The order of UntaggedDecl.variants: untagged
 * - doc, path, schema and source of a declaration: no rule. They give comments, file names and
 *   registry names, never what a decoder accepts
 */

const RULE_IDS: ReadonlySet<string> = new Set(RULES.map((r) => r.id));

/** The two sides of a rule a case can cover. */
export type Side = "valid" | "invalid";

/** How many cases cover each side of each rule, and each error code. */
export interface Coverage {
  readonly rules: ReadonlyMap<string, { valid: string[]; invalid: string[] }>;
  readonly codes: ReadonlyMap<string, string[]>;
}

const MAX_SAFE = 9007199254740991n;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

function bigOf(n: JsonNumber): boolean {
  return INTEGER.test(n.raw) && (BigInt(n.raw) > MAX_SAFE || BigInt(n.raw) < -MAX_SAFE);
}

/** The rules of a type's own constraints, which a valid value of it is checked against. */
function constraintRules(type: TypeExpr): string[] {
  switch (type.kind) {
    case "string":
      return [
        ...(type.minLength === undefined ? [] : ["string.minLength"]),
        ...(type.maxLength === undefined ? [] : ["string.maxLength"]),
        ...(type.match === undefined ? [] : ["string.pattern"]),
        ...(type.format === undefined ? [] : [`format.${type.format}`]),
      ];
    case "integer":
    case "number":
      return [
        ...(["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum"] as const).filter((k) => type[k] !== undefined).map((k) => `${type.kind}.${k}`),
        ...(type.kind === "integer" && type.multipleOf !== undefined ? ["integer.multipleOf"] : []),
      ];
    case "array":
      return [
        ...(type.minItems === undefined ? [] : ["array.minItems"]),
        ...(type.maxItems === undefined ? [] : ["array.maxItems"]),
        ...(type.uniqueItems === undefined ? [] : ["array.uniqueItems"]),
      ];
    case "map":
      return [
        ...(type.minProperties === undefined ? [] : ["map.minProperties"]),
        ...(type.maxProperties === undefined ? [] : ["map.maxProperties"]),
      ];
    default:
      return [];
  }
}

/** The rule of a type itself, without its constraints. */
function kindRule(type: TypeExpr | Decl, walk: ModelWalk): string | undefined {
  switch (type.kind) {
    case "ref":
      return kindRule(walk.decl(type.name), walk);
    case "struct":
      return "object";
    case "enum":
      return type.values.length === 1 ? "const.string" : "enum";
    case "literal":
      return typeof type.value === "boolean" ? "const.boolean" : "const.integer";
    case "nonNull":
      return "non-null";
    case "tagged":
    case "untagged":
    case "alias":
    case "id":
    case "string":
    case "integer":
    case "number":
    case "boolean":
    case "any":
    case "array":
    case "map":
      return type.kind;
  }
}

/** True when a map's key type has checks of its own, so a key can fail. */
function keyedMap(type: TypeExpr, walk: ModelWalk): boolean {
  if (type.kind === "ref") {
    const d = walk.decl(type.name);
    if (d.kind === "enum") return true;
    if (d.kind === "alias") return keyedMap(d.type, walk);
    if (d.kind === "id") return constraintRules(d.type).length > 0;
    return false;
  }
  return constraintRules(type).length > 0;
}

/** Collects the rules a valid value goes through. */
class ValidWalk {
  readonly rules = new Set<string>();
  constructor(readonly walk: ModelWalk) {}

  value(type: TypeExpr, json: Json): void {
    const add = (...ids: string[]): void => ids.forEach((id) => this.rules.add(id));
    switch (type.kind) {
      case "ref":
        this.decl(this.walk.decl(type.name), json);
        return;
      case "string":
      case "number":
      case "boolean":
      case "any":
      case "nonNull":
      case "literal":
        add(kindRule(type, this.walk) ?? "", ...constraintRules(type));
        return;
      case "integer":
        add("integer", ...constraintRules(type));
        if (json instanceof JsonNumber && bigOf(json)) add("integer.int64");
        return;
      case "array":
        add("array", ...constraintRules(type));
        if (Array.isArray(json)) for (const item of json) this.value(type.items, item);
        return;
      case "map":
        add("map", ...constraintRules(type));
        if (json instanceof Map) {
          if (keyedMap(type.key, this.walk)) add("map.key");
          for (const [k, v] of json) {
            this.value(type.key, k);
            this.value(type.value, v);
          }
        }
        return;
    }
  }

  decl(decl: Decl, json: Json): void {
    const add = (...ids: string[]): void => ids.forEach((id) => this.rules.add(id));
    switch (decl.kind) {
      case "struct":
        this.struct(decl, json);
        return;
      case "enum":
        add(decl.values.length === 1 ? "const.string" : "enum");
        return;
      case "tagged": {
        add("tagged");
        const tag = json instanceof Map ? json.get(decl.tag) : undefined;
        const variant = decl.variants.find((v) => v.value === tag);
        if (variant?.boxed === true) add("tagged.recursive");
        if (variant !== undefined) this.decl(this.walk.decl(variant.type), json);
        return;
      }
      case "untagged": {
        add("untagged");
        const variant = decl.variants.find((v) => this.walk.fits(v.type, json));
        if (variant?.boxed === true) add("untagged.recursive");
        if (variant !== undefined) this.value(variant.type, json);
        return;
      }
      case "alias":
        add("alias");
        this.value(decl.type, json);
        return;
      case "id":
        add("id");
        this.value(decl.type, json);
        return;
    }
  }

  struct(decl: StructDecl, json: Json): void {
    this.rules.add("object");
    if (!(json instanceof Map)) return;
    if (decl.forbidden.length > 0) this.rules.add("object.exactly-one");
    for (const f of decl.fields) {
      const v = json.get(f.name);
      if (f.required) this.rules.add("object.required");
      else this.rules.add("object.optional");
      if (v === undefined) continue;
      if (f.boxed) this.rules.add("object.recursive");
      this.value(f.type, v);
    }
    if (decl.rest !== undefined) {
      for (const [k, v] of json) {
        if (decl.fields.some((f) => f.name === k)) continue;
        this.rules.add("object.rest");
        this.value(decl.rest.key, k);
        this.value(decl.rest.value, v);
      }
    }
  }
}

/** Where an invalid case's error is: the types its value is read through there, or the key of a struct or map. */
interface Site {
  /** The types and declarations the value at the path is read as, outermost first. */
  readonly chain: (TypeExpr | Decl)[];
  /** The value at the path, when there is one. */
  readonly value: Json | undefined;
  /** The struct whose key the path names, when the path is a key it has or forbids. */
  readonly parent: StructDecl | undefined;
  /** True when the path is a map member and its key type is what failed. */
  readonly key: boolean;
  /** Rules met on the way, like the boxed field of a recursive type or the rest of a struct. */
  readonly via: Set<string>;
}

/**
 * The declarations and types a value is read through at one place, resolving refs, aliases, ids
 * and unions. A boxed union branch it goes through adds its rule to `via`.
 */
function expand(walk: ModelWalk, type: TypeExpr, value: Json | undefined, via: Set<string>): (TypeExpr | Decl)[] {
  const out: (TypeExpr | Decl)[] = [];
  let next: TypeExpr | Decl | undefined = type;
  while (next !== undefined) {
    const t: TypeExpr | Decl = next;
    next = undefined;
    if (t.kind === "ref") {
      next = walk.decl(t.name);
      continue;
    }
    out.push(t);
    if (t.kind === "alias" || t.kind === "id") next = t.type;
    else if (t.kind === "tagged") {
      const tag = value instanceof Map ? value.get(t.tag) : undefined;
      const variant = t.variants.find((v) => v.value === tag);
      if (variant?.boxed === true) via.add("tagged.recursive");
      if (variant !== undefined) next = walk.decl(variant.type);
    } else if (t.kind === "untagged" && value !== undefined) {
      const v = value;
      const variant: UntaggedVariant | undefined = t.variants.find((x) => walk.fits(x.type, v));
      if (variant?.boxed === true) via.add("untagged.recursive");
      next = variant?.type;
    }
  }
  return out;
}

/** Follows an error's path through a case's value along the model. Undefined when the path leaves the model. */
function site(walk: ModelWalk, type: string, root: Json, path: string, code: string): Site | undefined {
  const via = new Set<string>();
  let chain = expand(walk, { kind: "ref", name: type }, root, via);
  let value: Json | undefined = root;
  const segments = pointerSegments(path);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] ?? "";
    const last = i === segments.length - 1;
    const here = chain.at(-1);
    if (here === undefined) return undefined;
    let next: TypeExpr | undefined;
    let nextValue: Json | undefined;
    if (here.kind === "tagged" && s === here.tag && last) {
      // A tag that is missing, of another type, or that no branch has: the union's own error.
      return { chain, value: value instanceof Map ? value.get(s) : undefined, parent: undefined, key: false, via };
    }
    if (here.kind === "struct") {
      const field = here.fields.find((f) => f.name === s);
      nextValue = value instanceof Map ? value.get(s) : undefined;
      if (field !== undefined) {
        if (field.boxed) via.add("object.recursive");
        if (last && (nextValue === undefined || (nextValue === null && code === "null_not_allowed"))) {
          return { chain: field.type.kind === "ref" ? expand(walk, field.type, nextValue, via) : [field.type], value: nextValue, parent: here, key: false, via };
        }
        next = field.type;
      } else if (here.rest !== undefined && !(last && code === "unknown_key")) {
        via.add("object.rest");
        next = here.rest.value;
        if (last && walk.stringViolation(here.rest.key, s) === code) {
          via.add("map.key");
          return { chain: expand(walk, here.rest.key, s, via), value: s, parent: undefined, key: true, via };
        }
      } else {
        return last ? { chain: [], value: nextValue, parent: here, key: false, via } : undefined;
      }
    } else if (here.kind === "array") {
      next = here.items;
      nextValue = Array.isArray(value) ? value[Number(s)] : undefined;
      if (last && code === "not_unique") return { chain, value, parent: undefined, key: false, via };
    } else if (here.kind === "map") {
      next = here.value;
      nextValue = value instanceof Map ? value.get(s) : undefined;
      if (last && walk.stringViolation(here.key, s) === code) {
        via.add("map.key");
        return { chain: expand(walk, here.key, s, via), value: s, parent: undefined, key: true, via };
      }
    } else {
      return undefined;
    }
    value = nextValue;
    chain = expand(walk, next, value, via);
  }
  return { chain, value, parent: undefined, key: false, via };
}

/** The bound rule a number breaks, by its value against each bound. */
function boundRule(type: IntegerType | NumberType, value: Json | undefined, low: boolean): string | undefined {
  const n = value instanceof JsonNumber ? Number(value.raw) : Number.NaN;
  if (low) {
    if (type.minimum !== undefined && n < type.minimum) return `${type.kind}.minimum`;
    if (type.exclusiveMinimum !== undefined) return `${type.kind}.exclusiveMinimum`;
    return type.minimum === undefined ? undefined : `${type.kind}.minimum`;
  }
  if (type.maximum !== undefined && n > type.maximum) return `${type.kind}.maximum`;
  if (type.exclusiveMaximum !== undefined) return `${type.kind}.exclusiveMaximum`;
  return type.maximum === undefined ? undefined : `${type.kind}.maximum`;
}

/** The rules an invalid case's error is about. */
function invalidRules(walk: ModelWalk, c: Case, root: Json): Set<string> {
  const out = new Set<string>();
  if (c.strict.accepted) return out;
  const { path, code } = c.strict;
  const at = site(walk, c.type, root, path, code);
  if (at === undefined) return out;
  for (const r of at.via) out.add(r);
  // The declarations a value that is there is read through; a missing key has no value.
  if (at.value !== undefined) for (const d of at.chain) if (d.kind === "alias" || d.kind === "id") out.add(d.kind);
  const leaf = at.chain.at(-1);
  const union = at.chain.find((d) => d.kind === "untagged" || d.kind === "tagged");
  switch (code) {
    case "unknown_key":
      if (at.parent !== undefined) {
        const key = pointerSegments(path).at(-1) ?? "";
        out.add(at.parent.forbidden.includes(key) ? "object.exactly-one" : "object");
      }
      break;
    case "missing_key": {
      if (leaf?.kind === "tagged") out.add("tagged");
      if (at.parent === undefined) break;
      const key = pointerSegments(path).at(-1) ?? "";
      const tagged = walk.model.decls.some((d) => d.kind === "tagged" && d.tag === key && d.variants.some((v) => v.type === at.parent?.name));
      out.add(tagged ? "tagged" : "object.required");
      break;
    }
    case "null_not_allowed": {
      const key = pointerSegments(path).at(-1) ?? "";
      const field = at.parent?.fields.find((f) => f.name === key);
      if (field !== undefined && !field.required) out.add("object.optional");
      // A value of any type but null fails on null whether the key is optional or not.
      if (leaf?.kind === "nonNull") out.add("non-null");
      else if (field !== undefined && !field.required) break;
      else if (union?.kind === "untagged") out.add("untagged");
      else if (leaf !== undefined) out.add(kindRule(leaf, walk) ?? "");
      break;
    }
    case "wrong_type":
      if (union !== undefined) out.add(union.kind);
      else if (leaf !== undefined) out.add(kindRule(leaf, walk) ?? "");
      // An object with the keys of two branches of an exactly-one union fits no branch, so the
      // union fails: the keys a branch forbids are what failed. Only when the object fits that
      // branch without them, so an object that fails for another reason, like `null` for a
      // branch's key, isn't counted.
      if (union?.kind === "untagged" && at.value instanceof Map) {
        const value = at.value;
        const forbids = union.variants.some((v) => {
          const d = v.type.kind === "ref" ? walk.decl(v.type.name) : undefined;
          if (d?.kind !== "struct" || !d.forbidden.some((k) => value.has(k))) return false;
          const without: Json = new Map([...value].filter(([k]) => !d.forbidden.includes(k)));
          return walk.fits(v.type, without);
        });
        if (forbids) out.add("object.exactly-one");
      }
      break;
    case "bad_tag":
      out.add("tagged");
      break;
    case "not_in_enum":
    case "not_const":
      if (leaf !== undefined) out.add(kindRule(leaf, walk) ?? "");
      break;
    case "too_short":
    case "too_long": {
      const min = code === "too_short";
      if (leaf?.kind === "string") out.add(min ? "string.minLength" : "string.maxLength");
      if (leaf?.kind === "array") out.add(min ? "array.minItems" : "array.maxItems");
      if (leaf?.kind === "map") out.add(min ? "map.minProperties" : "map.maxProperties");
      break;
    }
    case "too_small":
    case "too_large":
      if (leaf?.kind === "integer" || leaf?.kind === "number") {
        const rule = boundRule(leaf, at.value, code === "too_small");
        if (rule !== undefined) out.add(rule);
      }
      break;
    case "not_multiple_of":
      out.add("integer.multipleOf");
      break;
    case "pattern_mismatch":
      out.add("string.pattern");
      break;
    case "bad_format":
      if (leaf?.kind === "string" && leaf.format !== undefined) out.add(`format.${leaf.format}`);
      break;
    case "not_unique":
      out.add("array.uniqueItems");
      break;
    case "out_of_range_integer":
      out.add("integer.int64");
      break;
    default:
      // invalid_json, duplicate_key and too_deep are about the text, not a construct.
      break;
  }
  out.delete("");
  return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parse(c: Case): Json | undefined {
  try {
    return parseJson(UTF8.decode(c.bytes));
  } catch (error) {
    if (error instanceof CanonicalError || error instanceof TypeError) return undefined;
    throw error;
  }
}

/** The rules each case covers, by case id. */
export function caseRules(model: Model, cases: readonly Case[]): Map<string, Set<string>> {
  const walk = new ModelWalk(model);
  const out = new Map<string, Set<string>>();
  for (const c of cases) {
    const root = parse(c);
    if (root === undefined) {
      out.set(c.id, new Set());
      continue;
    }
    if (c.valid) {
      const v = new ValidWalk(walk);
      v.value({ kind: "ref", name: c.type }, root);
      out.set(c.id, v.rules);
    } else {
      out.set(c.id, invalidRules(walk, c, root));
    }
  }
  for (const [id, rules] of out) for (const r of rules) if (!RULE_IDS.has(r)) throw new Error(`${id}: no rule ${r}`);
  return out;
}

/** Which cases cover each side of each rule, and each error code. */
export function coverage(model: Model, cases: readonly Case[]): Coverage {
  const rules = new Map(RULES.map((r) => [r.id, { valid: [] as string[], invalid: [] as string[] }]));
  const codes = new Map(ERROR_CODES.map((c) => [c.code, [] as string[]]));
  for (const [id, covered] of caseRules(model, cases)) {
    const c = cases.find((x) => x.id === id);
    if (c === undefined) continue;
    for (const r of covered) rules.get(r)?.[c.valid ? "valid" : "invalid"].push(id);
  }
  for (const c of cases) {
    for (const outcome of [c.strict, c.report]) {
      if (!outcome.accepted) {
        const list = codes.get(outcome.code);
        if (list !== undefined && !list.includes(c.id)) list.push(c.id);
      }
    }
  }
  return { rules, codes };
}

/**
 * What is missing: each side of a rule and each code without a case, unless `allowed` (the
 * manifest's `coverage`, like `any/invalid`) gives the reason it can't have one. An allowance
 * for a side that has a case, or that names no rule, is a problem too.
 */
export function coverageGaps(report: Coverage, allowed: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const [id, sides] of report.rules) {
    for (const side of ["valid", "invalid"] as const) {
      const key = `${id}/${side}`;
      const n = sides[side].length;
      if (n === 0 && !allowed.has(key)) problems.push(`mapping rule ${id} has no ${side} case`);
      if (n > 0 && allowed.has(key)) problems.push(`manifest.json: coverage ${key} has ${String(n)} cases now, so remove it`);
    }
  }
  for (const key of allowed.keys()) {
    const [id, side] = key.split("/");
    if (id === undefined || !report.rules.has(id) || (side !== "valid" && side !== "invalid")) {
      problems.push(`manifest.json: coverage ${key} is not <rule>/valid or <rule>/invalid`);
    }
  }
  for (const [code, list] of report.codes) if (list.length === 0) problems.push(`error code ${code} has no case`);
  return problems;
}

/** The coverage report as lines: every rule with its case counts, then every code. */
export function coverageLines(report: Coverage, allowed: ReadonlyMap<string, string>): string[] {
  const width = Math.max(...RULES.map((r) => r.id.length), ...ERROR_CODES.map((c) => c.code.length));
  const count = (n: number, key: string): string => (n === 0 ? (allowed.has(key) ? "-" : "MISSING") : String(n));
  const lines = [`${"rule".padEnd(width)}  valid    invalid`];
  for (const r of RULES) {
    const sides = report.rules.get(r.id) ?? { valid: [], invalid: [] };
    lines.push(`${r.id.padEnd(width)}  ${count(sides.valid.length, `${r.id}/valid`).padEnd(7)}  ${count(sides.invalid.length, `${r.id}/invalid`)}`);
  }
  lines.push("", `${"code".padEnd(width)}  cases`);
  for (const { code } of ERROR_CODES) lines.push(`${code.padEnd(width)}  ${count(report.codes.get(code)?.length ?? 0, "")}`);
  return lines;
}
