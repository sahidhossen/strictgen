/**
 * RFC 8785, the JSON Canonicalization Scheme: one spelling for every JSON value, so the bytes
 * Rust, Go and TypeScript encode can be compared exactly. Object keys are sorted by their UTF-16
 * code units, numbers are written the way ECMAScript writes a double, strings escape only what
 * JSON requires, and there is no whitespace.
 *
 * The reader is strict: it takes RFC 8259 JSON only, and refuses what I-JSON (RFC 7493), which
 * RFC 8785 builds on, refuses: a key given twice, a lone surrogate, and a number a double can't
 * hold.
 */

/** Text the canonicaliser can't read, or a value it can't write. */
export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

/** A number, kept as it was spelled, so writing it can decide how exact to be. */
export class JsonNumber {
  constructor(readonly raw: string) {}
}

/** A parsed JSON value. Objects keep their keys in input order. */
export type Json = null | boolean | string | JsonNumber | Json[] | Map<string, Json>;

export interface CanonicalOptions {
  /**
   * Writes an integer past 2^53 - 1, spelled without a fraction or exponent, with its exact
   * digits instead of rounding it to a double first. RFC 8785 rounds it. The conformance runner
   * turns this on, so two languages that write different 64-bit integers never compare equal
   * because both round to the same double.
   */
  readonly exactIntegers?: boolean;
}

/** Arrays and objects a value may sit inside, so deep input fails cleanly, not with a stack overflow. */
const MAX_DEPTH = 512;

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

/** Reads RFC 8259 JSON text, refusing duplicate keys and lone surrogates. */
export function parseJson(text: string): Json {
  let at = 0;
  const fail = (what: string): never => {
    throw new CanonicalError(`${what} at offset ${String(at)}`);
  };
  const space = (): void => {
    while (at < text.length) {
      const c = text.charCodeAt(at);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      at++;
    }
  };
  const literal = (word: string, value: Json): Json => {
    if (!text.startsWith(word, at)) fail("an invalid value");
    at += word.length;
    return value;
  };
  const hex4 = (): number => {
    const digits = text.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail("an invalid \\u escape");
    at += 4;
    return Number.parseInt(digits, 16);
  };
  const str = (): string => {
    at++; // the opening quote
    let out = "";
    for (;;) {
      if (at >= text.length) fail("an unterminated string");
      const c = text.charCodeAt(at);
      if (c === 0x22) {
        at++;
        return out;
      }
      if (c < 0x20) fail("a control character in a string");
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = text.charCodeAt(at + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("a lone surrogate");
        out += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) fail("a lone surrogate");
      if (c !== 0x5c) {
        out += text[at];
        at++;
        continue;
      }
      at++; // the backslash
      const e = text[at];
      at++;
      switch (e) {
        case '"':
        case "\\":
        case "/":
          out += e;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const unit = hex4();
          if (unit >= 0xdc00 && unit <= 0xdfff) fail("a lone surrogate");
          if (unit >= 0xd800 && unit <= 0xdbff) {
            if (text.slice(at, at + 2) !== "\\u") fail("a lone surrogate");
            at += 2;
            const low = hex4();
            if (!(low >= 0xdc00 && low <= 0xdfff)) fail("a lone surrogate");
            out += String.fromCharCode(unit, low);
          } else {
            out += String.fromCharCode(unit);
          }
          break;
        }
        default:
          at--;
          fail("an invalid escape");
      }
    }
  };
  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) fail("a value nested too deep");
    space();
    const c = text[at];
    if (c === "{") {
      at++;
      const object = new Map<string, Json>();
      space();
      if (text[at] === "}") {
        at++;
        return object;
      }
      for (;;) {
        space();
        if (text[at] !== '"') fail("a missing key");
        const keyAt = at;
        const key = str();
        if (object.has(key)) {
          at = keyAt;
          fail("a duplicate key");
        }
        space();
        if (text[at] !== ":") fail("a missing colon");
        at++;
        object.set(key, value(depth + 1));
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at] === "}") {
          at++;
          return object;
        }
        fail("a missing comma or closing brace");
      }
    }
    if (c === "[") {
      at++;
      const array: Json[] = [];
      space();
      if (text[at] === "]") {
        at++;
        return array;
      }
      for (;;) {
        array.push(value(depth + 1));
        space();
        if (text[at] === ",") {
          at++;
          continue;
        }
        if (text[at] === "]") {
          at++;
          return array;
        }
        fail("a missing comma or closing bracket");
      }
    }
    if (c === '"') return str();
    if (c === "t") return literal("true", true);
    if (c === "f") return literal("false", false);
    if (c === "n") return literal("null", null);
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(text);
    if (match === null) return fail("an invalid value");
    at += match[0].length;
    return new JsonNumber(match[0]);
  };
  const result = value(0);
  space();
  if (at !== text.length) fail("data after the value");
  return result;
}

/**
 * Writes a double the way RFC 8785 says, which is ECMAScript's Number.prototype.toString:
 * the shortest digits that read back as the same double, -0 as 0. NaN and the infinities have no
 * JSON form.
 */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalError(`${String(value)} has no JSON form`);
  // String(-0) is already "0", as RFC 8785 asks.
  return String(value);
}

function numberText(n: JsonNumber, options: CanonicalOptions): string {
  const value = Number(n.raw);
  if (!Number.isFinite(value)) throw new CanonicalError(`the number ${n.raw} is out of range for a double`);
  if (options.exactIntegers === true && INTEGER.test(n.raw) && !Number.isSafeInteger(value)) {
    return BigInt(n.raw).toString();
  }
  return canonicalNumber(value);
}

/** Writes a string the way RFC 8785 says: only `"`, `\` and control characters are escaped. */
export function canonicalString(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalError("a lone surrogate has no JSON form");
      out += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) throw new CanonicalError("a lone surrogate has no JSON form");
    switch (c) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        out += c < 0x20 ? `\\u${c.toString(16).padStart(4, "0")}` : text[i];
    }
  }
  return `${out}"`;
}

/** Orders two strings by their UTF-16 code units, as RFC 8785 sorts keys. */
export function compareUtf16(a: string, b: string): number {
  // JavaScript compares strings by UTF-16 code units, which is the order RFC 8785 asks for.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Writes a parsed value in canonical form. */
export function serialize(value: Json, options: CanonicalOptions = {}): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return canonicalString(value);
  if (value instanceof JsonNumber) return numberText(value, options);
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v, options)).join(",")}]`;
  const keys = [...value.keys()].sort(compareUtf16);
  return `{${keys.map((k) => `${canonicalString(k)}:${serialize(value.get(k) ?? null, options)}`).join(",")}}`;
}

/** The canonical form of JSON text. */
export function canonicalize(text: string, options: CanonicalOptions = {}): string {
  return serialize(parseJson(text), options);
}

/** Splits a JSON Pointer into its unescaped segments. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new CanonicalError(`${pointer} is not a JSON Pointer`);
  return pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * A copy of `value` without the object members the pointers name, like the unknown keys a
 * report-mode decode left out. Fails when a pointer names nothing.
 */
export function withoutMembers(value: Json, pointers: readonly string[]): Json {
  const copy = (v: Json): Json =>
    Array.isArray(v) ? v.map(copy) : v instanceof Map ? new Map([...v].map(([k, x]) => [k, copy(x)])) : v;
  const out = copy(value);
  for (const pointer of pointers) {
    const segments = pointerSegments(pointer);
    const key = segments.pop();
    if (key === undefined) throw new CanonicalError("the empty pointer names the whole value, not a member");
    let holder: Json = out;
    for (const segment of segments) {
      const next: Json | undefined = Array.isArray(holder)
        ? /^(?:0|[1-9][0-9]*)$/.test(segment)
          ? holder[Number(segment)]
          : undefined
        : holder instanceof Map
          ? holder.get(segment)
          : undefined;
      if (next === undefined) throw new CanonicalError(`${pointer} names no member`);
      holder = next;
    }
    if (!(holder instanceof Map) || !holder.delete(key)) throw new CanonicalError(`${pointer} names no member`);
  }
  return out;
}
