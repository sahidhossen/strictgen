/**
 * The `pattern` subset every language checks the same way, and its portable form.
 *
 * A schema's pattern is read as JSON Schema says, as an ECMAScript regular expression with the
 * `u` flag, and is unanchored: it matches when it matches anywhere in the string. Only the parts
 * of that syntax whose meaning can be written the same way for Rust's `regex` crate, Go's
 * `regexp` (RE2) and ECMAScript are accepted. The rest fails generation with the reason:
 * lookarounds, backreferences, named groups, word boundaries, Unicode property escapes, inline
 * flags and repeats above {@link MAX_REPEAT}.
 *
 * The accepted pattern is rewritten into one portable form that all three engines read the same
 * way, which the decoders compile once. The rewrite spells out what the engines disagree on:
 *
 * - `\d` is `[0-9]` and `\w` is `[0-9A-Za-z_]`, as in ECMAScript. Rust's `regex` would read both
 *   as Unicode classes
 * - `\s` is ECMAScript's list of white space and line terminators, written out. Go reads it as
 *   ASCII white space without `\v`, Rust as Unicode `White_Space`
 * - `.` is any code point but `\n`, `\r`, U+2028 and U+2029, as in ECMAScript. Rust and Go would
 *   match `\r`, U+2028 and U+2029
 * - classes are written as sorted, merged ranges, with `\`, `]`, `[`, `^` and `-` escaped, so
 *   Rust's nested classes and set operations never apply
 * - every group is non-capturing and every repeat greedy, which changes no match
 *
 * `^` and `$` are the start and end of the whole string in every engine (no multiline flag), and
 * matching is case-sensitive, code point by code point.
 */

/** The largest repeat count, alone or multiplied through nested repeats, which Go's RE2 takes. */
export const MAX_REPEAT = 1000;

/** The deepest nesting of groups and repeats. */
const MAX_NESTING = 50;

/** The largest code point. */
const MAX_CODE = 0x10ffff;

/** A set of code points: sorted, disjoint, non-adjacent inclusive ranges, without surrogates. */
type CodeSet = readonly (readonly [number, number])[];

type Node =
  | { readonly kind: "alt"; readonly options: readonly Node[] }
  | { readonly kind: "seq"; readonly items: readonly Node[] }
  | { readonly kind: "char"; readonly code: number }
  | { readonly kind: "set"; readonly set: CodeSet }
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "group"; readonly body: Node }
  | {
      readonly kind: "repeat";
      readonly body: Node;
      readonly min: number;
      readonly max: number | undefined;
    };

/** Why a pattern can't be checked the same way everywhere, with a fix when one is obvious. */
export class PatternError extends Error {
  readonly hint: string | undefined;
  constructor(reason: string, hint?: string) {
    super(reason);
    this.hint = hint;
  }
}

/** The pattern syntax characters, which a backslash makes literal anywhere. */
const SYNTAX = "^$\\.*+?()[]{}|/";

const DIGITS: CodeSet = [[0x30, 0x39]];
const WORD: CodeSet = normalize([
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
]);
/** ECMAScript's WhiteSpace and LineTerminator code points, which `\s` matches. */
const SPACE: CodeSet = normalize([
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]);
/** What `.` matches: every code point but the ECMAScript line terminators. */
const DOT: CodeSet = complement(normalize([
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
]));

/** Sorts and merges ranges, and takes the surrogates out, since no string holds one alone. */
function normalize(ranges: readonly (readonly [number, number])[]): CodeSet {
  const split: [number, number][] = [];
  for (const [lo, hi] of ranges) {
    if (lo < 0xd800) split.push([lo, Math.min(hi, 0xd7ff)]);
    if (hi > 0xdfff) split.push([Math.max(lo, 0xe000), hi]);
  }
  split.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [lo, hi] of split) {
    if (lo > hi) continue;
    const last = out.at(-1);
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** Every code point, surrogates aside, that set doesn't hold. */
function complement(set: CodeSet): CodeSet {
  const out: [number, number][] = [];
  let next = 0;
  for (const [lo, hi] of set) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE) out.push([next, MAX_CODE]);
  return normalize(out);
}

function size(set: CodeSet): number {
  return set.reduce((n, [lo, hi]) => n + hi - lo + 1, 0);
}

const LOOKAROUND = "lookarounds are not supported by Rust's regex and Go's RE2";
const BACKREFERENCE = "backreferences are not supported by Rust's regex and Go's RE2";

/** Reads one pattern, the ECMAScript syntax with the u flag, into nodes. */
class Parser {
  readonly #chars: readonly string[];
  #i = 0;
  #depth = 0;

  constructor(pattern: string) {
    this.#chars = [...pattern];
  }

  parse(): Node {
    const node = this.#alternation();
    if (this.#i < this.#chars.length) throw this.#fail(`unexpected ${this.#show(this.#peek())}`);
    return node;
  }

  #peek(offset = 0): string {
    return this.#chars[this.#i + offset] ?? "";
  }

  #show(c: string): string {
    return c === "" ? "end of pattern" : JSON.stringify(c);
  }

  #fail(reason: string, hint?: string): PatternError {
    return new PatternError(`${reason} at character ${String(this.#i + 1)}`, hint);
  }

  #alternation(): Node {
    const options = [this.#sequence()];
    while (this.#peek() === "|") {
      this.#i++;
      options.push(this.#sequence());
    }
    return options.length === 1 ? (options[0] as Node) : { kind: "alt", options };
  }

  #sequence(): Node {
    const items: Node[] = [];
    while (this.#i < this.#chars.length && this.#peek() !== "|" && this.#peek() !== ")") {
      items.push(this.#term());
    }
    return items.length === 1 ? (items[0] as Node) : { kind: "seq", items };
  }

  #term(): Node {
    const c = this.#peek();
    if (c === "^" || c === "$") {
      this.#i++;
      if ("*+?{".includes(this.#peek()) && this.#peek() !== "")
        throw this.#fail(`nothing to repeat before ${this.#show(this.#peek())}`);
      return { kind: c === "^" ? "start" : "end" };
    }
    const atom = this.#atom();
    return this.#quantified(atom);
  }

  #quantified(atom: Node): Node {
    const c = this.#peek();
    let min: number;
    let max: number | undefined;
    if (c === "*") {
      this.#i++;
      [min, max] = [0, undefined];
    } else if (c === "+") {
      this.#i++;
      [min, max] = [1, undefined];
    } else if (c === "?") {
      this.#i++;
      [min, max] = [0, 1];
    } else if (c === "{") {
      [min, max] = this.#braces();
    } else {
      return atom;
    }
    // A lazy repeat matches the same strings as a greedy one, so the ? goes.
    if (this.#peek() === "?") this.#i++;
    if ("*+?{".includes(this.#peek()) && this.#peek() !== "")
      throw this.#fail(`a repeat of a repeat, ${this.#show(this.#peek())}`, "wrap the inner repeat in a group");
    return { kind: "repeat", body: atom, min, max };
  }

  #braces(): [number, number | undefined] {
    this.#i++;
    const min = this.#number();
    let max: number | undefined = min;
    if (this.#peek() === ",") {
      this.#i++;
      max = this.#peek() === "}" ? undefined : this.#number();
    }
    if (this.#peek() !== "}") throw this.#fail("a repeat needs a closing }");
    this.#i++;
    if (max !== undefined && max < min) throw this.#fail(`a repeat {${String(min)},${String(max)}} counts down`);
    for (const n of [min, max]) {
      if (n !== undefined && n > MAX_REPEAT)
        throw this.#fail(`a repeat count above ${String(MAX_REPEAT)}, which Go's RE2 rejects`);
    }
    return [min, max];
  }

  #number(): number {
    let text = "";
    while (/[0-9]/.test(this.#peek()) && this.#peek() !== "") text += this.#chars[this.#i++] ?? "";
    if (text === "") throw this.#fail("a repeat needs a number, like {2} or {1,3}");
    return Number(text);
  }

  #atom(): Node {
    const c = this.#peek();
    switch (c) {
      case "(":
        return this.#group();
      case "[":
        return { kind: "set", set: this.#class() };
      case ".":
        this.#i++;
        return { kind: "set", set: DOT };
      case "\\":
        return this.#atomEscape();
      case "*":
      case "+":
      case "?":
      case "{":
        throw this.#fail(`nothing to repeat before ${this.#show(c)}`);
      case ")":
      case "]":
      case "}":
        throw this.#fail(`an unmatched ${this.#show(c)}`, `escape it, like "\\\\${c}"`);
      default:
        this.#i++;
        return { kind: "char", code: c.codePointAt(0) ?? 0 };
    }
  }

  #group(): Node {
    const start = this.#i;
    this.#i++;
    if (this.#peek() === "?") {
      const next = this.#peek(1);
      if (next === ":") {
        this.#i += 2;
      } else if (next === "=" || next === "!" || (next === "<" && "=!".includes(this.#peek(2)) && this.#peek(2) !== "")) {
        throw this.#failAt(start, LOOKAROUND);
      } else if (next === "<") {
        throw this.#failAt(start, "named groups are not supported", 'use a plain group, "(...)"');
      } else {
        throw this.#failAt(start, "inline flags and other (? groups are not supported");
      }
    }
    if (++this.#depth > MAX_NESTING) throw this.#fail(`groups nested more than ${String(MAX_NESTING)} deep`);
    const body = this.#alternation();
    this.#depth--;
    if (this.#peek() !== ")") throw this.#fail("a group needs a closing )");
    this.#i++;
    return { kind: "group", body };
  }

  /** An escape outside a class: a class escape, a character, or one that isn't supported. */
  #atomEscape(): Node {
    const c = this.#peek(1);
    if (c === "b" || c === "B") {
      throw this.#fail(
        `the word boundary \\${c}`,
        "Rust's regex reads it by Unicode rules, Go and ECMAScript by ASCII ones",
      );
    }
    if (/[1-9]/.test(c) || c === "k") throw this.#fail(BACKREFERENCE);
    const set = this.#classEscape();
    if (set !== undefined) return { kind: "set", set };
    return { kind: "char", code: this.#charEscape(false) };
  }

  /** `\d`, `\D`, `\w`, `\W`, `\s` or `\S`, or undefined when the escape at the backslash is another. */
  #classEscape(): CodeSet | undefined {
    const c = this.#peek(1);
    const sets: Record<string, CodeSet> = { d: DIGITS, w: WORD, s: SPACE };
    const lower = c.toLowerCase();
    const base = sets[lower];
    if (base === undefined || c === "") {
      if (c === "p" || c === "P")
        throw this.#fail("Unicode property escapes are not supported", "the engines know different properties");
      return undefined;
    }
    this.#i += 2;
    return c === lower ? base : complement(base);
  }

  /** One escaped character, at the backslash, as its code point. */
  #charEscape(inClass: boolean): number {
    const start = this.#i;
    this.#i++;
    const c = this.#peek();
    this.#i++;
    const controls: Record<string, number> = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d };
    const control = controls[c];
    if (control !== undefined) return control;
    if (inClass && c === "b") return 0x08;
    if (inClass && c === "-") return 0x2d;
    if (c !== "" && SYNTAX.includes(c)) return c.codePointAt(0) ?? 0;
    if (c === "0" && !/[0-9]/.test(this.#peek())) return 0;
    if (c === "c" && /[A-Za-z]/.test(this.#peek()) && this.#peek() !== "") {
      return (this.#chars[this.#i++]?.codePointAt(0) ?? 0) % 32;
    }
    if (c === "x") return this.#hex(2);
    if (c === "u") {
      if (this.#peek() === "{") {
        this.#i++;
        let text = "";
        while (/[0-9A-Fa-f]/.test(this.#peek()) && this.#peek() !== "") text += this.#chars[this.#i++] ?? "";
        if (text === "" || this.#peek() !== "}") throw this.#failAt(start, "a bad \\u{...} escape");
        this.#i++;
        const code = parseInt(text, 16);
        if (code > MAX_CODE) throw this.#failAt(start, "a \\u{...} escape above U+10FFFF");
        return this.#scalar(code, start);
      }
      const unit = this.#hex(4);
      if (unit >= 0xd800 && unit <= 0xdbff && this.#peek() === "\\" && this.#peek(1) === "u") {
        const saved = this.#i;
        this.#i += 2;
        const low = this.#hex(4, true);
        if (low >= 0xdc00 && low <= 0xdfff) return 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        this.#i = saved;
      }
      return this.#scalar(unit, start);
    }
    throw this.#failAt(start, `the escape \\${c === "" ? "" : c}${c === "" ? " at the end" : ""} is not supported`);
  }

  #scalar(code: number, start: number): number {
    if (code >= 0xd800 && code <= 0xdfff) throw this.#failAt(start, "a lone surrogate, which no string holds");
    return code;
  }

  #hex(count: number, soft = false): number {
    let text = "";
    for (let k = 0; k < count; k++) {
      const c = this.#peek();
      if (!/[0-9A-Fa-f]/.test(c) || c === "") {
        if (soft) return -1;
        throw this.#fail(`an escape needs ${String(count)} hex digits`);
      }
      text += c;
      this.#i++;
    }
    return parseInt(text, 16);
  }

  #failAt(at: number, reason: string, hint?: string): PatternError {
    this.#i = at;
    return this.#fail(reason, hint);
  }

  /** A class, like `[a-z_]` or `[^\s]`, as the set of code points it matches. */
  #class(): CodeSet {
    this.#i++;
    let negated = false;
    if (this.#peek() === "^") {
      negated = true;
      this.#i++;
    }
    const ranges: (readonly [number, number])[] = [];
    while (this.#peek() !== "]") {
      if (this.#peek() === "") throw this.#fail("a class needs a closing ]");
      const lo = this.#classAtom();
      if (this.#peek() === "-" && this.#peek(1) !== "]" && this.#peek(1) !== "") {
        this.#i++;
        const hi = this.#classAtom();
        if (typeof lo !== "number" || typeof hi !== "number")
          throw this.#fail("a class range between a class escape and a character");
        if (hi < lo) throw this.#fail("a class range out of order");
        ranges.push([lo, hi]);
      } else if (typeof lo === "number") {
        ranges.push([lo, lo]);
      } else {
        ranges.push(...lo);
      }
    }
    this.#i++;
    const set = normalize(ranges);
    return negated ? complement(set) : set;
  }

  /** One character of a class, or the set a class escape like `\d` stands for. */
  #classAtom(): number | CodeSet {
    const c = this.#peek();
    if (c === "\\") {
      const next = this.#peek(1);
      if (next === "B") throw this.#fail("\\B in a class");
      if (/[1-9]/.test(next) || next === "k") throw this.#fail(BACKREFERENCE);
      return this.#classEscape() ?? this.#charEscape(true);
    }
    this.#i++;
    return c.codePointAt(0) ?? 0;
  }
}

/** Fails on repeats whose counts multiply past MAX_REPEAT through nesting. */
function checkRepeats(node: Node, outer: number): void {
  switch (node.kind) {
    case "alt":
      node.options.forEach((n) => checkRepeats(n, outer));
      return;
    case "seq":
      node.items.forEach((n) => checkRepeats(n, outer));
      return;
    case "group":
      checkRepeats(node.body, outer);
      return;
    case "repeat": {
      const count = node.max ?? node.min;
      const total = outer * Math.max(count, 1);
      if (count > 1 && total > MAX_REPEAT) {
        throw new PatternError(
          `nested repeats that multiply to more than ${String(MAX_REPEAT)}, which Go's RE2 rejects`,
        );
      }
      checkRepeats(node.body, count > 1 ? total : outer);
      return;
    }
    default:
      return;
  }
}

/** A character written in the portable form: syntax characters escaped, the rest as itself. */
function literal(code: number): string {
  const c = String.fromCodePoint(code);
  return "^$\\.*+?()[]{}|".includes(c) ? `\\${c}` : c;
}

/** A character inside a class. */
function classLiteral(code: number): string {
  const c = String.fromCodePoint(code);
  return "\\]^[-".includes(c) ? `\\${c}` : c;
}

function ranges(set: CodeSet): string {
  return set
    .map(([lo, hi]) => {
      if (lo === hi) return classLiteral(lo);
      if (hi === lo + 1) return `${classLiteral(lo)}${classLiteral(hi)}`;
      return `${classLiteral(lo)}-${classLiteral(hi)}`;
    })
    .join("");
}

function writeSet(set: CodeSet): string {
  if (set.length === 0) throw new PatternError("a class that matches nothing");
  if (size(set) === 1) return literal(set[0]?.[0] ?? 0);
  const rest = complement(set);
  // The shorter of the class and its negation; both match the same strings.
  if (rest.length > 0 && rest.length < set.length) return `[^${ranges(rest)}]`;
  return `[${ranges(set)}]`;
}

function write(node: Node): string {
  switch (node.kind) {
    case "alt":
      return node.options.map(write).join("|");
    case "seq":
      return node.items
        .map((n) => (n.kind === "alt" ? `(?:${write(n)})` : write(n)))
        .join("");
    case "char":
      return literal(node.code);
    case "set":
      return writeSet(node.set);
    case "start":
      return "^";
    case "end":
      return "$";
    case "group":
      return `(?:${write(node.body)})`;
    case "repeat": {
      const body = node.body.kind === "char" || node.body.kind === "set" || node.body.kind === "group"
        ? write(node.body)
        : `(?:${write(node.body)})`;
      const { min, max } = node;
      if (min === 0 && max === undefined) return `${body}*`;
      if (min === 1 && max === undefined) return `${body}+`;
      if (min === 0 && max === 1) return `${body}?`;
      if (max === undefined) return `${body}{${String(min)},}`;
      if (max === min) return `${body}{${String(min)}}`;
      return `${body}{${String(min)},${String(max)}}`;
    }
  }
}

/**
 * The portable form of a pattern, which Rust's regex, Go's RE2 and ECMAScript with the u flag
 * all read the same way. Throws a PatternError for a pattern outside the subset, or one that
 * isn't a valid ECMAScript pattern with the u flag.
 */
export function portablePattern(pattern: string): string {
  if (/\p{Surrogate}/u.test(pattern)) throw new PatternError("the pattern holds a lone surrogate");
  try {
    new RegExp(pattern, "u");
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/^Invalid regular expression: /, "") : "";
    throw new PatternError(`not a valid ECMAScript pattern with the u flag (${reason})`);
  }
  const node = new Parser(pattern).parse();
  checkRepeats(node, 1);
  return write(node);
}
