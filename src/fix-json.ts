/**
 * An ordered JSON tree for `strictgen fix`, which rewrites schema files and keeps everything it
 * doesn't change as it was written: key order (also for keys like `"1"`, which plain objects
 * move to the front), number spelling (`1.0` stays `1.0`), string escapes and the formatting of
 * every untouched part of the file.
 *
 * Trees are immutable. A rule that changes a node builds a new one with {@link edit}, so every
 * node a rule didn't touch is still the object the reader made, and {@link render} copies its
 * original text, re-indented when it moved.
 */

/** A number, kept as written. */
export class JNum {
  constructor(readonly text: string) {}

  get value(): number {
    return Number(this.text);
  }
}

/** A JSON value in an ordered tree. */
export type JValue = null | boolean | string | JNum | JArr | JMap;
/** A JSON array. */
export type JArr = readonly JValue[];
/** A JSON object, in key order. */
export type JMap = ReadonlyMap<string, JValue>;

/** True for a JSON object. */
export function isMap(value: JValue | undefined): value is JMap {
  return value instanceof Map;
}

/** True for a JSON array. */
export function isArr(value: JValue | undefined): value is JArr {
  return Array.isArray(value);
}

/** Where a container was read from, so an untouched one is written back as it was. */
interface Source {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The leading whitespace of the line the container starts on. */
  readonly indent: string;
  /** The text of each scalar child and object key, to keep their escapes. */
  readonly raw: ReadonlyMap<string | number, string>;
  readonly keys: ReadonlyMap<string, string>;
}

const sources = new WeakMap<object, Source>();
/** The container a changed one was copied from, for its formatting and its scalars' text. */
const origins = new WeakMap<object, JMap | JArr>();

/** A JSON text that isn't valid, or that `strictgen fix` can't rewrite safely. */
export class JsonSyntaxError extends Error {}

/** The deepest nesting the reader takes. Real schemas stay far below it. */
const MAX_DEPTH = 256;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const LITERAL = /true|false|null/y;

/**
 * Reads a JSON text into an ordered tree. Accepts what `JSON.parse` accepts, except a duplicate
 * key, which would be lost on writing, and nesting deeper than 256 levels.
 */
export function parseJson(text: string): JValue {
  let pos = 0;
  const lineStart = (at: number): number => text.lastIndexOf("\n", at - 1) + 1;
  const where = (at: number): string => {
    const line = text.slice(0, at).split("\n").length;
    return `line ${String(line)}, column ${String(at - lineStart(at) + 1)}`;
  };
  const error = (message: string, at: number = pos): never => {
    throw new JsonSyntaxError(`${message} at ${where(at)}`);
  };
  const space = (): void => {
    while (pos < text.length && " \t\n\r".includes(text.charAt(pos))) pos++;
  };
  const unexpected = (): never => {
    if (pos >= text.length) return error("unexpected end of the text");
    const code = text.codePointAt(pos) ?? 0;
    const shown =
      code >= 0x21 && code <= 0x7e
        ? JSON.stringify(text.charAt(pos))
        : `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    return error(`unexpected character ${shown}`);
  };
  const string = (): { value: string; raw: string } => {
    const start = pos;
    pos++;
    while (pos < text.length && text.charAt(pos) !== '"') pos += text.charAt(pos) === "\\" ? 2 : 1;
    if (pos >= text.length) error("unterminated string", start);
    pos++;
    const raw = text.slice(start, pos);
    try {
      return { value: JSON.parse(raw) as string, raw };
    } catch {
      return error("invalid string", start);
    }
  };
  const container = (depth: number): JValue => {
    const start = pos;
    const open = text.charAt(pos);
    if (depth > MAX_DEPTH) error(`nested deeper than ${String(MAX_DEPTH)} levels`);
    const indent = /^[ \t]*/.exec(text.slice(lineStart(start)))?.[0] ?? "";
    const raw = new Map<string | number, string>();
    const keys = new Map<string, string>();
    pos++;
    space();
    let node: JValue;
    if (open === "{") {
      const map = new Map<string, JValue>();
      if (text.charAt(pos) === "}") pos++;
      else {
        for (;;) {
          if (text.charAt(pos) !== '"') unexpected();
          const keyAt = pos;
          const key = string();
          if (map.has(key.value)) error(`duplicate key ${key.raw}`, keyAt);
          keys.set(key.value, key.raw);
          space();
          if (text.charAt(pos) !== ":") unexpected();
          pos++;
          space();
          const valueAt = pos;
          map.set(key.value, value(depth));
          if (text.charAt(valueAt) !== "{" && text.charAt(valueAt) !== "[")
            raw.set(key.value, text.slice(valueAt, pos));
          space();
          if (text.charAt(pos) === ",") {
            pos++;
            space();
          } else if (text.charAt(pos) === "}") {
            pos++;
            break;
          } else unexpected();
        }
      }
      node = map;
    } else {
      const items: JValue[] = [];
      if (text.charAt(pos) === "]") pos++;
      else {
        for (;;) {
          const valueAt = pos;
          items.push(value(depth));
          if (text.charAt(valueAt) !== "{" && text.charAt(valueAt) !== "[")
            raw.set(items.length - 1, text.slice(valueAt, pos));
          space();
          if (text.charAt(pos) === ",") {
            pos++;
            space();
          } else if (text.charAt(pos) === "]") {
            pos++;
            break;
          } else unexpected();
        }
      }
      node = items;
    }
    sources.set(node, { text, start, end: pos, indent, raw, keys });
    return node;
  };
  const value = (depth: number): JValue => {
    const c = text.charAt(pos);
    if (c === "{" || c === "[") return container(depth + 1);
    if (c === '"') return string().value;
    NUMBER.lastIndex = pos;
    const number = NUMBER.exec(text);
    if (number !== null) {
      pos += number[0].length;
      return new JNum(number[0]);
    }
    LITERAL.lastIndex = pos;
    const literal = LITERAL.exec(text);
    if (literal !== null) {
      pos += literal[0].length;
      return literal[0] === "null" ? null : literal[0] === "true";
    }
    return unexpected();
  };
  space();
  const root = value(0);
  space();
  if (pos < text.length) unexpected();
  return root;
}

/** Builds a changed copy of an object, keeping its formatting. */
export function edit(map: JMap, change: (draft: Map<string, JValue>) => void): JMap {
  const draft = new Map(map);
  change(draft);
  origins.set(draft, origins.get(map) ?? map);
  return draft;
}

/** Builds a changed copy of an array, keeping its formatting. */
export function editArr(arr: JArr, change: (draft: JValue[]) => void): JArr {
  const draft = [...arr];
  change(draft);
  origins.set(draft, origins.get(arr) ?? arr);
  return draft;
}

/** A copy of `map` with `key` set to `value`, in place when it exists, else after `after` or last. */
export function setKey(map: JMap, key: string, value: JValue, after?: string): JMap {
  if (map.get(key) === value) return map;
  if (map.has(key) || after === undefined || !map.has(after))
    return edit(map, (d) => d.set(key, value));
  return edit(map, (d) => {
    const entries = [...d];
    d.clear();
    for (const [k, v] of entries) {
      d.set(k, v);
      if (k === after) d.set(key, value);
    }
  });
}

/** A copy of `map` with `key` inserted before `before`, or first when `before` is missing. */
export function insertBefore(map: JMap, key: string, value: JValue, before: string): JMap {
  return edit(map, (d) => {
    const entries = [...d].filter(([k]) => k !== key);
    d.clear();
    if (!entries.some(([k]) => k === before)) d.set(key, value);
    for (const [k, v] of entries) {
      if (k === before) d.set(key, value);
      d.set(k, v);
    }
  });
}

/** A copy of `map` without `key`. */
export function removeKey(map: JMap, key: string): JMap {
  return map.has(key) ? edit(map, (d) => d.delete(key)) : map;
}

/** A copy of `map` with the key `from` renamed to `to`, in the same position. */
export function renameKey(map: JMap, from: string, to: string): JMap {
  return edit(map, (d) => {
    const entries = [...d];
    d.clear();
    for (const [k, v] of entries) d.set(k === from ? to : k, v);
  });
}

/** Deep equality by JSON meaning: object key order doesn't matter, numbers compare by value. */
export function sameValue(a: JValue | undefined, b: JValue | undefined): boolean {
  if (a instanceof JNum || b instanceof JNum)
    return a instanceof JNum && b instanceof JNum && a.value === b.value;
  if (isArr(a) || isArr(b))
    return isArr(a) && isArr(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  if (isMap(a) || isMap(b)) {
    if (!isMap(a) || !isMap(b) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameValue(v, b.get(k))) return false;
    return true;
  }
  return a === b;
}

/** Exact equality, with key order and number spelling, for checking a written text reads back. */
export function identical(a: JValue | undefined, b: JValue | undefined): boolean {
  if (a instanceof JNum || b instanceof JNum)
    return a instanceof JNum && b instanceof JNum && a.text === b.text;
  if (isArr(a) || isArr(b))
    return isArr(a) && isArr(b) && a.length === b.length && a.every((v, i) => identical(v, b[i]));
  if (isMap(a) || isMap(b)) {
    if (!isMap(a) || !isMap(b) || a.size !== b.size) return false;
    const bk = [...b.keys()];
    return [...a].every(([k, v], i) => bk[i] === k && identical(v, b.get(k)));
  }
  return a === b;
}

/** How a file is formatted, read from its text so a rewrite looks the same. */
export interface Style {
  /** One level of indentation, like two spaces or a tab. */
  readonly unit: string;
  readonly eol: "\n" | "\r\n";
  readonly finalNewline: boolean;
  /** Whether the file writes some objects on one line, like `{ "type": "string" }`. */
  readonly inlineObjects: boolean;
  /** Whether the file writes some arrays on one line, like `["id", "total"]`. */
  readonly inlineArrays: boolean;
  /** Whether objects on one line have inner spaces, `{ "a": 1 }` rather than `{"a": 1}`. */
  readonly spaced: boolean;
}

/** Reads the formatting of a JSON text: indentation unit, line ending, final newline, short forms. */
export function styleOf(text: string): Style {
  const indented = /\n([ \t]+)\S/.exec(text);
  return {
    unit: indented?.[1] ?? "  ",
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    finalNewline: text.endsWith("\n"),
    inlineObjects: /\{[ \t]*"[^\n]*\}/.test(text),
    inlineArrays: /\[[^\n\]]+\]/.test(text),
    spaced: !/\{"/.test(text),
  };
}

/** Moves the lines of an original text, after its first, from one indentation to another. */
function reindent(slice: string, from: string, to: string): string {
  if (from === to) return slice;
  return slice
    .split("\n")
    .map((line, i) => (i > 0 && line.startsWith(from) ? to + line.slice(from.length) : line))
    .join("\n");
}

/** The text of a scalar, as it was written when it is unchanged. */
function scalarText(value: JValue, raw: string | undefined): string {
  if (value instanceof JNum) return value.text;
  const fresh = JSON.stringify(value);
  if (raw !== undefined && raw === fresh) return raw;
  if (raw !== undefined && typeof value === "string") {
    try {
      if (JSON.parse(raw) === value) return raw;
    } catch {
      // Not a string token: write it fresh.
    }
  }
  return fresh;
}

/** True when a container has no container inside, so it may go on one line. */
function flat(node: JMap | JArr): boolean {
  const values = isMap(node) ? [...node.values()] : node;
  return values.every((v) => !isMap(v) && !isArr(v));
}

/** The line width a changed or new container on one line must fit, unless it was longer already. */
const WIDTH = 100;

/**
 * Writes a tree as JSON text. An untouched container is copied from the text it was read from,
 * a changed one keeps the shape of its original (on one line, or one entry per line), and a
 * new one goes on one line when it is small and flat and the file writes such ones on one line.
 * A container on one line that grows past 100 columns goes on several instead.
 */
export function render(root: JValue, style: Style): string {
  /** Writes `node` starting at column `lead` of a line indented with `indent`. */
  const write = (node: JValue, indent: string, raw: string | undefined, lead: number): string => {
    if (!isMap(node) && !isArr(node)) return scalarText(node, raw);
    const source = sources.get(node);
    if (source !== undefined)
      return reindent(source.text.slice(source.start, source.end), source.indent, indent);
    const origin = origins.get(node);
    const from = origin === undefined ? undefined : sources.get(origin);
    const entries: [string | undefined, JValue][] = isMap(node)
      ? [...node]
      : node.map((v): [undefined, JValue] => [undefined, v]);
    const [open, close] = isMap(node) ? ["{", "}"] : ["[", "]"];
    if (entries.length === 0) return `${open}${close}`;
    const parts = (inner: string, column: number | undefined): string[] =>
      entries.map(([key, value], i) => {
        const same =
          origin !== undefined &&
          (isMap(origin)
            ? key !== undefined && sameValue(origin.get(key), value)
            : sameValue((origin as JArr)[i], value));
        const name = key === undefined ? "" : `${scalarText(key, from?.keys.get(key))}: `;
        const at = (column ?? inner.length) + name.length;
        return name + write(value, inner, same ? from?.raw.get(key ?? i) : undefined, at);
      });
    const short = isMap(node) ? style.inlineObjects : style.inlineArrays;
    const oneLine =
      from === undefined
        ? short && flat(node) && entries.length <= 4
        : !from.text.slice(from.start, from.end).includes("\n");
    if (oneLine) {
      const line = parts(indent, lead + 2);
      const spaced =
        from === undefined ? style.spaced : /^[{[]\s/.test(from.text.slice(from.start));
      const pad = isMap(node) && spaced ? " " : "";
      const text = `${open}${pad}${line.join(", ")}${pad}${close}`;
      const before = from === undefined ? 0 : from.end - from.start;
      if (!text.includes("\n") && (lead + text.length < WIDTH || text.length <= before))
        return text;
    }
    const inner = indent + style.unit;
    const lines = parts(inner, undefined).map((p) => inner + p);
    return `${open}${style.eol}${lines.join(`,${style.eol}`)}${style.eol}${indent}${close}`;
  };
  const text = write(root, "", undefined, 0);
  return style.finalNewline ? `${text}${style.eol}` : text;
}
