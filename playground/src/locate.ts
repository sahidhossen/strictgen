/**
 * Finds where a JSON Pointer points in JSON text, so the page can mark the place an error names.
 *
 * A payload is read with the grammar of the strict reader the generated TypeScript uses
 * (`Reader` in `src/ts-helpers.ts`): no lone surrogates, finite numbers, no key given twice,
 * nothing after the value, and at most MAX_DEPTH - 1 nested arrays and objects. A schema is read
 * as the generator reads it, with `JSON.parse`: the same grammar, but a later key replaces an
 * earlier one, and lone surrogates, numbers out of range and any depth are allowed. Keys are
 * compared after their escapes are read, as the readers compare them. Positions are in UTF-16
 * units, as the editor counts them, so an astral character takes two.
 */
import { MAX_DEPTH } from "../../src/errors.js";

/** A range of the text, in UTF-16 units: `from` inclusive, `to` exclusive. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/** Where one value is: its own range, and for an object member the range of its key. */
export interface Place {
  readonly value: Span;
  readonly key: Span | null;
}

/** Which reader's rules: the generated decoders' strict reader, or `JSON.parse`, as schemas are read. */
export type Grammar = "strict" | "parse";

/** The text read: every value by JSON Pointer, or the position where reading stopped. */
export type Located =
  | { readonly ok: true; readonly places: ReadonlyMap<string, Place> }
  /**
   * `limit` is true when reading stopped at {@link PARSE_MAX_DEPTH}, the page's own limit for
   * schemas, rather than at an error in the text: nothing is marked then.
   */
  | { readonly ok: false; readonly at: number; readonly limit: boolean };

/**
 * The deepest nesting read with the `JSON.parse` grammar. The reader recurses, so text nested
 * deeper (which `JSON.parse` may still read) gets no marks instead of overflowing the stack.
 */
export const PARSE_MAX_DEPTH = 512;

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

/** The path of a key or an index under path, escaped as a JSON Pointer segment. */
function child(path: string, segment: string | number): string {
  return `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Thrown inside the reader with the position it stopped at. */
class Stop {
  constructor(
    readonly at: number,
    readonly limit = false,
  ) {}
}

class Reader {
  readonly places = new Map<string, Place>();
  private pos = 0;

  constructor(
    private readonly text: string,
    private readonly strict: boolean,
  ) {}

  document(): void {
    for (let i = 0; this.strict && i < this.text.length; i++) {
      const unit = this.text.charCodeAt(i);
      if (isHigh(unit) && isLow(this.text.charCodeAt(i + 1))) i++;
      else if (isHigh(unit) || isLow(unit)) throw new Stop(i);
    }
    this.value(0, "", null);
    this.space();
    if (this.pos !== this.text.length) throw new Stop(this.pos);
  }

  private space(): void {
    for (;;) {
      const c = this.text[this.pos];
      if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") return;
      this.pos++;
    }
  }

  private accept(c: string): boolean {
    if (this.text[this.pos] !== c) return false;
    this.pos++;
    return true;
  }

  private value(depth: number, path: string, key: Span | null): void {
    this.space();
    const from = this.pos;
    const c = this.text[this.pos];
    switch (c) {
      case undefined:
        throw new Stop(this.pos);
      case "{":
      case "[":
        if (this.strict && depth + 1 >= MAX_DEPTH) throw new Stop(this.pos);
        if (!this.strict && depth + 1 > PARSE_MAX_DEPTH) throw new Stop(this.pos, true);
        if (c === "{") this.object(depth + 1, path);
        else this.array(depth + 1, path);
        break;
      case '"':
        this.string();
        break;
      case "t":
        this.word("true");
        break;
      case "f":
        this.word("false");
        break;
      case "n":
        this.word("null");
        break;
      default:
        this.number();
    }
    this.places.set(path, { value: { from, to: this.pos }, key });
  }

  private word(word: string): void {
    for (const c of word) {
      if (this.text[this.pos] !== c) throw new Stop(this.pos);
      this.pos++;
    }
  }

  private object(depth: number, path: string): void {
    const seen = new Set<string>();
    this.pos++;
    this.space();
    if (this.accept("}")) return;
    for (;;) {
      this.space();
      if (this.text[this.pos] !== '"') throw new Stop(this.pos);
      const keyAt = this.pos;
      const key = this.string();
      const at = child(path, key);
      if (seen.has(key)) {
        if (this.strict) throw new Stop(keyAt);
        // JSON.parse keeps the later value: the later one replaces the earlier one's place, and
        // when the earlier one held values, their places go too (only then is the map scanned).
        const first = this.text[this.places.get(at)?.value.from ?? -1];
        if (first === "{" || first === "[") {
          for (const p of [...this.places.keys()]) if (p.startsWith(`${at}/`)) this.places.delete(p);
        }
      }
      seen.add(key);
      const keySpan = { from: keyAt, to: this.pos };
      this.space();
      if (!this.accept(":")) throw new Stop(this.pos);
      this.value(depth, at, keySpan);
      this.space();
      if (this.accept("}")) return;
      if (!this.accept(",")) throw new Stop(this.pos);
    }
  }

  private array(depth: number, path: string): void {
    this.pos++;
    this.space();
    if (this.accept("]")) return;
    for (let i = 0; ; i++) {
      this.value(depth, child(path, i), null);
      this.space();
      if (this.accept("]")) return;
      if (!this.accept(",")) throw new Stop(this.pos);
    }
  }

  private string(): string {
    this.pos++;
    let out = "";
    let chunk = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) throw new Stop(this.pos);
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
        throw new Stop(this.pos);
      } else {
        this.pos++;
      }
    }
  }

  private escape(): string {
    const start = this.pos;
    this.pos++;
    const simple = ESCAPES.get(this.text[this.pos] ?? "");
    if (simple !== undefined) {
      this.pos++;
      return simple;
    }
    if (!this.accept("u")) throw new Stop(this.pos);
    const unit = this.hex4();
    if (!this.strict) return String.fromCharCode(unit);
    if (isLow(unit)) throw new Stop(start);
    if (!isHigh(unit)) return String.fromCharCode(unit);
    if (this.text[this.pos] !== "\\" || this.text[this.pos + 1] !== "u") throw new Stop(start);
    this.pos += 2;
    const low = this.hex4();
    if (!isLow(low)) throw new Stop(start);
    return String.fromCharCode(unit, low);
  }

  private hex4(): number {
    let unit = 0;
    for (let i = 0; i < 4; i++) {
      const c = this.text[this.pos] ?? "";
      if (!/^[0-9a-fA-F]$/.test(c)) throw new Stop(this.pos);
      unit = unit * 16 + parseInt(c, 16);
      this.pos++;
    }
    return unit;
  }

  private digits(): number {
    const start = this.pos;
    while (isDigit(this.text[this.pos])) this.pos++;
    return this.pos - start;
  }

  private number(): void {
    const start = this.pos;
    this.accept("-");
    if (this.accept("0")) {
      if (isDigit(this.text[this.pos])) throw new Stop(this.pos);
    } else if (this.digits() === 0) {
      throw new Stop(this.pos);
    }
    if (this.accept(".") && this.digits() === 0) throw new Stop(this.pos);
    if (this.accept("e") || this.accept("E")) {
      if (!this.accept("+")) this.accept("-");
      if (this.digits() === 0) throw new Stop(this.pos);
    }
    if (this.strict && !Number.isFinite(Number(this.text.slice(start, this.pos)))) throw new Stop(start);
  }
}

/** Reads `text` with `grammar` and gives the place of every value, or where reading stopped. */
export function locate(text: string, grammar: Grammar = "strict"): Located {
  const reader = new Reader(text, grammar === "strict");
  try {
    reader.document();
  } catch (error) {
    if (error instanceof Stop) return { ok: false, at: error.at, limit: error.limit };
    throw error;
  }
  return { ok: true, places: reader.places };
}

/** The pointer one level up: `/a/b` gives `/a`, and `/a` gives the whole document, `""`. */
function parent(pointer: string): string | null {
  if (pointer === "") return null;
  return pointer.slice(0, pointer.lastIndexOf("/"));
}

/** At least one character, inside the text, so a mark always shows. */
function visible(span: Span, length: number): Span | null {
  if (length === 0) return null;
  if (span.to > span.from) return span;
  return span.from >= length ? { from: length - 1, to: length } : { from: span.from, to: span.from + 1 };
}

/** What a mark should cover for one error: the value, or the key for errors about a key. */
export type Target = "value" | "key";

/**
 * The range to mark for a pointer in text the reader read: the value at `pointer`, or for
 * `target` "key" its key (the first character of a value with none). When nothing is there,
 * like a missing key, the nearest value above it, by its key when it has one, else by its first
 * character. Null when the text doesn't read or the pointer isn't under its root.
 */
export function spanAt(located: Located, length: number, pointer: string, target: Target = "value"): Span | null {
  if (!located.ok) return null;
  const exact = located.places.get(pointer);
  const named = (place: Place): Span => place.key ?? { from: place.value.from, to: place.value.from + 1 };
  if (exact !== undefined) return visible(target === "key" ? named(exact) : exact.value, length);
  for (let up = parent(pointer); up !== null; up = parent(up)) {
    const place = located.places.get(up);
    if (place !== undefined) return visible(named(place), length);
  }
  return null;
}

/** The fields of a decode error the page marks by. */
export interface ErrorAt {
  readonly path: string;
  readonly code: string;
}

/** Codes the strict reader gives when the text itself is wrong, at the place it stopped. */
const READ_CODES = new Set(["invalid_json", "duplicate_key", "too_deep"]);

/** Codes about a key rather than its value. */
const KEY_CODES = new Set(["unknown_key", "duplicate_key"]);

/**
 * The range of the payload to mark for a decode error. A reading error (invalid JSON, a key
 * given twice, too deep) marks the place the reader stopped, which is where the error's offset
 * points. Any other error marks the value at its path, by {@link spanAt}. `exact` is false for
 * text another step changed before reading, like the LLM cleanup: only errors at a path that
 * the text has are marked then, and reading errors aren't.
 */
export function errorSpan(text: string, error: ErrorAt, exact = true): Span | null {
  const located = locate(text);
  if (!located.ok) {
    if (!exact || !READ_CODES.has(error.code)) return null;
    // A key given twice stops at the later key: mark the whole key.
    const at = located.at;
    if (error.code === "duplicate_key" && text[at] === '"') {
      const end = keyEnd(text, at);
      return visible({ from: at, to: end }, text.length);
    }
    return visible({ from: at, to: at }, text.length);
  }
  return spanAt(located, text.length, error.path, KEY_CODES.has(error.code) ? "key" : "value");
}

/** The position after the string that starts at the quote `at`, in text that read up to it. */
function keyEnd(text: string, at: number): number {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/**
 * The range to mark for a generation error in a schema file, read as the generator reads it,
 * with `JSON.parse`. A pointer marks the key that names the schema or keyword at fault, which is
 * shorter than the schema it holds; the whole file, a null pointer, marks where the text stops
 * being JSON.
 */
export function schemaSpan(text: string, pointer: string | null): Span | null {
  const located = locate(text, "parse");
  if (pointer === null) return located.ok || located.limit ? null : visible({ from: located.at, to: located.at }, text.length);
  return spanAt(located, text.length, pointer, "key");
}
