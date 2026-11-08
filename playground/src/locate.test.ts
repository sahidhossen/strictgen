import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MAX_DEPTH } from "../../src/errors.js";
import { defaultSettings, generateInMemory, MEMORY_DIRS } from "../../src/memory.js";
import { evaluate, transpiler } from "./decode.js";
import type { Located, Span } from "./locate.js";
import { errorSpan, locate, schemaSpan, spanAt } from "./locate.js";
import { SAMPLE } from "./sample.js";

/** Odd characters are made here, never typed into the file. */
const BS = String.fromCharCode(0x5c);
const u = (hex: string): string => `${BS}u${hex}`;
const ASTRAL = String.fromCodePoint(0x1f600);
const BOM = String.fromCharCode(0xfeff);
const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);

/** The strict reader the generated TypeScript uses, from the generated helpers.ts. */
const reader = (() => {
  const files = generateInMemory({
    schemas: SAMPLE.schemas,
    settings: defaultSettings({ read: "strict", profiles: [], cleanup: false, serdeBridge: false }),
  }).files;
  const helpers = files.find((f) => f.path === `${MEMORY_DIRS.typescript}/helpers.ts`);
  if (helpers === undefined) throw new Error("no helpers.ts");
  const exports: Record<string, unknown> = {};
  evaluate(transpiler(ts)(helpers.contents, "helpers.ts"), exports, () => {
    throw new Error("helpers.ts imports nothing");
  });
  return exports.fromJson as (text: string, decode: (json: unknown) => unknown) => unknown;
})();

type Read = { ok: true; value: unknown } | { ok: false; path: string; code: string; offset: number };

function strictRead(text: string): Read {
  try {
    return { ok: true, value: reader(text, (json) => json) };
  } catch (error) {
    const e = error as { path: string; code: string; found?: string };
    const offset = /at offset (\d+)$/.exec(e.found ?? "")?.[1];
    if (offset === undefined) throw new Error(`no offset in ${String(e.found)}`);
    return { ok: false, path: e.path, code: e.code, offset: Number(offset) };
  }
}

/** UTF-8 bytes before a UTF-16 position, as the reader counts its offsets. */
function bytesBefore(text: string, at: number): number {
  return new TextEncoder().encode(text.slice(0, at)).length;
}

/** The value at a JSON Pointer in a read value. */
function valueAt(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let node = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    node = Array.isArray(node) ? node[Number(key)] : (node as Record<string, unknown>)[key];
  }
  return node;
}

function slice(text: string, span: Span | null): string | null {
  return span === null ? null : text.slice(span.from, span.to);
}

function places(located: Located): ReadonlyMap<string, { value: Span; key: Span | null }> {
  if (!located.ok) throw new Error(`stopped at ${String(located.at)}`);
  return located.places;
}

const deep = (n: number): string => "[".repeat(n) + "]".repeat(n);

/** Texts the reader accepts. */
const VALID = [
  "0",
  " -0.5e+10 ",
  "true",
  "null",
  '""',
  `"${u("d83d")}${u("de00")} ${ASTRAL} ${BS}n ${BS}${BS} ${BS}/"`,
  '{"a": [1, {"b": null}, "x"], "c": {}}',
  `{"${ASTRAL}": {"${u("0061")}~/": [true, false]}, "z": ${ASTRAL.length}}`,
  `{"a": 1, "${u("0062")}": 2, "__proto__": {"constructor": 3}}`,
  `[${"1, ".repeat(20)}2]`,
  deep(MAX_DEPTH - 1),
  `\n\t{\r\n "k" : [ ] }\n`,
];

/** Texts the reader rejects, each for its own reason. */
const INVALID = [
  "",
  " ",
  "01",
  "-",
  "1.",
  "1e",
  "1e999",
  "-1e400",
  "tru",
  "nul",
  "[1,]",
  "[1 2]",
  '{"a" 1}',
  '{"a": 1,}',
  '{a: 1}',
  '{"a": 1} x',
  '{"a": 1, "a": 2}',
  `{"a": 1, "${u("0061")}": 2}`,
  `{"x": {"k": 1, "k": 1}}`,
  `"${BS}x"`,
  `"${BS}u12g4"`,
  `"${u("de00")}"`,
  `"${u("d83d")}x"`,
  `"${u("d83d")}${u("0041")}"`,
  `"${LONE_HIGH}"`,
  `[1, "${LONE_LOW}"]`,
  `${BOM}{}`,
  '"a\tb"',
  '"unterminated',
  `{"${ASTRAL}": [1, 2,, 3]}`,
  deep(MAX_DEPTH),
  `{"a": ${deep(MAX_DEPTH + 3)}}`,
];

describe("locate, with the strict reader's grammar", () => {
  it("accepts every text the generated reader accepts, and gives the place of every value", () => {
    for (const text of VALID) {
      const read = strictRead(text);
      expect(read.ok, text).toBe(true);
      if (!read.ok) continue;
      const found = places(locate(text));
      for (const [pointer, place] of found) {
        // Each place, read on its own, is the value the reader gave at that pointer.
        const alone = strictRead(text.slice(place.value.from, place.value.to));
        expect(alone, `${text} ${pointer}`).toEqual({ ok: true, value: valueAt(read.value, pointer) });
        if (place.key !== null) {
          const key = strictRead(text.slice(place.key.from, place.key.to));
          const last = pointer.slice(pointer.lastIndexOf("/") + 1).replaceAll("~1", "/").replaceAll("~0", "~");
          expect(key, `${text} ${pointer}`).toEqual({ ok: true, value: last });
        }
      }
      // And every value has a place: the count matches the values in the read value.
      const count = (v: unknown): number =>
        1 + (typeof v === "object" && v !== null ? Object.values(v).reduce<number>((n, c) => n + count(c), 0) : 0);
      expect(found.size, text).toBe(count(read.value));
    }
  });

  it("stops where the generated reader stops, for every text it rejects", () => {
    for (const text of INVALID) {
      const read = strictRead(text);
      expect(read.ok, JSON.stringify(text)).toBe(false);
      const located = locate(text);
      expect(located.ok, JSON.stringify(text)).toBe(false);
      if (read.ok || located.ok) continue;
      expect(bytesBefore(text, located.at), JSON.stringify(text)).toBe(read.offset);
    }
  });

  it("counts positions in UTF-16 units, so astral characters and escapes before a value don't shift it", () => {
    const text = `{"${ASTRAL}${u("00e9")}": "${ASTRAL}", "n": [7]}`;
    const found = places(locate(text));
    expect(slice(text, found.get("/n/0")?.value ?? null)).toBe("7");
    expect(slice(text, found.get(`/${ASTRAL}${String.fromCharCode(0xe9)}`)?.value ?? null)).toBe(`"${ASTRAL}"`);
  });
});

describe("locate, with JSON.parse's grammar for schemas", () => {
  it("accepts exactly what JSON.parse accepts, and stops where it says it stops", () => {
    let compared = 0;
    for (const text of [...VALID, ...INVALID]) {
      let message: string | undefined;
      try {
        JSON.parse(text);
      } catch (error) {
        message = (error as Error).message;
      }
      const located = locate(text, "parse");
      expect(located.ok, JSON.stringify(text)).toBe(message === undefined);
      // V8 gives a position for most errors ("at position 3"), and none for some ("Unexpected token").
      const position = /at position (\d+)/.exec(message ?? "")?.[1];
      if (!located.ok && position !== undefined) {
        expect(located.at, JSON.stringify(text)).toBe(Number(position));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("keeps the later of two equal keys, as JSON.parse does", () => {
    const text = '{"a": {"old": 1}, "b": 2, "a": {"new": 3}}';
    const found = places(locate(text, "parse"));
    expect(slice(text, found.get("/a")?.value ?? null)).toBe('{"new": 3}');
    expect(found.has("/a/old")).toBe(false);
    expect(slice(text, found.get("/a/new")?.value ?? null)).toBe("3");
  });
});

describe("spanAt", () => {
  const text = '{"order": {"lines": [{"sku": "A"}], "a/b~c": 1}}';
  const located = locate(text);

  it("marks the value at a pointer, or its key", () => {
    expect(slice(text, spanAt(located, text.length, "/order/lines/0/sku"))).toBe('"A"');
    expect(slice(text, spanAt(located, text.length, "/order/lines/0/sku", "key"))).toBe('"sku"');
    expect(slice(text, spanAt(located, text.length, "/order/a~1b~0c"))).toBe("1");
    expect(slice(text, spanAt(located, text.length, ""))).toBe(text);
  });

  it("marks the nearest value above a pointer that isn't there, by its key or its first character", () => {
    expect(slice(text, spanAt(located, text.length, "/order/lines/0/quantity"))).toBe("{");
    expect(slice(text, spanAt(located, text.length, "/order/total"))).toBe('"order"');
    expect(slice(text, spanAt(located, text.length, "/missing"))).toBe("{");
    expect(slice(text, spanAt(located, text.length, "/order/lines/5"))).toBe('"lines"');
  });

  it("marks nothing in text that doesn't read, or in no text", () => {
    expect(spanAt(locate("{"), 1, "")).toBeNull();
    expect(spanAt({ ok: true, places: new Map([["", { value: { from: 0, to: 0 }, key: null }]]) }, 0, "")).toBeNull();
  });
});

describe("errorSpan", () => {
  const payload = `{"note": "${ASTRAL}", "lines": [{"sku": "A", "quantity": 0}], "extra": true}`;

  it("marks the value of a value error and the key of a key error", () => {
    expect(slice(payload, errorSpan(payload, { path: "/lines/0/quantity", code: "too_small" }))).toBe("0");
    expect(slice(payload, errorSpan(payload, { path: "/extra", code: "unknown_key" }))).toBe('"extra"');
    expect(slice(payload, errorSpan(payload, { path: "/payment", code: "missing_key" }))).toBe("{");
    expect(slice(payload, errorSpan(payload, { path: "/lines/0/price", code: "missing_key" }))).toBe("{");
  });

  it("marks where the reader stopped for a reading error", () => {
    const broken = `{"note": "${ASTRAL}", "n": 01}`;
    expect(slice(broken, errorSpan(broken, { path: "/n", code: "invalid_json" }))).toBe("1");
    const twice = `{"${ASTRAL}": 1, "${u("d83d")}${u("de00")}": 2}`;
    expect(slice(twice, errorSpan(twice, { path: `/${ASTRAL}`, code: "duplicate_key" }))).toBe(`"${u("d83d")}${u("de00")}"`);
    const end = '{"a": [1, ';
    expect(slice(end, errorSpan(end, { path: "/a/1", code: "invalid_json" }))).toBe(" ");
    const tooDeep = `{"a": ${deep(MAX_DEPTH)}}`;
    const at = tooDeep.indexOf("[") + MAX_DEPTH - 2;
    expect(errorSpan(tooDeep, { path: "/a/0", code: "too_deep" })).toEqual({ from: at, to: at + 1 });
  });

  it("marks only a path the text has when another step changed the text before reading", () => {
    const fenced = "```json\n{\"a\": 1}\n```";
    expect(errorSpan(fenced, { path: "", code: "invalid_json" }, false)).toBeNull();
    expect(slice(payload, errorSpan(payload, { path: "/lines/0/quantity", code: "too_small" }, false))).toBe("0");
  });

  it("marks nothing for a reading error in an empty payload", () => {
    expect(errorSpan("", { path: "", code: "invalid_json" })).toBeNull();
  });
});

describe("schemaSpan", () => {
  const schema = `{\n  "$defs": {\n    "line": {"type": "object", "if": {}}\n  }\n}\n`;

  it("marks the key that names the schema or keyword at fault", () => {
    expect(slice(schema, schemaSpan(schema, "/$defs/line/if"))).toBe('"if"');
    expect(slice(schema, schemaSpan(schema, "/$defs/line"))).toBe('"line"');
    expect(slice(schema, schemaSpan(schema, ""))).toBe("{");
  });

  it("marks where JSON.parse stops when the file isn't JSON", () => {
    const broken = schema.replace('"object",', '"object"');
    expect(slice(broken, schemaSpan(broken, null))).toBe('"');
    expect(schemaSpan(schema, null)).toBeNull();
  });
});
