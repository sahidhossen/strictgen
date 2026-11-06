/**
 * The body of the generated `helpers.ts`, which every generated TypeScript file imports as
 * `h`. It has no imports itself, so the output needs no package to install.
 */
export const TS_HELPERS_BODY = `/**
 * Helpers the generated decoders and encoders share.
 *
 * Decoders read a value that is already parsed, like the result of JSON.parse, and check it
 * strictly: unknown keys, missing required keys, null for an optional key and values of the
 * wrong type fail with a DecodeError naming the JSON Pointer of the first problem.
 *
 * Encoders check the value as strictly before they write it, and throw an EncodeError for one
 * that Rust and Go could not hold or that would not decode again: an unknown key, a missing
 * required key, an enum value the type doesn't list, NaN or Infinity, and for integers -0, a
 * fraction or a value past Number.MAX_SAFE_INTEGER.
 *
 * Numbers: a parsed JavaScript number keeps neither its JSON spelling nor values past 2^53.
 * An integer decodes only when it is a whole number within Number.MAX_SAFE_INTEGER, and not
 * -0, so a value that lost precision fails instead of decoding as a different number. Since
 * the spelling is gone, 12.0 and 1e2 decode as the integers 12 and 100, which Rust and Go
 * reject, and a number re-encodes as JavaScript spells it: 12.0 as 12 and -0 as 0.
 */

/** A value that doesn't fit its generated type. */
export class DecodeError extends Error {
  /** JSON Pointer to the value that failed, like /items/0/price, or "" for the whole input. */
  readonly path: string;
  /** Why it failed, like: missing key "id". */
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(path === "" ? reason : path + ": " + reason);
    this.name = "DecodeError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * A value an encoder refuses, because Rust and Go could not hold it or it would not decode
 * again, like an integer past 2^53, NaN or a value an enum doesn't list.
 */
export class EncodeError extends Error {
  /** JSON Pointer to the value that was refused, like /items/0/price, or "" for the whole value. */
  readonly path: string;
  /** Why it was refused, like: expected an integer, found 1.5. */
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(path === "" ? reason : path + ": " + reason);
    this.name = "EncodeError";
    this.path = path;
    this.reason = reason;
  }
}

/** The result of a tryDecode function: the value, or the error instead of throwing it. */
export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DecodeError };

/** Decodes a parsed JSON value found at path, a JSON Pointer, or throws a DecodeError. */
export type Decoder<T> = (json: unknown, path: string) => T;

/** Encodes a value as a JSON value, or throws an EncodeError. */
export type Encoder<T> = (value: T) => unknown;

/** Runs decode on the whole input and returns its DecodeError instead of throwing it. */
export function attempt<T>(decode: Decoder<T>, json: unknown): DecodeResult<T> {
  try {
    return { ok: true, value: decode(json, "") };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, error };
    throw error;
  }
}

/** The path of a key or an index under path, escaped as a JSON Pointer segment. */
export function at(path: string, segment: string | number): string {
  return path + "/" + String(segment).replace(/~/g, "~0").replace(/\\//g, "~1");
}

const hasOwn = Object.prototype.hasOwnProperty;

/** True for an object as JSON.parse makes it: not an array, a class instance or null. */
function isObject(json: unknown): json is Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
  const proto: unknown = Object.getPrototypeOf(json);
  return proto === Object.prototype || proto === null;
}

/** Names the kind of a value for errors, like "a string" or "null". */
export function kind(json: unknown): string {
  if (json === null) return "null";
  if (Array.isArray(json)) return "an array";
  switch (typeof json) {
    case "string":
      return "a string";
    case "boolean":
      return "a boolean";
    case "number":
      return Number.isFinite(json) ? "a number" : "a number that is not finite";
    case "object":
      return isObject(json) ? "an object" : "an object that is not plain JSON";
    default:
      return "a value that is not JSON";
  }
}

/** A string in double quotes, for errors. */
function quote(text: string): string {
  return JSON.stringify(text);
}

/** A number as written in errors, with -0 kept. */
function numberText(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/** Orders keys by code point, which is the byte order of their UTF-8, as Rust and Go sort them. */
function byCodePoint(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(i) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++;
  }
  return a.length - b.length;
}

function expected(path: string, what: string, json: unknown): never {
  throw new DecodeError(path, "expected " + what + ", found " + kind(json));
}

/** Decodes a JSON string. */
export function decodeString(json: unknown, path: string): string {
  if (typeof json !== "string") return expected(path, "a string", json);
  return json;
}

/** Decodes a JSON boolean. */
export function decodeBoolean(json: unknown, path: string): boolean {
  if (typeof json !== "boolean") return expected(path, "a boolean", json);
  return json;
}

/** Decodes a finite JSON number. It re-encodes as JavaScript spells it, so 12.0 becomes 12. */
export function decodeNumber(json: unknown, path: string): number {
  if (typeof json !== "number" || !Number.isFinite(json)) return expected(path, "a number", json);
  return json;
}

/** Why a number is not an integer Rust and Go hold the same way, or undefined when it is one. */
function notInteger(value: number): string | undefined {
  if (!Number.isInteger(value) || Object.is(value, -0)) {
    return "expected an integer, found " + numberText(value);
  }
  if (!Number.isSafeInteger(value)) {
    return "expected an integer from -9007199254740991 to 9007199254740991, found " + numberText(value);
  }
  return undefined;
}

/**
 * Decodes a JSON integer within Number.MAX_SAFE_INTEGER. A fraction like 1.5 fails, and so
 * does -0, as in Go and Rust. A larger value fails rather than decode as a value it isn't,
 * since JSON.parse rounds it. 12.0 and 1e2 arrive as 12 and 100 and decode, where Rust and
 * Go reject that spelling.
 */
export function decodeInteger(json: unknown, path: string): number {
  if (typeof json !== "number" || !Number.isFinite(json)) return expected(path, "a number", json);
  const problem = notInteger(json);
  if (problem !== undefined) throw new DecodeError(path, problem);
  return json;
}

/** A decoder of an integer or boolean const, which accepts only want. */
export function literal<T extends number | boolean>(want: T): Decoder<T> {
  return (json, path) => {
    const value = typeof want === "boolean" ? decodeBoolean(json, path) : decodeInteger(json, path);
    if (value !== want) {
      throw new DecodeError(path, "expected " + String(want) + ", found " + String(value));
    }
    return want;
  };
}

/** The error for a string an enum doesn't list. */
function notListed(text: string, values: readonly string[]): string {
  return "unknown value " + quote(text) + ", expected one of " + values.map(quote).join(", ");
}

/** Decodes a JSON string that must be one of values. */
export function enumValue<T extends string>(json: unknown, path: string, values: readonly T[]): T {
  const text = decodeString(json, path);
  const found = values.find((value) => value === text);
  if (found === undefined) throw new DecodeError(path, notListed(text, values));
  return found;
}

/**
 * The first place inside value that is not JSON, as a path under it and the kind found there:
 * undefined, a number that is not finite, a class instance, or an array or object that holds
 * itself. Walks with a stack of its own, so deep values can't overflow the call stack.
 */
function notJson(value: unknown): { path: string; found: string } | undefined {
  type Step = { readonly value: unknown; readonly path: string } | { readonly leave: object };
  const open = new Set<object>();
  const steps: Step[] = [{ value, path: "" }];
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if ("leave" in step) {
      open.delete(step.leave);
      continue;
    }
    const current = step.value;
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) return { path: step.path, found: kind(current) };
      continue;
    }
    if (!Array.isArray(current) && !isObject(current)) return { path: step.path, found: kind(current) };
    if (open.has(current)) return { path: step.path, found: "a value that holds itself" };
    open.add(current);
    steps.push({ leave: current });
    // Pushed last to first, so the first item or key is checked first.
    if (Array.isArray(current)) {
      const items: readonly unknown[] = current;
      for (let i = items.length - 1; i >= 0; i--) steps.push({ value: items[i], path: at(step.path, i) });
    } else {
      const keys = Object.keys(current);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] ?? "";
        steps.push({ value: current[key], path: at(step.path, key) });
      }
    }
  }
  return undefined;
}

/** Decodes any JSON value, null included, and keeps it as it is. */
export function decodeAny(json: unknown, path: string): unknown {
  const problem = notJson(json);
  if (problem !== undefined) {
    throw new DecodeError(path + problem.path, "expected a JSON value, found " + problem.found);
  }
  return json;
}

/** Decodes any JSON value except null at the top. Nested values may be anything. */
export function decodeNonNull(json: unknown, path: string): NonNullable<unknown> {
  if (json === null) throw new DecodeError(path, "expected a JSON value other than null");
  return decodeAny(json, path) as NonNullable<unknown>;
}

/** A decoder of a JSON array whose items decode with item. */
export function array<T>(item: Decoder<T>): Decoder<T[]> {
  return (json, path) => {
    if (!Array.isArray(json)) return expected(path, "an array", json);
    const items: readonly unknown[] = json;
    return items.map((value, index) => item(value, at(path, index)));
  };
}

/** Checks that json is a JSON object, and returns it for reading its keys. */
export function object(json: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isObject(json)) return expected(path, "an object", json);
  return json;
}

/** Sets an own key, so a key like __proto__ is data, never the object's prototype. */
export function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** Reads a key that must be present. */
export function required<T>(
  o: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  decode: Decoder<T>,
): T {
  if (!hasOwn.call(o, key)) throw new DecodeError(path, "missing key " + quote(key));
  return decode(o[key], at(path, key));
}

/** Reads an optional key: absent gives no key, and null fails unless the type takes null. */
export function optional<K extends string, T>(
  o: Readonly<Record<string, unknown>>,
  key: K,
  path: string,
  decode: Decoder<T>,
): { [P in K]?: T } {
  const out = {};
  if (hasOwn.call(o, key)) put(out, key, decode(o[key], at(path, key)));
  return out;
}

/** Fails on the first key, in input order, that is not one of keys. */
export function closed(o: Readonly<Record<string, unknown>>, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(o)) {
    if (!keys.includes(key)) throw new DecodeError(path, "unknown key " + quote(key));
  }
}

/** Decodes the members of o not named in skip, keys with key and values with value. */
function members<K extends string, V>(
  o: Readonly<Record<string, unknown>>,
  path: string,
  skip: readonly string[],
  key: Decoder<K>,
  value: Decoder<V>,
): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const name of Object.keys(o)) {
    if (skip.includes(name)) continue;
    let decoded: K;
    try {
      decoded = key(name, path);
    } catch (error) {
      if (error instanceof DecodeError) {
        throw new DecodeError(path, "key " + quote(name) + ": " + error.reason);
      }
      throw error;
    }
    put(out, decoded, value(o[name], at(path, name)));
  }
  return out;
}

/** Reads every key not named into a map, for an object with named keys and a map of the others. */
export function rest<K extends string, V>(
  o: Readonly<Record<string, unknown>>,
  path: string,
  named: readonly string[],
  key: Decoder<K>,
  value: Decoder<V>,
): Record<K, V> {
  return members(o, path, named, key, value);
}

/** A decoder of a JSON object used as a map, keys decoding with key and values with value. */
export function map<K extends string, V>(key: Decoder<K>, value: Decoder<V>): Decoder<Record<K, V>> {
  return (json, path) => members(object(json, path), path, [], key, value);
}

/** The allowed tags of a tagged union, sorted by code point as Go lists them. */
function tagList(branches: readonly (readonly [string, unknown])[]): string {
  return branches
    .map(([tag]) => tag)
    .sort(byCodePoint)
    .join(", ");
}

/**
 * Decodes a tagged union: reads the tag key first and decodes only the branch it names.
 * A missing tag, a tag that isn't a string and a tag no branch has fail, naming the tags
 * allowed. An error inside the branch keeps its path and names the branch, like
 * type "card": missing key "last4".
 */
export function tagged<T>(
  json: unknown,
  path: string,
  key: string,
  branches: readonly (readonly [string, Decoder<T>])[],
): T {
  const o = object(json, path);
  if (!hasOwn.call(o, key)) throw new DecodeError(path, "missing key " + quote(key));
  const tag = o[key];
  if (typeof tag !== "string") throw new DecodeError(path, quote(key) + " must be a string, found " + kind(tag));
  const branch = branches.find(([name]) => name === tag);
  if (branch === undefined) {
    throw new DecodeError(path, "unknown " + key + " " + quote(tag) + ", expected one of " + tagList(branches));
  }
  try {
    return branch[1](o, path);
  } catch (error) {
    if (error instanceof DecodeError) {
      throw new DecodeError(error.path, key + " " + quote(tag) + ": " + error.reason);
    }
    throw error;
  }
}

/**
 * Decodes an untagged union: tries the variants in order, the same order as Rust and Go, and
 * returns the first that decodes. When none does, the error names the union, as Go's does.
 */
export function untagged<T>(json: unknown, path: string, name: string, variants: readonly Decoder<T>[]): T {
  for (const variant of variants) {
    try {
      return variant(json, path);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;
    }
  }
  throw new DecodeError(path, "data did not match any variant of " + name);
}

/** Runs encode on value, moving an EncodeError it throws under segment. */
function within<T>(segment: string | number, value: T, encode: Encoder<T>): unknown {
  try {
    return encode(value);
  } catch (error) {
    if (error instanceof EncodeError) throw new EncodeError(at("", segment) + error.path, error.reason);
    throw error;
  }
}

function refuse(what: string, value: unknown): never {
  throw new EncodeError("", "expected " + what + ", found " + kind(value));
}

/** Encodes a string. */
export function encodeString(value: string): unknown {
  if (typeof value !== "string") return refuse("a string", value);
  return value;
}

/** Encodes a boolean. */
export function encodeBoolean(value: boolean): unknown {
  if (typeof value !== "boolean") return refuse("a boolean", value);
  return value;
}

/** Encodes a finite number. NaN and Infinity fail, since JSON.stringify would write null. */
export function encodeNumber(value: number): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return refuse("a number", value);
  return value;
}

/**
 * Encodes an integer within Number.MAX_SAFE_INTEGER. A fraction, -0, which JSON.stringify
 * writes as 0, and a larger value, which may not be the integer meant, fail.
 */
export function encodeInteger(value: number): unknown {
  if (typeof value !== "number" || !Number.isFinite(value)) return refuse("a number", value);
  const problem = notInteger(value);
  if (problem !== undefined) throw new EncodeError("", problem);
  return value;
}

/** An encoder of an integer or boolean const, which refuses any other value. */
export function encodeLiteral<T extends number | boolean>(want: T): Encoder<T> {
  return (value) => {
    if (typeof want === "boolean") encodeBoolean(value as boolean);
    else encodeInteger(value as number);
    if (value !== want) throw new EncodeError("", "expected " + String(want) + ", found " + String(value));
    return value;
  };
}

/** Encodes a string that must be one of values, so a value cast to the type fails. */
export function encodeEnum<T extends string>(value: T, values: readonly T[]): unknown {
  encodeString(value);
  if (!values.includes(value)) throw new EncodeError("", notListed(value, values));
  return value;
}

/** Encodes any JSON value, null included. Undefined, NaN, Infinity and class instances fail. */
export function encodeAny(value: unknown): unknown {
  const problem = notJson(value);
  if (problem !== undefined) throw new EncodeError(problem.path, "expected a JSON value, found " + problem.found);
  return value;
}

/** Encodes any JSON value except null at the top. */
export function encodeNonNull(value: unknown): unknown {
  if (value === null) throw new EncodeError("", "expected a JSON value other than null");
  return encodeAny(value);
}

/** An encoder of an array whose items encode with item. */
export function encodeArray<T>(item: Encoder<T>): Encoder<readonly T[]> {
  return (value) => {
    if (!Array.isArray(value)) return refuse("an array", value);
    const items: readonly T[] = value;
    return items.map((entry, index) => within(index, entry, item));
  };
}

/** Checks that value is a plain object before an encoder reads its keys. */
export function encodeObject(value: object): void {
  if (!isObject(value)) refuse("an object", value);
}

/** Fails on the first key of value, in its order, that is not one of keys. */
export function encodeClosed(value: object, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new EncodeError("", "unknown key " + quote(key));
  }
}

/** Writes key with value encoded by encode, naming the key in an error. */
export function member<T>(out: object, key: string, value: T, encode: Encoder<T>): void {
  put(out, key, within(key, value, encode));
}

/** Copies the members of source not named in skip, keys sorted, each through key and value. */
function encodeMembers<K extends string, V>(
  out: object,
  source: object,
  skip: readonly string[],
  key: Encoder<K>,
  value: Encoder<V>,
): void {
  const values = source as Readonly<Record<string, V>>;
  const names = Object.keys(source).filter((name) => !skip.includes(name));
  for (const name of names.sort(byCodePoint)) {
    try {
      key(name as K);
    } catch (error) {
      if (error instanceof EncodeError) throw new EncodeError("", "key " + quote(name) + ": " + error.reason);
      throw error;
    }
    member(out, name, values[name] as V, value);
  }
}

/** Writes the keys of value other than named, sorted, after the named keys already in out. */
export function putRest<K extends string, V>(
  out: object,
  value: object,
  named: readonly string[],
  key: Encoder<K>,
  encode: Encoder<V>,
): void {
  encodeMembers(out, value, named, key, encode);
}

/** An encoder of a map, keys sorted by code point, keys through key and values through value. */
export function encodeMap<K extends string, V>(
  key: Encoder<K>,
  value: Encoder<V>,
): Encoder<Readonly<Partial<Record<K, V>>>> {
  return (source) => {
    encodeObject(source);
    const out = {};
    encodeMembers(out, source, [], key, value);
    return out;
  };
}

/**
 * Encodes a tagged union with the branch its tag key names. A value whose tag no branch has,
 * which only a cast can make, fails, naming the tags allowed.
 */
export function encodeTagged(
  value: object,
  key: string,
  branches: readonly (readonly [string, Encoder<never>])[],
): unknown {
  encodeObject(value);
  const tag: unknown = hasOwn.call(value, key) ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
  if (tag === undefined) throw new EncodeError("", "missing key " + quote(key));
  if (typeof tag !== "string") throw new EncodeError("", quote(key) + " must be a string, found " + kind(tag));
  const branch = branches.find(([name]) => name === tag);
  if (branch === undefined) {
    throw new EncodeError("", "unknown " + key + " " + quote(tag) + ", expected one of " + tagList(branches));
  }
  try {
    return branch[1](value as never);
  } catch (error) {
    if (error instanceof EncodeError) {
      throw new EncodeError(error.path, key + " " + quote(tag) + ": " + error.reason);
    }
    throw error;
  }
}

/**
 * Encodes an untagged union with the first variant, in decode order, whose encoder takes the
 * value. A value no variant takes fails.
 */
export function encodeUntagged(value: unknown, name: string, variants: readonly Encoder<never>[]): unknown {
  for (const variant of variants) {
    try {
      return variant(value as never);
    } catch (error) {
      if (!(error instanceof EncodeError)) throw error;
    }
  }
  throw new EncodeError("", "value did not match any variant of " + name);
}
`;
