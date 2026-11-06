/**
 * The payload generator: valid JSON values and near misses for any type of the model, the same
 * for a seed on every run. `strictgen examples` and `strictgen docs` print what it makes, and the
 * differential fuzzer feeds it to every language.
 *
 * A valid payload keeps every rule the model has: closed objects, required keys, tags, the
 * fixed order of untagged unions, enums and consts, map key types, and every constraint (lengths
 * in code points, bounds, `multipleOf`, item and key counts, unique items, patterns, formats).
 * When it can't make a value it is sure of, like a string for a pattern its strings don't match
 * within the length limits, it fails with a {@link GenerateError} rather than return a value that
 * may be invalid.
 *
 * A near miss is a valid payload with one thing changed, labelled with the `{ path, code }` error
 * every decoder must report for it: a missing key, an unknown key, `null`, a value of another
 * type, a wrong tag, enum value or const, a number just past a bound, a string, array or map one
 * past its length limit, a repeated item, and text with `<`, `>` and `&` that a pattern or a
 * format doesn't take. The label follows the rules of docs/error-codes.md: structure errors at
 * their own path, constraint errors only when the value's structure decodes, and inside an
 * untagged union the union's own `wrong_type` (or `null_not_allowed`) when no variant takes the
 * changed value. A change whose error isn't certain, like one that makes another variant of an
 * untagged union fit, is left out.
 *
 * Strings for a `pattern` are built from the pattern's tree (src/pattern.ts) and kept only when
 * the pattern, compiled as ECMAScript reads its portable form, matches them, within the length
 * limits. Every pattern of the portable subset is supported, but one whose strings can't keep
 * the length limits or the format, or that can't match at all, like `a^b`, fails generation for
 * that type.
 */
import { limitsOf } from "./checks.js";
import { compare } from "./common.js";
import type { ReadMode } from "./config.js";
import type {
  ArrayType,
  Decl,
  Format,
  IntegerType,
  MapType,
  Model,
  NumberType,
  StringType,
  StructDecl,
  TypeExpr,
  UntaggedDecl,
} from "./model.js";
import type { PatternNode } from "./pattern.js";
import { MAX_REPEAT, patternTree } from "./pattern.js";

/** A JSON value, as the generator makes it. */
export type Payload = null | boolean | number | string | Payload[] | { [key: string]: Payload };

/** A near miss: a payload, the error every decoder must report for it, and what was changed. */
export interface NearMiss {
  readonly payload: Payload;
  /** The JSON Pointer the error is at. */
  readonly path: string;
  /** The error code, like `missing_key`. */
  readonly code: string;
  /** What was changed, like `removed the required key "id"`. */
  readonly change: string;
}

/** A type the generator can't make a value for that it is sure of. */
export class GenerateError extends Error {
  constructor(
    readonly type: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`can't generate a payload for ${type}${path === "" ? "" : ` at ${path}`}: ${reason}`);
    this.name = "GenerateError";
  }
}

/**
 * A seeded pseudo-random number generator (mulberry32). The same seed gives the same numbers on
 * every platform, since it only uses 32-bit integer arithmetic.
 */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number from 0 up to, not including, 1. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer from `lo` to `hi`, both included. */
  int(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return Math.min(hi, lo + Math.floor(this.next() * (hi - lo + 1)));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }

  /** The items in a random order. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** Options for {@link PayloadGenerator}. */
export interface GeneratorOptions {
  /** The seed. Defaults to 0. */
  readonly seed?: number;
  /**
   * How many types deep values are generated freely. Below that, only the smallest values are:
   * optional keys left out, arrays and maps at their minimum size, and the union branch that
   * nests least, so recursive types end. Defaults to 3.
   */
  readonly depth?: number;
  /**
   * The read modes payloads must hold in, like those of every configured target. A valid
   * payload is valid in each, and a near miss fails with the same error in each. In `report`
   * mode an unknown key is no error, so then the only unknown key near miss is a key a sibling
   * branch of an exactly-one union names. Defaults to `strict`.
   */
  readonly read?: ReadMode | readonly ReadMode[];
}

/** A JSON type other than null. */
type JsonKind = "number" | "string" | "boolean" | "array" | "object";

/** A JSON Pointer segment: a key or an index. */
type Segment = string | number;

/** An untagged union or a unique array a near miss is inside, which its label depends on. */
type Ancestor =
  | {
      readonly kind: "untagged";
      readonly at: readonly Segment[];
      readonly decl: UntaggedDecl;
      readonly variant: number;
    }
  | { readonly kind: "unique"; readonly at: readonly Segment[] };

/** A changed payload, before its label is settled by the ancestors it is inside. */
interface Candidate {
  readonly payload: Payload;
  readonly at: readonly Segment[];
  readonly code: string;
  readonly change: string;
  /** True for a structure error, false for a constraint error. */
  readonly structure: boolean;
  readonly ancestors: readonly Ancestor[];
}

/** The most tries for one value with a constraint, like a string matching a pattern. */
const TRIES = 200;
/** The most a value's length or count goes above its minimum when it has no maximum. */
const SPREAD = 4;
/** The span of an integer or a number without one of its bounds. */
const SPAN = 1000;
/** Arrays and maps are not grown past this many items to break their maximum. */
const MOST_ITEMS = 1000;
/** Characters free strings are made of: letters, digits, a space, HTML's special characters, and more than one byte of UTF-8. */
const ALPHABET = [..."abcdefghijklmnopqrstuvwxyzABCDEFXYZ0123456789", " ", "<", ">", "&", "é", "\u{1f600}"];
/** Text made of HTML's special characters, which near misses put where a pattern or a format doesn't take it. */
const MARKUP = "<>&";

/** The JSON Pointer of segments. */
export function pointer(segments: readonly Segment[]): string {
  return segments.map((s) => `/${String(s).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

function isObject(value: unknown): value is { [key: string]: Payload } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets an own key, so a key like `__proto__` is data, never the object's prototype. */
function put(target: { [key: string]: Payload }, key: string, value: Payload): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** A copy of an object with `key` set to `value`, in place when it has the key, else last. */
function withKey(o: { [key: string]: Payload }, key: string, value: Payload): { [key: string]: Payload } {
  const out: { [key: string]: Payload } = {};
  for (const [k, v] of Object.entries(o)) put(out, k, k === key ? value : v);
  if (!has(o, key)) put(out, key, value);
  return out;
}

function withoutKey(o: { [key: string]: Payload }, key: string): { [key: string]: Payload } {
  const out: { [key: string]: Payload } = {};
  for (const [k, v] of Object.entries(o)) if (k !== key) put(out, k, v);
  return out;
}

/** A copy of an object with the key `from` renamed `to`, keeping its place. */
function renamed(o: { [key: string]: Payload }, from: string, to: string): { [key: string]: Payload } {
  const out: { [key: string]: Payload } = {};
  for (const [k, v] of Object.entries(o)) put(out, k === from ? to : k, v);
  return out;
}

function valueAt(root: Payload, at: readonly Segment[]): Payload | undefined {
  let current: Payload | undefined = root;
  for (const segment of at) {
    if (Array.isArray(current) && typeof segment === "number") current = current[segment];
    else if (isObject(current) && typeof segment === "string" && has(current, segment)) current = current[segment];
    else return undefined;
  }
  return current;
}

/** A copy of `root` with the value at `at` replaced by what `change` makes of it. */
function changed(root: Payload, at: readonly Segment[], change: (value: Payload) => Payload): Payload {
  const [head, ...tail] = at;
  if (head === undefined) return change(root);
  if (Array.isArray(root) && typeof head === "number") {
    return root.map((item, i) => (i === head ? changed(item, tail, change) : item));
  }
  if (isObject(root) && typeof head === "string") {
    return withKey(root, head, changed(root[head] ?? null, tail, change));
  }
  throw new Error(`no value at ${pointer(at)}`);
}

/** The RFC 8785 canonical JSON of a generated value: keys sorted by UTF-16 units, as JavaScript writes numbers. */
export function canonical(value: Payload): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort(compare);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k] ?? null)}`).join(",")}}`;
  }
  if (typeof value === "number" && Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

function codePoints(text: string): string[] {
  return [...text];
}

/** The next float above `x`, or below it with `down`. */
function nextFloat(x: number, down: boolean): number {
  if (x === 0) return down ? -Number.MIN_VALUE : Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const away = x > 0 !== down;
  view.setBigUint64(0, away ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

/** `-0` as `0`, which every language writes the same way. */
function plain(x: number): number {
  return x === 0 ? 0 : x;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function daysIn(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

function isDate(text: string): boolean {
  const m = DATE.exec(text);
  if (m === null) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

/** True when `text` is in a format, by the grammars of docs/error-codes.md. */
export function inFormat(format: Format, text: string): boolean {
  switch (format) {
    case "date":
      return isDate(text);
    case "uuid":
      return UUID.test(text);
    case "date-time": {
      const m = DATE_TIME.exec(text);
      if (m === null || !isDate(m[1] ?? "")) return false;
      const [hour, minute, second] = [Number(m[2]), Number(m[3]), Number(m[4])];
      if (hour > 23 || minute > 59 || second > 60) return false;
      let offset = 0;
      if (m[5] !== undefined) {
        const [oh, om] = [Number(m[6]), Number(m[7])];
        if (oh > 23 || om > 59) return false;
        offset = (m[5] === "-" ? -1 : 1) * (oh * 60 + om);
      }
      if (second < 60) return true;
      // A leap second holds only at 23:59 UTC.
      const utc = (((hour * 60 + minute - offset) % 1440) + 1440) % 1440;
      return utc === 23 * 60 + 59;
    }
  }
}

/**
 * Makes valid payloads and near misses for the types of a model. One generator is one stream of
 * random numbers: the values it gives depend on the seed and on the calls made before.
 */
export class PayloadGenerator {
  readonly #decls: ReadonlyMap<string, Decl>;
  #random: Random;
  /**
   * One value for each string, integer and number type with constraints, found with a fixed
   * seed before anything else, by the type's JSON. A type no value is found for fails for every
   * seed, and one a later seed's tries miss falls back to it, so success never depends on the seed.
   */
  readonly #samples = new Map<string, Payload>();
  /** The declarations whose types {@link #precheck} went through. */
  readonly #checked = new Set<string>();
  readonly #depth: number;
  readonly #modes: readonly ReadMode[];
  /** The read mode structure is checked in, one of {@link #modes}. */
  #mode: ReadMode;
  /** How many types deep the smallest value of each declaration is, by name. */
  readonly #heights = new Map<string, number>();
  readonly #regexes = new Map<string, RegExp>();
  readonly #trees = new Map<string, PatternNode>();
  /** The type a value is generated for, for errors. */
  #type = "";

  constructor(model: Model, options: GeneratorOptions = {}) {
    this.#decls = new Map(model.decls.map((d) => [d.name, d]));
    this.#random = new Random(options.seed ?? 0);
    this.#depth = options.depth ?? 3;
    const read = options.read ?? "strict";
    this.#modes = typeof read === "string" ? [read] : [...new Set(read)].sort(compare);
    if (this.#modes.length === 0) throw new Error("no read mode");
    this.#mode = this.#modes[0] ?? "strict";
    this.#settleHeights();
  }

  /** A valid payload for a type, or for the declaration named `type`. Throws a {@link GenerateError}. */
  valid(type: TypeExpr | string): Payload {
    const expr = this.#expr(type);
    this.#type = typeof type === "string" ? type : "the type";
    this.#precheck(expr, []);
    return this.#value(expr, [], 0);
  }

  /**
   * The near misses of one valid payload, `base` or a new one, in the order its values are
   * walked, each labelled with the error every decoder must report.
   */
  nearMisses(type: TypeExpr | string, base?: Payload): NearMiss[] {
    const expr = this.#expr(type);
    this.#type = typeof type === "string" ? type : "the type";
    this.#precheck(expr, []);
    const root = base ?? this.#value(expr, [], 0);
    const found: Candidate[] = [];
    this.#walk(expr, root, root, [], [], found);
    const out: NearMiss[] = [];
    const seen = new Set<string>();
    for (const candidate of found) {
      const miss = this.#settle(candidate);
      if (miss === undefined) continue;
      const key = `${canonical(miss.payload)} ${miss.path} ${miss.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(miss);
    }
    return out;
  }

  /**
   * True when the structure of `value` fits `type`, constraints left out, as decoders read it
   * in `mode`, by default the first read mode of the options.
   */
  fits(type: TypeExpr | string, value: Payload, mode: ReadMode = this.#modes[0] ?? "strict"): boolean {
    return this.#inMode(mode, () => this.#fits(this.#expr(type), value));
  }

  #inMode<T>(mode: ReadMode, run: () => T): T {
    const saved = this.#mode;
    this.#mode = mode;
    try {
      return run();
    } finally {
      this.#mode = saved;
    }
  }

  /** The variant every read mode decodes `value` as, -1 when none takes it, undefined when they differ. */
  #firstFitAll(decl: UntaggedDecl, value: Payload): number | undefined {
    const found = new Set(this.#modes.map((mode) => this.#inMode(mode, () => this.#firstFit(decl, value))));
    return found.size === 1 ? [...found][0] : undefined;
  }

  #expr(type: TypeExpr | string): TypeExpr {
    if (typeof type !== "string") return type;
    if (!this.#decls.has(type)) throw new Error(`no type named ${type}`);
    return { kind: "ref", name: type };
  }

  #decl(name: string): Decl {
    const decl = this.#decls.get(name);
    if (decl === undefined) throw new Error(`no type named ${name}`);
    return decl;
  }

  #fail(at: readonly Segment[], reason: string): never {
    throw new GenerateError(this.#type, pointer(at), reason);
  }

  // Heights: how deeply the smallest value of each type nests, so small values end.

  #settleHeights(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const decl of this.#decls.values()) {
        const height = this.#declHeight(decl);
        if (height < (this.#heights.get(decl.name) ?? Infinity)) {
          this.#heights.set(decl.name, height);
          changed = true;
        }
      }
    }
  }

  #height(type: TypeExpr): number {
    switch (type.kind) {
      case "ref":
        return this.#heights.get(type.name) ?? Infinity;
      case "array":
        return (type.minItems ?? 0) > 0 ? this.#height(type.items) : 0;
      case "map":
        return (type.minProperties ?? 0) > 0 ? Math.max(this.#height(type.key), this.#height(type.value)) : 0;
      default:
        return 0;
    }
  }

  #declHeight(decl: Decl): number {
    switch (decl.kind) {
      case "struct":
        return 1 + Math.max(0, ...decl.fields.filter((f) => f.required).map((f) => this.#height(f.type)));
      case "tagged":
        return Math.min(...decl.variants.map((v) => this.#heights.get(v.type) ?? Infinity));
      case "untagged":
        return 1 + Math.min(...decl.variants.map((v) => this.#height(v.type)));
      case "alias":
        return this.#height(decl.type);
      case "enum":
      case "id":
        return 0;
    }
  }

  // Valid values.

  #value(type: TypeExpr, at: readonly Segment[], depth: number): Payload {
    const small = depth >= this.#depth;
    switch (type.kind) {
      case "ref":
        return this.#declValue(this.#decl(type.name), at, depth);
      case "string":
        return this.#leaf(type, () => this.#string(type, at));
      case "integer":
        return this.#leaf(type, () => this.#integer(type, at));
      case "number":
        return this.#leaf(type, () => this.#number(type, at));
      case "boolean":
        return this.#random.chance(0.5);
      case "literal":
        return type.value;
      case "any":
        return this.#any(small, true);
      case "nonNull":
        return this.#any(small, false);
      case "array":
        return this.#array(type, at, depth);
      case "map":
        return this.#map(type, at, depth);
    }
  }

  #declValue(decl: Decl, at: readonly Segment[], depth: number): Payload {
    if ((this.#heights.get(decl.name) ?? Infinity) === Infinity) {
      this.#fail(at, `${decl.name} has no value that ends: every value of it holds another`);
    }
    const small = depth >= this.#depth;
    switch (decl.kind) {
      case "struct":
        return this.#struct(decl, at, depth);
      case "enum":
        return this.#random.pick(decl.values);
      case "id":
        return this.#leaf(decl.type, () => this.#string(decl.type, at));
      case "alias":
        return this.#value(decl.type, at, depth);
      case "tagged": {
        const variants = small
          ? decl.variants.filter(
              (v) =>
                (this.#heights.get(v.type) ?? Infinity) ===
                Math.min(...decl.variants.map((w) => this.#heights.get(w.type) ?? Infinity)),
            )
          : decl.variants;
        const variant = this.#random.pick(variants);
        const value = this.#value({ kind: "ref", name: variant.type }, at, depth);
        return isObject(value) ? withKey(value, decl.tag, variant.value) : value;
      }
      case "untagged":
        return this.#untagged(decl, at, depth);
    }
  }

  /**
   * Finds, with a fixed seed, one value for every string, integer and number type that a value
   * of `type` can hold, optional keys, every variant and every item included, and fails with
   * the first one that has none. So whether a type can be generated doesn't depend on the seed,
   * or on whether a seed happens to include an optional key.
   */
  #precheck(type: TypeExpr, at: readonly Segment[]): void {
    const visiting = new Set<string>();
    this.#prechecked(type, at, visiting);
    // Only a whole check that passed is remembered, so a type that failed fails again.
    for (const name of visiting) this.#checked.add(name);
  }

  #prechecked(type: TypeExpr, at: readonly Segment[], visiting: Set<string>): void {
    const check = (t: TypeExpr, where: readonly Segment[]): void => {
      this.#prechecked(t, where, visiting);
    };
    switch (type.kind) {
      case "ref": {
        if (this.#checked.has(type.name) || visiting.has(type.name)) return;
        visiting.add(type.name);
        const decl = this.#decl(type.name);
        switch (decl.kind) {
          case "struct":
            for (const f of decl.fields) check(f.type, [...at, f.name]);
            if (decl.rest !== undefined) check({ kind: "map", key: decl.rest.key, value: decl.rest.value }, at);
            return;
          case "tagged":
            for (const v of decl.variants) check({ kind: "ref", name: v.type }, at);
            return;
          case "untagged":
            for (const v of decl.variants) check(v.type, at);
            return;
          case "alias":
            check(decl.type, at);
            return;
          case "id":
            check(decl.type, at);
            return;
          case "enum":
            return;
        }
        return;
      }
      case "string":
      case "integer":
      case "number": {
        const key = JSON.stringify(type);
        if (this.#samples.has(key)) return;
        const saved = this.#random;
        this.#random = new Random(0);
        try {
          const value =
            type.kind === "string"
              ? this.#string(type, at)
              : type.kind === "integer"
                ? this.#integer(type, at)
                : this.#number(type, at);
          this.#samples.set(key, value);
        } finally {
          this.#random = saved;
        }
        return;
      }
      case "array":
        check(type.items, [...at, 0]);
        return;
      case "map":
        check(type.key, at);
        check(type.value, at);
        return;
      default:
        return;
    }
  }

  /** A value from `make`, or the type's sample from {@link #precheck} when this seed's tries miss. */
  #leaf(type: TypeExpr, make: () => Payload): Payload {
    try {
      return make();
    } catch (error) {
      const sample = this.#samples.get(JSON.stringify(type));
      if (!(error instanceof GenerateError) || sample === undefined) throw error;
      return sample;
    }
  }

  #struct(decl: StructDecl, at: readonly Segment[], depth: number): Payload {
    const small = depth >= this.#depth;
    const out: { [key: string]: Payload } = {};
    for (const field of decl.fields) {
      if (!field.required && (small || this.#random.chance(0.5))) continue;
      put(out, field.name, this.#value(field.type, [...at, field.name], depth + 1));
    }
    const rest = decl.rest;
    if (rest !== undefined && !small && this.#random.chance(0.5)) {
      const taken = new Set([...decl.fields.map((f) => f.name), ...decl.forbidden]);
      for (let i = 0; i < TRIES; i++) {
        const key = this.#value(rest.key, at, depth + 1);
        if (typeof key !== "string") this.#fail(at, "a map key that isn't a string");
        if (taken.has(key)) continue;
        put(out, key, this.#value(rest.value, [...at, key], depth + 1));
        break;
      }
    }
    return out;
  }

  /**
   * A value of one variant that no variant before it takes, since decoders try them in order.
   * Small values try the variants that nest least first.
   */
  #untagged(decl: UntaggedDecl, at: readonly Segment[], depth: number): Payload {
    const small = depth >= this.#depth;
    const indexes = decl.variants.map((_, i) => i);
    const order = small
      ? [...indexes].sort((a, b) => this.#variantHeight(decl, a) - this.#variantHeight(decl, b) || a - b)
      : this.#random.shuffle(indexes);
    for (const index of order) {
      const variant = decl.variants[index];
      if (variant === undefined || this.#variantHeight(decl, index) === Infinity) continue;
      for (let i = 0; i < 20; i++) {
        let value: Payload;
        try {
          value = this.#value(variant.type, at, depth);
        } catch (error) {
          if (error instanceof GenerateError) break;
          throw error;
        }
        if (this.#firstFitAll(decl, value) === index) return value;
      }
    }
    return this.#fail(at, `no value of ${decl.name} that its variants take in their order`);
  }

  #variantHeight(decl: UntaggedDecl, index: number): number {
    const variant = decl.variants[index];
    return variant === undefined ? Infinity : this.#height(variant.type);
  }

  /** The index of the first variant whose structure takes `value`, or -1. */
  #firstFit(decl: UntaggedDecl, value: Payload): number {
    return decl.variants.findIndex((v) => this.#fits(v.type, value));
  }

  #array(type: ArrayType, at: readonly Segment[], depth: number): Payload {
    const min = type.minItems ?? 0;
    const max = type.maxItems ?? Infinity;
    if (min > max) this.#fail(at, `minItems ${String(min)} is above maxItems ${String(max)}`);
    const count = depth >= this.#depth ? min : this.#random.int(min, Math.min(max, min + SPREAD));
    const items: Payload[] = [];
    const seen = new Set<string>();
    // Unique items may run out, like booleans, so there may be fewer, never fewer than the minimum.
    for (let i = 0; i < count; i++) {
      let item: Payload | undefined;
      for (let tries = 0; tries < TRIES && item === undefined; tries++) {
        const next = this.#value(type.items, [...at, i], depth);
        if (type.uniqueItems !== true || !seen.has(canonical(next))) item = next;
      }
      if (item === undefined) {
        if (items.length >= min) break;
        this.#fail(at, `can't find ${String(min)} unique items`);
      }
      seen.add(canonical(item));
      items.push(item);
    }
    return items;
  }

  #map(type: MapType, at: readonly Segment[], depth: number): Payload {
    const min = type.minProperties ?? 0;
    const max = type.maxProperties ?? Infinity;
    if (min > max) this.#fail(at, `minProperties ${String(min)} is above maxProperties ${String(max)}`);
    const count = depth >= this.#depth ? min : this.#random.int(min, Math.min(max, min + SPREAD));
    const out: { [key: string]: Payload } = {};
    for (let i = 0; i < count; i++) {
      const key = this.#newKey(type.key, at, out, depth);
      if (key === undefined) {
        if (i >= min) break;
        this.#fail(at, `can't find ${String(min)} distinct keys`);
      }
      put(out, key, this.#value(type.value, [...at, key], depth));
    }
    return out;
  }

  /** A valid key of `type` that `o` doesn't have, or undefined after many tries. */
  #newKey(type: TypeExpr, at: readonly Segment[], o: object, depth: number, also: readonly string[] = []): string | undefined {
    for (let i = 0; i < TRIES; i++) {
      const key = this.#value(type, at, depth);
      if (typeof key !== "string") this.#fail(at, "a map key that isn't a string");
      if (!has(o, key) && !also.includes(key)) return key;
    }
    return undefined;
  }

  #any(small: boolean, nullable: boolean): Payload {
    const scalars: Payload[] = [true, 7, "any"];
    if (nullable) scalars.push(null);
    if (small) return this.#random.pick(scalars);
    const kinds: Payload[] = [...scalars, [1, "two"], { key: "value" }];
    return this.#random.pick(kinds);
  }

  #string(type: StringType, at: readonly Segment[]): string {
    const min = type.minLength ?? 0;
    const max = type.maxLength ?? Infinity;
    if (min > max) this.#fail(at, `minLength ${String(min)} is above maxLength ${String(max)}`);
    const fitsLength = (s: string): boolean => {
      const n = codePoints(s).length;
      return n >= min && n <= max;
    };
    const { format, match } = type;
    const matches = (s: string): boolean => match === undefined || this.#regex(match.regex).test(s);
    if (format !== undefined) {
      for (let i = 0; i < TRIES; i++) {
        const s = this.#formatted(format);
        if (fitsLength(s) && matches(s)) return s;
      }
      if (match !== undefined) {
        for (let i = 0; i < TRIES; i++) {
          const s = this.#fromPattern(match.regex, i, min);
          if (fitsLength(s) && inFormat(format, s) && matches(s)) return s;
        }
      }
      return this.#fail(at, `no string found that is a ${format}${this.#limits(type)}`);
    }
    if (match !== undefined) {
      for (let i = 0; i < TRIES; i++) {
        let s = this.#fromPattern(match.regex, i, min);
        // A pattern without $ matches inside longer strings, so a short match can grow. One with $
        // only grows by repeating more, which keeps the test fast for patterns with nested repeats.
        if (!this.#endsAnchored(match.regex)) while (codePoints(s).length < min) s += this.#random.pick(ALPHABET);
        if (fitsLength(s) && matches(s)) return s;
      }
      return this.#fail(at, `no string found that matches ${match.source}${this.#limits(type)}`);
    }
    const length = this.#random.int(min, Math.min(max, min + SPREAD + 4));
    let s = "";
    for (let i = 0; i < length; i++) s += this.#random.pick(ALPHABET);
    return s;
  }

  #limits(type: StringType): string {
    const { minLength: min, maxLength: max } = type;
    if (min === undefined && max === undefined) return "";
    if (max === undefined) return ` with at least ${String(min)} characters`;
    if (min === undefined) return ` with at most ${String(max)} characters`;
    return ` with ${String(min)} to ${String(max)} characters`;
  }

  #regex(source: string): RegExp {
    let regex = this.#regexes.get(source);
    if (regex === undefined) {
      regex = new RegExp(source, "u");
      this.#regexes.set(source, regex);
    }
    return regex;
  }

  #formatted(format: Format): string {
    const r = this.#random;
    const year = r.int(1970, 2099);
    const month = r.int(1, 12);
    const date = `${String(year)}-${pad2(month)}-${pad2(r.int(1, daysIn(year, month)))}`;
    switch (format) {
      case "date":
        return date;
      case "date-time": {
        const time = `${pad2(r.int(0, 23))}:${pad2(r.int(0, 59))}:${pad2(r.int(0, 59))}`;
        const fraction = r.chance(0.3) ? `.${String(r.int(0, 999)).padStart(3, "0")}` : "";
        const zone = r.chance(0.5) ? "Z" : `${r.pick(["+", "-"])}${pad2(r.int(0, 14))}:${r.pick(["00", "30"])}`;
        return `${date}T${time}${fraction}${zone}`;
      }
      case "uuid": {
        const hex = (n: number): string => Array.from({ length: n }, () => r.pick([..."0123456789abcdef"])).join("");
        return `${hex(8)}-${hex(4)}-4${hex(3)}-${r.pick([..."89ab"])}${hex(3)}-${hex(12)}`;
      }
    }
  }

  #tree(source: string): PatternNode {
    let tree = this.#trees.get(source);
    if (tree === undefined) {
      tree = patternTree(source);
      this.#trees.set(source, tree);
    }
    return tree;
  }

  /** True when a pattern has a $, so no text can follow a match. */
  #endsAnchored(source: string): boolean {
    const walk = (node: PatternNode): boolean => {
      switch (node.kind) {
        case "end":
          return true;
        case "alt":
          return node.options.some(walk);
        case "seq":
          return node.items.some(walk);
        case "group":
        case "repeat":
          return walk(node.body);
        default:
          return false;
      }
    };
    return walk(this.#tree(source));
  }

  /** A string built from a pattern's tree. Later tries repeat more, to reach a minimum length. */
  #fromPattern(source: string, attempt: number, min: number): string {
    const tree = this.#tree(source);
    const extra = Math.min(MAX_REPEAT, SPREAD + Math.floor(attempt / 10) * Math.max(8, Math.ceil(min / 8)));
    const build = (node: PatternNode): string => {
      switch (node.kind) {
        case "alt":
          return build(this.#random.pick(node.options));
        case "seq":
          return node.items.map(build).join("");
        case "char":
          return String.fromCodePoint(node.code);
        case "set":
          return String.fromCodePoint(this.#codeFrom(node.set));
        case "start":
        case "end":
          return "";
        case "group":
          return build(node.body);
        case "repeat": {
          const most = node.max ?? node.min + extra;
          const count = this.#random.int(node.min, Math.min(most, node.min + extra));
          let out = "";
          for (let i = 0; i < count; i++) out += build(node.body);
          return out;
        }
      }
    };
    return build(tree);
  }

  /** A code point of a set, printable ASCII when the set has some, mostly. */
  #codeFrom(set: readonly (readonly [number, number])[]): number {
    const printable = set
      .map(([lo, hi]) => [Math.max(lo, 0x20), Math.min(hi, 0x7e)] as const)
      .filter(([lo, hi]) => lo <= hi);
    const ranges = printable.length > 0 && this.#random.chance(0.9) ? printable : set;
    const [lo, hi] = this.#random.pick(ranges);
    return this.#random.int(lo, hi);
  }

  #integer(type: IntegerType, at: readonly Segment[]): number {
    const [lo, hi] = this.#integerRange(type);
    if (lo > hi) this.#fail(at, "no integer is within its bounds");
    const m = type.multipleOf;
    if (m === undefined) return plain(this.#random.int(lo, hi));
    const first = Math.ceil(lo / m) * m;
    const last = Math.floor(hi / m) * m;
    if (first > last || !Number.isSafeInteger(first) || !Number.isSafeInteger(last)) {
      this.#fail(at, `no multiple of ${String(m)} is within its bounds`);
    }
    const value = plain(first + this.#random.int(0, (last - first) / m) * m);
    if (value < lo || value > hi || value % m !== 0) this.#fail(at, `no multiple of ${String(m)} found within its bounds`);
    return value;
  }

  /** The lowest and highest integer an integer type takes, within a span when a bound is missing. */
  #integerRange(type: IntegerType): [number, number] {
    let lo = Math.max(type.minimum ?? -Infinity, type.exclusiveMinimum === undefined ? -Infinity : Math.floor(type.exclusiveMinimum) + 1);
    let hi = Math.min(type.maximum ?? Infinity, type.exclusiveMaximum === undefined ? Infinity : Math.ceil(type.exclusiveMaximum) - 1);
    lo = Math.ceil(lo);
    hi = Math.floor(hi);
    if (lo === -Infinity && hi === Infinity) [lo, hi] = [0, SPAN];
    else if (lo === -Infinity) lo = hi - SPAN;
    else if (hi === Infinity) hi = lo + SPAN;
    return [Math.max(lo, Number.MIN_SAFE_INTEGER), Math.min(hi, Number.MAX_SAFE_INTEGER)];
  }

  #number(type: NumberType, at: readonly Segment[]): number {
    const within = (x: number): boolean =>
      Number.isFinite(x) &&
      (type.minimum === undefined || x >= type.minimum) &&
      (type.exclusiveMinimum === undefined || x > type.exclusiveMinimum) &&
      (type.maximum === undefined || x <= type.maximum) &&
      (type.exclusiveMaximum === undefined || x < type.exclusiveMaximum);
    let lo = Math.max(type.minimum ?? -Infinity, type.exclusiveMinimum ?? -Infinity);
    let hi = Math.min(type.maximum ?? Infinity, type.exclusiveMaximum ?? Infinity);
    if (lo === -Infinity && hi === Infinity) [lo, hi] = [0, SPAN];
    else if (lo === -Infinity) lo = hi - SPAN;
    else if (hi === Infinity) hi = lo + SPAN;
    const r = this.#random.next();
    const raw = lo + (hi / 2 - lo / 2) * 2 * r;
    const candidates = [
      Math.round(raw * 100) / 100,
      Math.round(raw),
      raw,
      lo / 2 + hi / 2,
      nextFloat(lo, false),
      lo,
      hi,
    ];
    const value = candidates.find(within);
    if (value === undefined) return this.#fail(at, "no number is within its bounds");
    return plain(value);
  }

  // Structure, as decoders read it.

  #fits(type: TypeExpr, value: Payload): boolean {
    switch (type.kind) {
      case "ref":
        return this.#declFits(this.#decl(type.name), value);
      case "string":
        return typeof value === "string";
      case "integer":
        return typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "boolean":
        return typeof value === "boolean";
      case "literal":
        return value === type.value && !Object.is(value, -0);
      case "any":
        return true;
      case "nonNull":
        return value !== null;
      case "array":
        return Array.isArray(value) && value.every((item) => this.#fits(type.items, item));
      case "map":
        return (
          isObject(value) &&
          Object.entries(value).every(([k, v]) => this.#fits(type.key, k) && this.#fits(type.value, v))
        );
    }
  }

  #declFits(decl: Decl, value: Payload): boolean {
    switch (decl.kind) {
      case "struct":
        return this.#structFits(decl, value);
      case "enum":
        return typeof value === "string" && decl.values.includes(value);
      case "id":
        return typeof value === "string";
      case "alias":
        return this.#fits(decl.type, value);
      case "tagged": {
        if (!isObject(value) || !has(value, decl.tag)) return false;
        const tag = value[decl.tag];
        const variant = decl.variants.find((v) => v.value === tag);
        return variant !== undefined && this.#declFits(this.#decl(variant.type), value);
      }
      case "untagged":
        return this.#firstFit(decl, value) >= 0;
    }
  }

  #structFits(decl: StructDecl, value: Payload): boolean {
    if (!isObject(value)) return false;
    for (const field of decl.fields) {
      if (!has(value, field.name)) {
        if (field.required) return false;
        continue;
      }
      if (!this.#fits(field.type, value[field.name] ?? null)) return false;
    }
    const named = new Set(decl.fields.map((f) => f.name));
    for (const [key, item] of Object.entries(value)) {
      if (named.has(key)) continue;
      if (decl.rest !== undefined) {
        if (!this.#fits(decl.rest.key, key) || !this.#fits(decl.rest.value, item)) return false;
      } else if (this.#mode === "strict" || decl.forbidden.includes(key)) {
        return false;
      }
    }
    return true;
  }

  // Near misses.

  /**
   * Notes the near misses of `value`, of `type` at `at` in `root`, and of the values inside it.
   * `skip` is a key not to change, the tag of a tagged union's branch.
   */
  #walk(
    type: TypeExpr,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
    skip?: string,
  ): void {
    const note = (payload: Payload, where: readonly Segment[], code: string, change: string, structure = true): void => {
      out.push({ payload, at: where, code, change, structure, ancestors });
    };
    const replace = (next: Payload): Payload => changed(root, at, () => next);
    // Null and a value of another JSON type, where the type doesn't take them.
    if (!this.#fits(type, null)) note(replace(null), at, "null_not_allowed", "null in place of the value");
    const other = this.#otherKind(type);
    if (other !== undefined) note(replace(other), at, "wrong_type", `${JSON.stringify(other)} in place of the value`);
    switch (type.kind) {
      case "ref":
        this.#walkDecl(this.#decl(type.name), value, root, at, ancestors, out, skip);
        return;
      case "string":
        this.#walkString(type, value, root, at, ancestors, out);
        return;
      case "integer":
        note(replace(1.5), at, "wrong_type", "a fraction for an integer");
        this.#walkNumber(type, value, root, at, ancestors, out);
        return;
      case "number":
        this.#walkNumber(type, value, root, at, ancestors, out);
        return;
      case "literal":
        if (typeof type.value === "boolean") note(replace(!type.value), at, "not_const", "the other boolean");
        else if (Number.isSafeInteger(type.value + 1)) note(replace(type.value + 1), at, "not_const", "another integer");
        return;
      case "array":
        this.#walkArray(type, value, root, at, ancestors, out);
        return;
      case "map":
        this.#walkMap(type, value, root, at, ancestors, out);
        return;
      default:
        return;
    }
  }

  /** A value of a JSON type `type` doesn't take, other than null, or undefined when it takes them all. */
  #otherKind(type: TypeExpr): Payload | undefined {
    const kinds = this.#kinds(type);
    const tries: [JsonKind, Payload][] = [
      ["number", 12],
      ["string", "text"],
      ["boolean", true],
      ["array", []],
      ["object", {}],
    ];
    return tries.find(([kind]) => !kinds.has(kind))?.[1];
  }

  /**
   * The JSON types a type takes at its top, but null: a value of any other fails with
   * wrong_type. An enum or a const takes its JSON type, though only some of its values.
   */
  #kinds(type: TypeExpr, seen: ReadonlySet<string> = new Set()): Set<JsonKind> {
    switch (type.kind) {
      case "ref": {
        if (seen.has(type.name)) return new Set();
        const decl = this.#decl(type.name);
        const inner = new Set([...seen, type.name]);
        switch (decl.kind) {
          case "struct":
          case "tagged":
            return new Set(["object"]);
          case "enum":
          case "id":
            return new Set(["string"]);
          case "alias":
            return this.#kinds(decl.type, inner);
          case "untagged":
            return new Set(decl.variants.flatMap((v) => [...this.#kinds(v.type, inner)]));
        }
        return new Set();
      }
      case "string":
        return new Set(["string"]);
      case "integer":
      case "number":
        return new Set(["number"]);
      case "boolean":
        return new Set(["boolean"]);
      case "literal":
        return new Set([typeof type.value === "boolean" ? "boolean" : "number"]);
      case "any":
      case "nonNull":
        return new Set(["number", "string", "boolean", "array", "object"]);
      case "array":
        return new Set(["array"]);
      case "map":
        return new Set(["object"]);
    }
  }

  #walkDecl(
    decl: Decl,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
    skip?: string,
  ): void {
    const note = (payload: Payload, where: readonly Segment[], code: string, change: string): void => {
      out.push({ payload, at: where, code, change, structure: true, ancestors });
    };
    const replace = (next: Payload): Payload => changed(root, at, () => next);
    switch (decl.kind) {
      case "struct":
        this.#walkStruct(decl, value, root, at, ancestors, out, skip);
        return;
      case "enum": {
        let text = "unlisted";
        while (decl.values.includes(text)) text += "_";
        note(replace(text), at, decl.values.length === 1 ? "not_const" : "not_in_enum", "a value the enum doesn't list");
        return;
      }
      case "id":
        this.#walkString(decl.type, value, root, at, ancestors, out);
        return;
      case "alias":
        this.#walk(decl.type, value, root, at, ancestors, out);
        return;
      case "tagged": {
        if (!isObject(value)) return;
        const tagAt = [...at, decl.tag];
        note(changed(root, at, (v) => (isObject(v) ? withoutKey(v, decl.tag) : v)), tagAt, "missing_key", `removed the tag ${JSON.stringify(decl.tag)}`);
        let tag = "unknown";
        while (decl.variants.some((v) => v.value === tag)) tag += "_";
        note(changed(root, tagAt, () => tag), tagAt, "bad_tag", "a tag no branch has");
        note(changed(root, tagAt, () => null), tagAt, "null_not_allowed", "null for the tag");
        note(changed(root, tagAt, () => 12), tagAt, "wrong_type", "a number for the tag");
        const variant = decl.variants.find((v) => v.value === value[decl.tag]);
        if (variant !== undefined) this.#walkDecl(this.#decl(variant.type), value, root, at, ancestors, out, decl.tag);
        return;
      }
      case "untagged": {
        const index = this.#firstFitAll(decl, value);
        const variant = index === undefined ? undefined : decl.variants[index];
        if (variant === undefined) return;
        const inside: Ancestor = { kind: "untagged", at, decl, variant: index ?? -1 };
        this.#walk(variant.type, value, root, at, [...ancestors, inside], out);
        return;
      }
    }
  }

  #walkStruct(
    decl: StructDecl,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
    skip?: string,
  ): void {
    if (!isObject(value)) return;
    const note = (payload: Payload, where: readonly Segment[], code: string, change: string): void => {
      out.push({ payload, at: where, code, change, structure: true, ancestors });
    };
    const edit = (f: (o: { [key: string]: Payload }) => Payload): Payload =>
      changed(root, at, (v) => (isObject(v) ? f(v) : v));
    for (const field of decl.fields) {
      if (field.name === skip) continue;
      const fieldAt = [...at, field.name];
      if (has(value, field.name)) {
        if (field.required) {
          note(edit((o) => withoutKey(o, field.name)), fieldAt, "missing_key", `removed the required key ${JSON.stringify(field.name)}`);
        }
        this.#walk(field.type, value[field.name] ?? null, root, fieldAt, ancestors, out);
      } else if (!this.#fits(field.type, null)) {
        note(edit((o) => withKey(o, field.name, null)), fieldAt, "null_not_allowed", `null for the optional key ${JSON.stringify(field.name)}`);
      }
    }
    const named = new Set(decl.fields.map((f) => f.name));
    if (decl.rest === undefined) {
      const unknown = this.#modes.includes("report")
        ? decl.forbidden.find((k) => !has(value, k))
        : this.#extraKey(decl, value);
      if (unknown !== undefined) {
        note(edit((o) => withKey(o, unknown, true)), [...at, unknown], "unknown_key", `added the key ${JSON.stringify(unknown)}`);
      }
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (named.has(key)) continue;
      this.#walkKey(decl.rest.key, key, value, root, at, ancestors, out, [...named]);
      this.#walk(decl.rest.value, item, root, [...at, key], ancestors, out);
    }
  }

  /** A key the struct doesn't name, for an unknown key near miss. */
  #extraKey(decl: StructDecl, value: { [key: string]: Payload }): string {
    let key = "unexpected";
    while (decl.fields.some((f) => f.name === key) || has(value, key)) key += "_";
    return key;
  }

  #walkString(
    type: StringType,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
  ): void {
    if (typeof value !== "string") return;
    for (const [next, code, change] of this.#badStrings(type, value)) {
      out.push({ payload: changed(root, at, () => next), at, code, change, structure: false, ancestors });
    }
  }

  /** Strings that break one constraint of `type`, each with its code and what changed. */
  #badStrings(type: StringType, value: string): [string, string, string][] {
    const out: [string, string, string][] = [];
    const chars = codePoints(value);
    const { minLength: min, maxLength: max, match, format } = type;
    if (max !== undefined && max < MOST_ITEMS) {
      const longer = [...chars];
      while (longer.length <= max) longer.push(this.#random.pick(ALPHABET));
      out.push([longer.join(""), "too_long", `a string of ${String(max + 1)} characters, one past the maximum`]);
    }
    if (min !== undefined && min > 0) {
      out.push([chars.slice(0, min - 1).join(""), "too_short", `a string of ${String(min - 1)} characters, one under the minimum`]);
    }
    // Text of HTML's special characters, of a length the limits take, where the pattern or the format doesn't take it.
    const length = Math.min(Math.max(MARKUP.length, min ?? 0), max ?? Infinity);
    if (length > 0) {
      const text = MARKUP.repeat(Math.ceil(length / MARKUP.length)).slice(0, length);
      if (match !== undefined && !this.#regex(match.regex).test(text)) {
        out.push([text, "pattern_mismatch", "text with <, > and & that the pattern doesn't match"]);
      } else if (format !== undefined && !inFormat(format, text)) {
        out.push([text, "bad_format", `text with <, > and & that is not a ${format}`]);
      }
    }
    return out;
  }

  #walkNumber(
    type: IntegerType | NumberType,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
  ): void {
    if (typeof value !== "number") return;
    const note = (next: number, code: string, change: string): void => {
      out.push({ payload: changed(root, at, () => plain(next)), at, code, change, structure: false, ancestors });
    };
    for (const { op, bound, text } of limitsOf(type)) {
      if (type.kind === "integer") {
        const next = op === ">=" ? bound - 1 : op === ">" ? bound : op === "<=" ? bound + 1 : op === "<" ? bound : undefined;
        if (next === undefined || !Number.isSafeInteger(next)) continue;
        note(next, op.startsWith(">") ? "too_small" : "too_large", `${String(next)}, just past ${op} ${text}`);
      } else {
        const next = op === ">=" ? nextFloat(bound, true) : op === "<=" ? nextFloat(bound, false) : bound;
        if (!Number.isFinite(next) || op === "%") continue;
        note(next, op.startsWith(">") ? "too_small" : "too_large", `${String(next)}, just past ${op} ${text}`);
      }
    }
    if (type.kind === "integer" && type.multipleOf !== undefined && type.multipleOf > 1) {
      const [lo, hi] = this.#integerRange(type);
      const next = [value + 1, value - 1].find((v) => v >= lo && v <= hi && Number.isSafeInteger(v));
      if (next !== undefined) note(next, "not_multiple_of", `${String(next)}, not a multiple of ${String(type.multipleOf)}`);
    }
  }

  #walkArray(
    type: ArrayType,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
  ): void {
    if (!Array.isArray(value)) return;
    const note = (next: Payload[], code: string, change: string, where: readonly Segment[] = at): void => {
      out.push({ payload: changed(root, at, () => next), at: where, code, change, structure: false, ancestors });
    };
    const { minItems: min, maxItems: max } = type;
    if (max !== undefined && max < MOST_ITEMS) {
      const longer = [...value];
      while (longer.length <= max) longer.push(this.#value(type.items, [...at, longer.length], this.#depth));
      note(longer, "too_long", `${String(max + 1)} items, one past the maximum`);
    }
    if (min !== undefined && min > 0) note(value.slice(0, min - 1), "too_short", `${String(min - 1)} items, one under the minimum`);
    if (type.uniqueItems === true && value.length > 0) {
      const first = value[0] ?? null;
      if (value.length >= 2) {
        note(value.map((item, i) => (i === 1 ? first : item)), "not_unique", "item 1 repeats item 0", [...at, 1]);
      } else if (max === undefined || max >= 2) {
        note([first, first], "not_unique", "item 1 repeats item 0", [...at, 1]);
      }
    }
    const inside: Ancestor[] = type.uniqueItems === true ? [...ancestors, { kind: "unique", at }] : [...ancestors];
    value.forEach((item, i) => {
      this.#walk(type.items, item, root, [...at, i], inside, out);
    });
  }

  #walkMap(
    type: MapType,
    value: Payload,
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
  ): void {
    if (!isObject(value)) return;
    const note = (next: Payload, code: string, change: string): void => {
      out.push({ payload: changed(root, at, () => next), at, code, change, structure: false, ancestors });
    };
    const { minProperties: min, maxProperties: max } = type;
    const keys = Object.keys(value);
    if (max !== undefined && max < MOST_ITEMS) {
      let longer: { [key: string]: Payload } | undefined = { ...value };
      while (longer !== undefined && Object.keys(longer).length <= max) {
        const key = this.#newKey(type.key, at, longer, this.#depth);
        if (key === undefined) longer = undefined;
        else longer = withKey(longer, key, this.#value(type.value, [...at, key], this.#depth));
      }
      if (longer !== undefined) note(longer, "too_long", `${String(max + 1)} keys, one past the maximum`);
    }
    if (min !== undefined && min > 0) {
      let shorter = value;
      for (const key of keys.slice(min - 1)) shorter = withoutKey(shorter, key);
      note(shorter, "too_short", `${String(min - 1)} keys, one under the minimum`);
    }
    for (const [key, item] of Object.entries(value)) {
      this.#walkKey(type.key, key, value, root, at, ancestors, out, []);
      this.#walk(type.value, item, root, [...at, key], ancestors, out);
    }
  }

  /**
   * Near misses of one key of a map or a rest map, at the key's pointer: a key the key type's
   * enum doesn't list, and keys that break its constraints. `named` are keys the key may not
   * become, the named keys of a struct.
   */
  #walkKey(
    type: TypeExpr,
    key: string,
    o: { [key: string]: Payload },
    root: Payload,
    at: readonly Segment[],
    ancestors: readonly Ancestor[],
    out: Candidate[],
    named: readonly string[],
  ): void {
    const rename = (next: string, code: string, change: string, structure: boolean): void => {
      if (next === key || has(o, next) || named.includes(next)) return;
      const payload = changed(root, at, (v) => (isObject(v) ? renamed(v, key, next) : v));
      out.push({ payload, at: [...at, next], code, change, structure, ancestors });
    };
    let current = type;
    for (let depth = 0; current.kind === "ref" && depth <= this.#decls.size; depth++) {
      const decl = this.#decl(current.name);
      if (decl.kind === "enum") {
        let next = "unlisted";
        while (decl.values.includes(next)) next += "_";
        rename(next, decl.values.length === 1 ? "not_const" : "not_in_enum", "a key the enum doesn't list", true);
        return;
      }
      if (decl.kind === "id") {
        current = decl.type;
        break;
      }
      if (decl.kind !== "alias") return;
      current = decl.type;
    }
    if (current.kind !== "string") return;
    for (const [next, code, change] of this.#badStrings(current, key)) rename(next, code, `${change}, as a key`, false);
  }

  /**
   * The near miss a candidate is, with the label every decoder reports, or undefined when that
   * isn't certain. Inside an untagged union, a structure error is the union's own when no
   * variant takes the changed value, and a constraint error holds when the variant that takes
   * it is still the first one. A constraint error inside a unique array holds while the items
   * stay unique.
   */
  #settle(candidate: Candidate): NearMiss | undefined {
    const labels = this.#modes.map((mode) => this.#inMode(mode, () => this.#label(candidate)));
    const [first] = labels;
    if (first === undefined || labels.some((l) => l?.path !== first.path || l.code !== first.code)) return undefined;
    return first;
  }

  #label(candidate: Candidate): NearMiss | undefined {
    let at = candidate.at;
    let code = candidate.code;
    const { payload } = candidate;
    for (const ancestor of [...candidate.ancestors].reverse()) {
      const value = valueAt(payload, ancestor.at);
      if (value === undefined) return undefined;
      if (ancestor.kind === "unique") {
        if (candidate.structure || !Array.isArray(value)) continue;
        if (new Set(value.map(canonical)).size !== value.length) return undefined;
        continue;
      }
      const first = this.#firstFit(ancestor.decl, value);
      if (candidate.structure) {
        if (first >= 0) return undefined;
        at = ancestor.at;
        code = value === null ? "null_not_allowed" : "wrong_type";
      } else if (first !== ancestor.variant) {
        return undefined;
      }
    }
    return { payload, path: pointer(at), code, change: candidate.change };
  }
}
