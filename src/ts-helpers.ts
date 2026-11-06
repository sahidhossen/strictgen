import { codeName, ERROR_CODES, FOUND_MAX, MAX_DEPTH } from "./errors.js";

/** The ErrorCode constants, one per code, with their doc comments. */
const CODE_CONSTANTS = ERROR_CODES.map(
  (c) => `  /** ${c.doc.charAt(0).toUpperCase()}${c.doc.slice(1)}. */\n  ${codeName(c.code, false)}: "${c.code}",\n`,
).join("");

/** The title of each code in messages. */
const CODE_TITLES = ERROR_CODES.map((c) => `  ${c.code}: "${c.title}",\n`).join("");

/** The paragraph of the helpers' doc comment on unknown keys in report mode. */
const REPORT_DOC = String.raw`
 * This output reads in report mode: an unknown key is accepted rather than an error. Every
 * decode collects the JSON Pointers of the unknown keys, in the order they appear in the input,
 * gives them to the hook set with setUnknownKeyHook, and the report functions return them with
 * the value. Only the branch of an untagged union that decoded reports its keys. A key that a
 * sibling branch of an exactly-one union names still fails.
 *`;

/**
 * The report mode section of `helpers.ts`: the unknown key hook, the collector of one decode,
 * and the functions that run a whole decode and sort its unknown keys into input order.
 */
const REPORT_SECTION = String.raw`
/** A decoded value and the paths of the unknown keys its input had. */
export interface Reported<T> {
  /** The decoded value, which leaves the unknown keys out. */
  readonly value: T;
  /** The JSON Pointer of each unknown key, like /customer/nickname, in the order the keys appear in the input. */
  readonly unknown: readonly string[];
}

/** Receives the paths of the unknown keys of one decode, in input order. */
export type UnknownKeyHook = (paths: readonly string[]) => void;

/** The hook setUnknownKeyHook set. */
let hook: UnknownKeyHook | undefined;

/**
 * Sets the one hook every decode calls with the paths of the unknown keys it accepted, for
 * logging or counting them in one place. A decode calls it after the value decoded, only when
 * there is at least one unknown key, and before it returns. undefined removes it.
 */
export function setUnknownKeyHook(next: UnknownKeyHook | undefined): void {
  hook = next;
}

/** While a decode runs: the paths of the unknown keys it accepted so far, in decode order. */
let unknown: string[] | undefined;

/**
 * Runs read as a whole decode, or as part of the decode already running, so the unknown keys
 * of nested values reach the decode that started.
 */
export function report<T>(json: unknown, path: string, read: Decoder<T>): T {
  if (unknown !== undefined) return read(json, path);
  return reported(json, path, read).value;
}

/** Runs read as a whole decode, calls the hook, and returns the value with its unknown key paths. */
export function reported<T>(json: unknown, path: string, read: Decoder<T>): Reported<T> {
  const saved = unknown;
  const found: string[] = [];
  unknown = found;
  let value: T;
  try {
    value = read(json, path);
  } finally {
    unknown = saved;
  }
  const paths = inputOrder(json, path, found);
  if (paths.length > 0) hook?.([...paths]);
  return { value, unknown: paths };
}

/** Reads JSON text strictly, then decodes it with read like reported. */
export function reportFromJson<T>(text: string, read: Decoder<T>): Reported<T> {
  return fromJson(text, (json, path) => reported(json, path, read));
}

/**
 * Sorts the paths of unknown keys into input order: a depth first walk of json, the keys of
 * each object in their order, which for text read by fromJson is the order the keys appear in
 * it, as in Rust and Go. Each path is under base, as the decoders build it. The decoders read
 * every object on a path, so a value that throws when read again is left in decode order.
 */
function inputOrder(json: unknown, base: string, paths: readonly string[]): string[] {
  if (paths.length < 2) return [...paths];
  const indexes = new Map<object, ReadonlyMap<string, number>>();
  const position = (path: string): number[] => {
    const out: number[] = [];
    let current: unknown = json;
    for (const raw of path.slice(base.length + 1).split("/")) {
      const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      const holder = current as Readonly<Record<string, unknown>>;
      if (Array.isArray(holder)) {
        out.push(Number(segment));
      } else {
        let index = indexes.get(holder);
        if (index === undefined) {
          index = new Map(keysOf(holder).map((key, i) => [key, i]));
          indexes.set(holder, index);
        }
        out.push(index.get(segment) ?? -1);
      }
      current = holder[segment];
    }
    return out;
  };
  try {
    const keyed = paths.map((path) => ({ path, at: position(path) }));
    keyed.sort((a, b) => {
      for (let i = 0; i < a.at.length && i < b.at.length; i++) {
        const x = a.at[i] ?? 0;
        const y = b.at[i] ?? 0;
        if (x !== y) return x - y;
      }
      return a.at.length - b.at.length;
    });
    return keyed.map((k) => k.path);
  } catch {
    return [...paths];
  }
}
`;

/** closed in strict mode: any key the type doesn't name fails. */
/** In report mode, untagged notes how many unknown keys there were before trying a variant. */
const UNTAGGED_MARK = String.raw`
    const mark = unknown?.length ?? 0;`;

/** In report mode, untagged drops the unknown keys of a variant that failed. */
const UNTAGGED_ROLLBACK = String.raw`
      if (unknown !== undefined) unknown.length = mark;`;

const CLOSED_STRICT = String.raw`/** Fails on the first key, in input order, that is not one of keys, at that key's path. */
export function closed(o: Readonly<Record<string, unknown>>, path: string, keys: readonly string[]): void {
  for (const key of guard(path, () => keysOf(o))) {
    if (!keys.includes(key)) throw new DecodeError(at(path, key), ErrorCode.UnknownKey);
  }
}`;

/** closed in report mode: a key the type doesn't name is noted, unless a sibling branch names it. */
const CLOSED_REPORT = String.raw`/**
 * Notes each key, in input order, that is not one of keys as unknown, at that key's path. A key
 * in forbidden, which a sibling branch of an exactly-one union names, still fails with
 * unknown_key, and so does any unknown key outside a decode that collects them.
 */
export function closed(
  o: Readonly<Record<string, unknown>>,
  path: string,
  keys: readonly string[],
  forbidden: readonly string[] = [],
): void {
  for (const key of guard(path, () => keysOf(o))) {
    if (keys.includes(key)) continue;
    if (unknown === undefined || forbidden.includes(key)) {
      throw new DecodeError(at(path, key), ErrorCode.UnknownKey);
    }
    unknown.push(at(path, key));
  }
}`;

/**
 * The body of the generated `helpers.ts`, which every generated TypeScript file imports as
 * `h`. It has no imports itself, so the output needs no package to install. It is a raw
 * template, so backslashes stand for themselves. `report` adds what report mode needs.
 */
export function tsHelpersBody(report: boolean): string {
  return String.raw`/**
 * Helpers the generated decoders and encoders share.
 *
 * Decoders read a value that is already parsed, like the result of JSON.parse, and check it
 * strictly: unknown keys, missing required keys, null for an optional key and values of the
 * wrong type fail with a DecodeError at the JSON Pointer of the first problem, with the same
 * code and message as in Rust and Go.
 *${report ? REPORT_DOC : ""}
 * The FromJson decoders read JSON text with the strict reader below instead of JSON.parse, so
 * they reject what Rust and Go reject in the text itself: a key given twice, data after the
 * value, a lone surrogate, nesting past MAX_DEPTH and, for an integer, a spelling like 12.0 or
 * 1e2. They also keep the order of an object's keys, which a JavaScript object doesn't for
 * keys like "1", so the first unknown key is the one Go reports.
 *
 * Encoders check the value as strictly before they write it, and throw an EncodeError for one
 * that Rust and Go could not hold or that would not decode again: an unknown key, a missing
 * required key, an enum value the type doesn't list, NaN or Infinity, and for integers -0, a
 * fraction or a value past Number.MAX_SAFE_INTEGER. The ToJson encoders write the keys in the
 * order Rust and Go write them, which JSON.stringify can't for keys like "1".
 *
 * Numbers: a parsed JavaScript number keeps neither its JSON spelling nor values past 2^53.
 * An integer decodes only when it is a whole number within Number.MAX_SAFE_INTEGER, and not
 * -0, so a value that lost precision fails instead of decoding as a different number. From a
 * parsed value, where the spelling is gone, 12.0 and 1e2 decode as the integers 12 and 100,
 * which Rust and Go reject; the FromJson decoders reject them. A number re-encodes as
 * JavaScript spells it: 12.0 as 12 and -0 as 0.
 */

/** The error codes. Codes are public API: changing one is a major version. */
export const ErrorCode = {
${CODE_CONSTANTS}} as const;

/** One of the error codes. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** The words for each code in a message. */
const TITLES: { readonly [C in ErrorCode]: string } = {
${CODE_TITLES}};

/** A message: the path, the title or code, then expected and found when they are given. */
function describe(path: string, head: string, gap: string, expected?: string, found?: string): string {
  let text = path === "" ? head : path + gap + head;
  if (expected !== undefined) text += ", expected " + expected;
  if (found !== undefined) text += ", found " + found;
  return text;
}

/**
 * A value that doesn't fit its generated type, or text that isn't JSON. Rust and Go report
 * the same path, code, expected and found for the same input, and the same message.
 */
export class DecodeError extends Error {
  /** JSON Pointer to the value that failed, like /items/0/price, or "" for the whole input. */
  readonly path: string;
  /** What failed, like missing_key. */
  readonly code: ErrorCode;
  /** What the type takes there, like "a string", when the code has one. */
  readonly expected: string | undefined;
  /** What the input has there, like 12.5 or "x", when the code has one. */
  readonly found: string | undefined;

  constructor(path: string, code: ErrorCode, expected?: string, found?: string) {
    super(describe(path, TITLES[code], ": ", expected, found));
    this.name = "DecodeError";
    this.path = path;
    this.code = code;
    this.expected = expected;
    this.found = found;
  }

  /** The one-line form, made for logs and for asking an LLM to retry, like /a/0 wrong_type, expected a string, found 1. */
  compact(): string {
    return describe(this.path, this.code, " ", this.expected, this.found);
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

/**
 * The deepest nesting the strict reader takes: a value inside MAX_DEPTH or more arrays and
 * objects fails, as in Rust (serde_json's recursion limit) and Go, so reading and decoding stay
 * bounded however deep the input.
 */
const MAX_DEPTH = ${String(MAX_DEPTH)};

/** Strings in found are cut to this many code points, then "...". */
const FOUND_MAX = ${String(FOUND_MAX)};

/**
 * While fromJson decodes: the spelling of each number that JavaScript would write another
 * way, like 12.0, 1e2 or -0, by JSON Pointer. decodeInteger rejects a fraction or exponent
 * spelling as Rust and Go do, and errors show a number as it was spelled.
 */
let spellings: ReadonlyMap<string, string> | undefined;

/**
 * The order of the keys of objects the strict reader and the encoders made, since a
 * JavaScript object lists keys like "1" first. Decoders read keys in this order, and toJson
 * writes them in it.
 */
const ORDER = new WeakMap<object, string[]>();

/** Reads JSON text strictly with the reader below, then decodes it with decode. */
export function fromJson<T>(text: string, decode: Decoder<T>): T {
  if (typeof text !== "string") throw mismatch("", "JSON text", text);
  const reader = new Reader(text);
  const json = reader.document();
  const saved = spellings;
  spellings = reader.spellings;
  try {
    return decode(json, "");
  } finally {
    spellings = saved;
  }
}

/** Like fromJson, but returns the DecodeError instead of throwing it. */
export function attemptJson<T>(decode: Decoder<T>, text: string): DecodeResult<T> {
  try {
    return { ok: true, value: fromJson(text, decode) };
  } catch (error) {
    if (error instanceof DecodeError) return { ok: false, error };
    throw error;
  }
}
${report ? REPORT_SECTION : ""}
/** The values of the escapes other than \u. */
const ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

function isHigh(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLow(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/**
 * Reads JSON text the way the Rust and Go decoders do: the strict JSON grammar, no lone
 * surrogates, finite numbers, no key given twice in an object, nothing after the value, and at
 * most MAX_DEPTH - 1 nested arrays and objects. A failure is a DecodeError with the code
 * invalid_json, duplicate_key or too_deep, at the JSON Pointer of the value being read, and
 * found gives the offset in UTF-8 bytes, like: invalid JSON, found trailing characters at
 * offset 12.
 *
 * Text is already decoded, so invalid UTF-8 can only show as a lone surrogate. Decode bytes
 * with new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }) to reject the rest. Without
 * ignoreBOM, the decoder drops a leading byte order mark, which Rust and Go reject.
 */
class Reader {
  /** Numbers JavaScript would spell another way, by JSON Pointer. */
  readonly spellings = new Map<string, string>();
  private readonly text: string;
  private pos = 0;
  /** The keys and indexes of the values being read, for the JSON Pointer of a failure. */
  private readonly segments: (string | number)[] = [];

  constructor(text: string) {
    this.text = text;
  }

  /** Reads a whole document: one value, then only white space. */
  document(): unknown {
    for (let i = 0; i < this.text.length; i++) {
      const unit = this.text.charCodeAt(i);
      if (isHigh(unit) && isLow(this.text.charCodeAt(i + 1))) i++;
      else if (isHigh(unit) || isLow(unit)) throw this.fail("invalid UTF-8", i);
    }
    const value = this.value(0);
    this.space();
    if (this.pos !== this.text.length) throw this.fail("trailing characters");
    return value;
  }

  /** The offset of a position in UTF-16 units, in UTF-8 bytes. */
  private offset(at: number): string {
    let bytes = 0;
    for (let i = 0; i < at; i++) {
      const unit = this.text.charCodeAt(i);
      if (unit < 0x80) bytes += 1;
      else if (unit < 0x800) bytes += 2;
      else if (isHigh(unit) && isLow(this.text.charCodeAt(i + 1))) {
        bytes += 4;
        i++;
      } else bytes += 3;
    }
    return " at offset " + String(bytes);
  }

  /** An invalid_json failure, what was found at the offset in UTF-16 units at. */
  private fail(what: string, at = this.pos): DecodeError {
    return new DecodeError(this.pointer(), ErrorCode.InvalidJson, undefined, what + this.offset(at));
  }

  private pointer(): string {
    let path = "";
    for (const segment of this.segments) path = at(path, segment);
    return path;
  }

  private space(): void {
    for (;;) {
      const c = this.text[this.pos];
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return;
      this.pos++;
    }
  }

  /** Consumes c if it comes next. */
  private accept(c: string): boolean {
    if (this.text[this.pos] !== c) return false;
    this.pos++;
    return true;
  }

  /** Reads one value inside depth arrays and objects. */
  private value(depth: number): unknown {
    this.space();
    const c = this.text[this.pos];
    switch (c) {
      case undefined:
        throw this.fail("an unexpected end of input");
      case "{":
      case "[":
        if (depth + 1 >= MAX_DEPTH) {
          throw new DecodeError(
            this.pointer(),
            ErrorCode.TooDeep,
            "at most " + String(MAX_DEPTH - 1) + " nested arrays and objects",
            "more" + this.offset(this.pos),
          );
        }
        return c === "{" ? this.object(depth + 1) : this.array(depth + 1);
      case '"':
        return this.string();
      case "t":
        return this.word("true", true);
      case "f":
        return this.word("false", false);
      case "n":
        return this.word("null", null);
      default:
        return this.number();
    }
  }

  /** Reads true, false or null, failing at the first character that differs. */
  private word<T>(word: string, value: T): T {
    for (const c of word) {
      if (this.text[this.pos] !== c) throw this.fail("an invalid literal");
      this.pos++;
    }
    return value;
  }

  private object(depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const order: string[] = [];
    ORDER.set(out, order);
    this.pos++;
    this.space();
    if (this.accept("}")) return out;
    for (;;) {
      this.space();
      if (this.text[this.pos] !== '"') throw this.fail("a missing key");
      const keyAt = this.pos;
      const key = this.string();
      if (hasOwn.call(out, key)) {
        throw new DecodeError(at(this.pointer(), key), ErrorCode.DuplicateKey, undefined, quote(key) + this.offset(keyAt));
      }
      this.space();
      if (!this.accept(":")) throw this.fail("a missing colon");
      this.segments.push(key);
      const value = this.value(depth);
      this.segments.pop();
      if (key === "__proto__") Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
      else out[key] = value;
      order.push(key);
      this.space();
      if (this.accept("}")) return out;
      if (!this.accept(",")) throw this.fail("a missing comma or closing brace");
    }
  }

  private array(depth: number): unknown[] {
    const out: unknown[] = [];
    this.pos++;
    this.space();
    if (this.accept("]")) return out;
    for (;;) {
      this.segments.push(out.length);
      out.push(this.value(depth));
      this.segments.pop();
      this.space();
      if (this.accept("]")) return out;
      if (!this.accept(",")) throw this.fail("a missing comma or closing bracket");
    }
  }

  /** Reads a string, rejecting control characters, bad escapes and lone surrogates. */
  private string(): string {
    this.pos++;
    let out = "";
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) throw this.fail("an unterminated string");
      const unit = this.text.charCodeAt(this.pos);
      if (unit === 0x22) {
        out += this.text.slice(chunk, this.pos);
        this.pos++;
        return out;
      }
      if (unit === 0x5c) {
        out += this.text.slice(chunk, this.pos) + this.escape();
        chunk = this.pos;
      } else if (unit < 0x20) {
        throw this.fail("a control character in a string");
      } else {
        this.pos++;
      }
    }
  }

  /**
   * Reads one escape at the backslash. A \u escape of a high surrogate must be followed by one
   * of a low surrogate, and a low surrogate can't stand alone. A bad escape or hex digit fails
   * at that character, and a surrogate that isn't half of a pair fails at the backslash.
   */
  private escape(): string {
    const start = this.pos;
    this.pos++;
    const simple = ESCAPES.get(this.text[this.pos] ?? "");
    if (simple !== undefined) {
      this.pos++;
      return simple;
    }
    if (!this.accept("u")) throw this.fail("an invalid escape");
    const unit = this.hex4();
    if (isLow(unit)) throw this.fail("a lone surrogate", start);
    if (!isHigh(unit)) return String.fromCharCode(unit);
    if (this.text[this.pos] !== "\\" || this.text[this.pos + 1] !== "u") {
      throw this.fail("a lone surrogate", start);
    }
    this.pos += 2;
    const low = this.hex4();
    if (!isLow(low)) throw this.fail("a lone surrogate", start);
    return String.fromCharCode(unit, low);
  }

  /** Reads the four hex digits of a \u escape, failing at the first that isn't one. */
  private hex4(): number {
    let unit = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.text[this.pos] ?? "";
      if (!/^[0-9a-fA-F]$/.test(c)) throw this.fail("an invalid escape");
      unit = unit * 16 + parseInt(c, 16);
      this.pos++;
    }
    return unit;
  }

  /** Digits read, as a count. */
  private digits(): number {
    const start = this.pos;
    while (isDigit(this.text[this.pos])) this.pos++;
    return this.pos - start;
  }

  /**
   * Reads a number in the JSON grammar that is finite as a float64. One JavaScript would spell
   * another way, like 12.0 or -0, is noted in spellings.
   */
  private number(): number {
    const start = this.pos;
    this.accept("-");
    if (this.accept("0")) {
      if (isDigit(this.text[this.pos])) throw this.fail("a leading zero");
    } else if (this.digits() === 0) {
      throw this.fail("an invalid value");
    }
    if (this.accept(".") && this.digits() === 0) throw this.fail("an invalid number");
    if (this.accept("e") || this.accept("E")) {
      if (!this.accept("+")) this.accept("-");
      if (this.digits() === 0) throw this.fail("an invalid number");
    }
    const raw = this.text.slice(start, this.pos);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw this.fail("a number out of range", start);
    if (numberText(value) !== raw || Object.is(value, -0)) this.spellings.set(this.pointer(), raw);
    return value;
  }
}

/** The path of a key or an index under path, escaped as a JSON Pointer segment. */
export function at(path: string, segment: string | number): string {
  return path + "/" + String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

const hasOwn = Object.prototype.hasOwnProperty;

/** True for an object as JSON.parse makes it: not an array, a class instance or null. */
function isObject(json: unknown): json is Record<string, unknown> {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return false;
  const proto: unknown = Object.getPrototypeOf(json);
  return proto === Object.prototype || proto === null;
}

/** The own keys of an object, in the order the reader or an encoder gave them when it made it. */
function keysOf(o: object): string[] {
  const own = Object.keys(o);
  const order = ORDER.get(o);
  if (order === undefined) return own;
  const listed = new Set(order);
  return [...order.filter((key) => hasOwn.call(o, key)), ...own.filter((key) => !listed.has(key))];
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

/** A code point as \u and four hex digits. */
function hex(code: number): string {
  return "\\u" + code.toString(16).padStart(4, "0");
}

/**
 * A string as found shows it, the same in every language: in double quotes, with " and \
 * escaped by a backslash and control characters (U+0000 to U+001F, U+007F to U+009F), U+2028,
 * U+2029 and lone surrogates as \u and four hex digits. A string of more than FOUND_MAX code
 * points shows its first FOUND_MAX, then ... after the quote.
 */
export function quote(text: string): string {
  let out = '"';
  let count = 0;
  for (const c of text) {
    if (count === FOUND_MAX) return out + '"...';
    count++;
    const code = c.codePointAt(0) ?? 0;
    if (c === '"' || c === "\\") out += "\\" + c;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) out += hex(code);
    else if (code >= 0xd800 && code <= 0xdfff) out += hex(code);
    else out += c;
  }
  return out + '"';
}

/** A number as written in errors, with -0 kept. */
function numberText(value: number): string {
  return Object.is(value, -0) ? "-0" : String(value);
}

/**
 * A value as found shows it: null, true and false, a number as spelled in the text when it
 * came from fromJson, a string quoted, "an array" and "an object".
 */
function found(json: unknown, path: string): string {
  if (typeof json === "string") return quote(json);
  if (typeof json === "boolean") return String(json);
  if (typeof json === "number" && Number.isFinite(json)) return spellings?.get(path) ?? numberText(json);
  return kind(json);
}

/** A value that is not what expected names: null_not_allowed for null, else wrong_type. */
function mismatch(path: string, expected: string, json: unknown): DecodeError {
  if (json === null) return new DecodeError(path, ErrorCode.NullNotAllowed, expected);
  return new DecodeError(path, ErrorCode.WrongType, expected, found(json, path));
}

/** The error for a value whose reading throws, like a getter or a revoked Proxy. */
function unreadable(path: string): DecodeError {
  return new DecodeError(path, ErrorCode.WrongType, "a JSON value", "a value that throws when read");
}

/** Runs read, turning anything it throws but a DecodeError into one at path. */
function guard<T>(path: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw unreadable(path);
  }
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

/** Decodes a JSON string. */
export function decodeString(json: unknown, path: string): string {
  if (typeof json !== "string") throw mismatch(path, "a string", json);
  return json;
}

/** Decodes a JSON boolean. */
export function decodeBoolean(json: unknown, path: string): boolean {
  if (typeof json !== "boolean") throw mismatch(path, "a boolean", json);
  return json;
}

/** Decodes a finite JSON number. It re-encodes as JavaScript spells it, so 12.0 becomes 12. */
export function decodeNumber(json: unknown, path: string): number {
  if (typeof json !== "number" || !Number.isFinite(json)) throw mismatch(path, "a number", json);
  return json;
}

/** The range of integers TypeScript holds exactly. */
const SAFE_RANGE = "an integer from -9007199254740991 to 9007199254740991";

/** Why a number is not an integer Rust and Go hold the same way, or undefined when it is one. */
function notInteger(value: number): string | undefined {
  if (!Number.isInteger(value) || Object.is(value, -0)) {
    return "expected an integer, found " + numberText(value);
  }
  if (!Number.isSafeInteger(value)) return "expected " + SAFE_RANGE + ", found " + numberText(value);
  return undefined;
}

/**
 * Decodes a JSON integer within Number.MAX_SAFE_INTEGER. A fraction like 1.5 fails, and so
 * does -0, as in Go and Rust. A larger value fails with out_of_range_integer rather than decode
 * as a value it isn't, since JSON.parse rounds it. Read from text, 12.0 and 1e2 fail as in Rust
 * and Go; parsed by JSON.parse, they arrive as 12 and 100 and decode.
 */
export function decodeInteger(json: unknown, path: string): number {
  if (typeof json !== "number" || !Number.isFinite(json)) throw mismatch(path, "an integer", json);
  const spelled = spellings?.get(path);
  const fraction = spelled !== undefined && /[.eE]/.test(spelled);
  if (fraction || !Number.isInteger(json) || Object.is(json, -0)) {
    throw new DecodeError(path, ErrorCode.WrongType, "an integer", found(json, path));
  }
  if (!Number.isSafeInteger(json)) {
    throw new DecodeError(path, ErrorCode.OutOfRangeInteger, SAFE_RANGE, found(json, path));
  }
  return json;
}

/**
 * A decoder of a string typed as a family of strings by its pattern, like order. followed by
 * any text. It checks that the value is a string; the pattern itself is not checked yet.
 */
export function family<T extends string>(): Decoder<T> {
  return decodeString as Decoder<T>;
}

/** A decoder of an integer or boolean const, which accepts only want. */
export function literal<T extends number | boolean>(want: T): Decoder<T> {
  return (json, path) => {
    const value = typeof want === "boolean" ? decodeBoolean(json, path) : decodeInteger(json, path);
    if (value !== want) throw new DecodeError(path, ErrorCode.NotConst, String(want), found(json, path));
    return want;
  };
}

/** The values an enum or a tagged union takes, quoted, in the schema's order. */
function oneOf(values: readonly string[]): string {
  return "one of " + values.map(quote).join(", ");
}

/** The error for a string an enum doesn't list, as an encoder reports it. */
function notListed(text: string, values: readonly string[]): string {
  return "unknown value " + quote(text) + ", expected " + oneOf(values);
}

/**
 * Decodes a JSON string that must be one of values. A string not listed fails with
 * not_in_enum, expected naming the values in the schema's order, or with not_const for an
 * enum of one value.
 */
export function enumValue<T extends string>(json: unknown, path: string, values: readonly T[]): T {
  const text = decodeString(json, path);
  const match = values.find((value) => value === text);
  if (match !== undefined) return match;
  if (values.length === 1) throw new DecodeError(path, ErrorCode.NotConst, quote(values[0] ?? ""), quote(text));
  throw new DecodeError(path, ErrorCode.NotInEnum, oneOf(values), quote(text));
}

/**
 * The first place inside value that is not JSON, as a path under it and the kind found there:
 * undefined, a number that is not finite, a class instance, an array or object that holds
 * itself, or one whose reading throws, like a getter or a revoked Proxy. Walks with a stack of
 * its own, so deep values can't overflow the call stack.
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
    try {
      if (!Array.isArray(current) && !isObject(current)) return { path: step.path, found: kind(current) };
      if (open.has(current)) return { path: step.path, found: "a value that holds itself" };
      const holder = current as Readonly<Record<string, unknown>>;
      const keys = Array.isArray(current) ? undefined : keysOf(current);
      const count = keys === undefined ? (current as readonly unknown[]).length : keys.length;
      open.add(current);
      steps.push({ leave: current });
      // Pushed last to first, so the first item or key is checked first.
      for (let i = count - 1; i >= 0; i--) {
        const key = keys === undefined ? i : (keys[i] ?? "");
        const path = at(step.path, key);
        try {
          steps.push({ value: holder[key], path });
        } catch {
          return { path, found: "a value that throws when read" };
        }
      }
    } catch {
      return { path: step.path, found: "a value that throws when read" };
    }
  }
  return undefined;
}

/** Decodes any JSON value, null included, and keeps it as it is. */
export function decodeAny(json: unknown, path: string): unknown {
  const problem = notJson(json);
  if (problem !== undefined) {
    throw new DecodeError(path + problem.path, ErrorCode.WrongType, "a JSON value", problem.found);
  }
  return json;
}

/** Decodes any JSON value except null at the top. Nested values may be anything. */
export function decodeNonNull(json: unknown, path: string): NonNullable<unknown> {
  if (json === null) throw new DecodeError(path, ErrorCode.NullNotAllowed, "a JSON value other than null");
  return decodeAny(json, path) as NonNullable<unknown>;
}

/** A decoder of a JSON array whose items decode with item. */
export function array<T>(item: Decoder<T>): Decoder<T[]> {
  return (json, path) => {
    if (!guard(path, () => Array.isArray(json))) throw mismatch(path, "an array", json);
    const items = json as readonly unknown[];
    const length = guard(path, () => items.length);
    const out: T[] = [];
    for (let i = 0; i < length; i++) {
      const itemPath = at(path, i);
      out.push(item(guard(itemPath, () => items[i]), itemPath));
    }
    return out;
  };
}

/** Checks that json is a JSON object, and returns it for reading its keys. */
export function object(json: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!guard(path, () => isObject(json))) throw mismatch(path, "an object", json);
  return json as Readonly<Record<string, unknown>>;
}

/** Sets an own key, so a key like __proto__ is data, never the object's prototype, and notes its order. */
export function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  const order = ORDER.get(target);
  if (order === undefined) ORDER.set(target, [key]);
  else order.push(key);
}

/** True when o has key, guarding a Proxy that throws. */
function has(o: Readonly<Record<string, unknown>>, key: string, path: string): boolean {
  return guard(path, () => hasOwn.call(o, key));
}

/** Reads a key that must be present. A missing key fails at the key's path. */
export function required<T>(
  o: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  decode: Decoder<T>,
): T {
  const keyPath = at(path, key);
  if (!has(o, key, path)) throw new DecodeError(keyPath, ErrorCode.MissingKey);
  return decode(guard(keyPath, () => o[key]), keyPath);
}

/** Reads an optional key: absent gives no key, and null fails unless the type takes null. */
export function optional<K extends string, T>(
  o: Readonly<Record<string, unknown>>,
  key: K,
  path: string,
  decode: Decoder<T>,
): { [P in K]?: T } {
  const out = {};
  const keyPath = at(path, key);
  if (has(o, key, path)) put(out, key, decode(guard(keyPath, () => o[key]), keyPath));
  return out;
}

${report ? CLOSED_REPORT : CLOSED_STRICT}

/**
 * Decodes the members of o not named in skip, in input order, keys with key and values with
 * value. A key that fails fails at its own path, like the value under it.
 */
function members<K extends string, V>(
  o: Readonly<Record<string, unknown>>,
  path: string,
  skip: readonly string[],
  key: Decoder<K>,
  value: Decoder<V>,
): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const name of guard(path, () => keysOf(o))) {
    if (skip.includes(name)) continue;
    const memberPath = at(path, name);
    const decoded = key(name, memberPath);
    put(out, decoded, value(guard(memberPath, () => o[name]), memberPath));
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

/**
 * Decodes a tagged union: reads the tag key first and decodes only the branch it names. A
 * missing tag fails with missing_key, a tag that isn't a string with wrong_type, and a tag no
 * branch has with bad_tag, expected naming the tags in the schema's order, all at the tag's
 * path. An error inside the branch is the branch's own.
 */
export function tagged<T>(
  json: unknown,
  path: string,
  key: string,
  branches: readonly (readonly [string, Decoder<T>])[],
): T {
  const o = object(json, path);
  const tagPath = at(path, key);
  if (!has(o, key, path)) throw new DecodeError(tagPath, ErrorCode.MissingKey);
  const tag = guard(tagPath, () => o[key]);
  if (typeof tag !== "string") throw mismatch(tagPath, "a string", tag);
  const branch = branches.find(([name]) => name === tag);
  if (branch === undefined) {
    throw new DecodeError(tagPath, ErrorCode.BadTag, oneOf(branches.map(([name]) => name)), quote(tag));
  }
  return branch[1](o, path);
}

/**
 * Decodes an untagged union: tries the variants in order, the same order as Rust and Go, and
 * returns the first that decodes. When none does, it fails at the union's path with
 * wrong_type, or null_not_allowed for null, expected naming the union.
 */
export function untagged<T>(json: unknown, path: string, name: string, variants: readonly Decoder<T>[]): T {
  for (const variant of variants) {${report ? UNTAGGED_MARK : ""}
    try {
      return variant(json, path);
    } catch (error) {
      if (!(error instanceof DecodeError)) throw error;${report ? UNTAGGED_ROLLBACK : ""}
    }
  }
  throw mismatch(path, name, json);
}

/** Runs encode, turning anything it throws but an EncodeError into one, at path "". */
function guarded<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof EncodeError) throw error;
    throw new EncodeError("", "expected a JSON value, found a value that throws when read");
  }
}

/** Runs encode on value, moving an EncodeError it throws under segment. */
function within<T>(segment: string | number, value: () => T, encode: Encoder<T>): unknown {
  try {
    return encode(guarded(value));
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
    if (!guarded(() => Array.isArray(value))) return refuse("an array", value);
    const items: readonly T[] = value;
    const length = guarded(() => items.length);
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) out.push(within(i, () => items[i] as T, item));
    return out;
  };
}

/** Checks that value is a plain object before an encoder reads its keys, and returns the object to write. */
export function encodeObject(value: object): object {
  if (!guarded(() => isObject(value))) refuse("an object", value);
  const out = {};
  ORDER.set(out, []);
  return out;
}

/** Fails on the first key of value, in its order, that is not one of keys. */
export function encodeClosed(value: object, keys: readonly string[]): void {
  for (const key of guarded(() => keysOf(value))) {
    if (!keys.includes(key)) throw new EncodeError("", "unknown key " + quote(key));
  }
}

/**
 * Writes key of value with encode, naming the key in an error. An optional key that is absent
 * or undefined is left out.
 */
export function member<T>(out: object, value: object, key: string, encode: Encoder<T>, optional = false): void {
  const source = value as Readonly<Record<string, T | undefined>>;
  let read: T | undefined;
  try {
    read = guarded(() => (hasOwn.call(source, key) ? source[key] : undefined));
  } catch (error) {
    if (error instanceof EncodeError) throw new EncodeError(at("", key) + error.path, error.reason);
    throw error;
  }
  if (optional && read === undefined) return;
  put(out, key, within(key, () => read as T, encode));
}

/** Copies the members of source not named in skip, keys sorted, each through key and value. */
function encodeMembers<K extends string, V>(
  out: object,
  source: object,
  skip: readonly string[],
  key: Encoder<K>,
  value: Encoder<V>,
): void {
  const names = guarded(() => keysOf(source)).filter((name) => !skip.includes(name));
  for (const name of names.sort(byCodePoint)) {
    try {
      key(name as K);
    } catch (error) {
      if (error instanceof EncodeError) throw new EncodeError("", "key " + quote(name) + ": " + error.reason);
      throw error;
    }
    member(out, source, name, value);
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
    const out = encodeObject(source);
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
  const source = value as Readonly<Record<string, unknown>>;
  const tag: unknown = guarded(() => (hasOwn.call(source, key) ? source[key] : undefined));
  if (tag === undefined) throw new EncodeError("", "missing key " + quote(key));
  if (typeof tag !== "string") throw new EncodeError("", quote(key) + " must be a string, found " + kind(tag));
  const branch = branches.find(([name]) => name === tag);
  if (branch === undefined) {
    throw new EncodeError("", "unknown " + key + " " + quote(tag) + ", expected " + oneOf(branches.map(([n]) => n)));
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

/**
 * Writes an encoded value as JSON text, the keys of each object in the order the encoder or
 * the reader gave them, so keys like "1" stay where Rust and Go write them. Walks with a stack
 * of its own, so deep values can't overflow the call stack.
 */
export function toJson(value: unknown): string {
  type Step = { readonly value: unknown } | { readonly text: string };
  const parts: string[] = [];
  const steps: Step[] = [{ value }];
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if ("text" in step) {
      parts.push(step.text);
      continue;
    }
    const current = step.value;
    if (current === null || typeof current !== "object") {
      parts.push(JSON.stringify(current));
      continue;
    }
    const later: Step[] = [];
    if (Array.isArray(current)) {
      const items: readonly unknown[] = current;
      later.push({ text: "[" });
      items.forEach((item, i) => {
        if (i > 0) later.push({ text: "," });
        later.push({ value: item });
      });
      later.push({ text: "]" });
    } else {
      const holder = current as Readonly<Record<string, unknown>>;
      later.push({ text: "{" });
      keysOf(current).forEach((key, i) => {
        later.push({ text: (i > 0 ? "," : "") + JSON.stringify(key) + ":" }, { value: holder[key] });
      });
      later.push({ text: "}" });
    }
    for (let i = later.length - 1; i >= 0; i--) steps.push(later[i] as Step);
  }
  return parts.join("");
}
`;
}
