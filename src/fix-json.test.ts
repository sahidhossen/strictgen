import { describe, expect, it } from "vitest";

import type { JMap } from "./fix-json.js";
import {
  edit,
  identical,
  isMap,
  JNum,
  JsonSyntaxError,
  parseJson,
  removeKey,
  render,
  setKey,
  styleOf,
} from "./fix-json.js";

/** A backslash, built so no escape is typed into this file. */
const BS = String.fromCharCode(92);

function root(text: string): JMap {
  const value = parseJson(text);
  if (!isMap(value)) throw new Error("not an object");
  return value;
}

describe("parseJson", () => {
  it("keeps key order, integer-like keys included, and number spelling", () => {
    const value = root('{ "b": 1.0, "1": 2, "a": 1e2 }');
    expect([...value.keys()]).toEqual(["b", "1", "a"]);
    expect(value.get("b")).toEqual(new JNum("1.0"));
    expect((value.get("a") as JNum).value).toBe(100);
  });

  it("reads what JSON.parse reads", () => {
    const text = `{"a":[true,false,null,"x${BS}"y",-0.5e-3,{}],"b":{"c":[]}}`;
    const value = parseJson(text);
    expect(JSON.parse(render(value, styleOf(text)))).toEqual(JSON.parse(text));
  });

  it.each([
    ["{", /unexpected end of the text at line 1, column 2/],
    ['{"a":1,}', /unexpected character "}"/],
    ["[01]", /unexpected character "1"/],
    ['{"a":1} x', /unexpected character "x"/],
    [`${String.fromCharCode(0xfeff)}{}`, /unexpected character U\+FEFF at line 1, column 1/],
    ['{"a":"b', /unterminated string/],
    [`{"a":"${String.fromCharCode(1)}"}`, /invalid string/],
    ['{"a":1,\n "a":2}', /duplicate key "a" at line 2, column 2/],
    [`${"[".repeat(300)}${"]".repeat(300)}`, /nested deeper than 256 levels/],
  ])("rejects %j", (text, message) => {
    expect(() => parseJson(text)).toThrow(JsonSyntaxError);
    expect(() => parseJson(text)).toThrow(message);
  });
});

describe("render", () => {
  it("writes an untouched tree back byte for byte", () => {
    const text = '{\n\t"a" :  [1,2],\r\n\t"b": {"c": "d"}\n}';
    expect(render(parseJson(text), styleOf(text))).toBe(text);
  });

  it("keeps the indentation, line endings and final newline of the file", () => {
    const text =
      '{\r\n\t"type": "object",\r\n\t"properties": {\r\n\t\t"a": { "type": "string" }\r\n\t}\r\n}';
    const next = setKey(root(text), "additionalProperties", false);
    expect(render(next, styleOf(text))).toBe(
      '{\r\n\t"type": "object",\r\n\t"properties": {\r\n\t\t"a": { "type": "string" }\r\n\t},\r\n\t"additionalProperties": false\r\n}',
    );
    const withNewline = `${text}\r\n`;
    expect(render(setKey(root(withNewline), "x", new JNum("1")), styleOf(withNewline))).toMatch(
      /\r\n$/,
    );
  });

  it("keeps an object on one line, with its spacing, and string escapes as written", () => {
    const text = `{ "a": {"b": "${BS}u00e9", "c": 1} }`;
    const value = root(text);
    const next = setKey(value, "a", setKey(value.get("a") as JMap, "d", true));
    expect(render(next, styleOf(text))).toBe(`{ "a": {"b": "${BS}u00e9", "c": 1, "d": true} }`);
  });

  it("re-indents a moved part to its new depth", () => {
    const text = '{\n  "a": {\n    "b": {\n      "c": 1,\n      "d": 2\n    }\n  }\n}\n';
    const value = root(text);
    const b = (value.get("a") as JMap).get("b") ?? null;
    const next = setKey(removeKey(value, "a"), "b", b);
    expect(render(next, styleOf(text))).toBe('{\n  "b": {\n    "c": 1,\n    "d": 2\n  }\n}\n');
  });

  it("breaks a one line object that grows past 100 columns", () => {
    const text =
      '{\n  "a": { "type": "string", "description": "A long description of this field." }\n}\n';
    const value = root(text);
    const a = edit(value.get("a") as JMap, (d) => d.set("pattern", "^[a-z]+$"));
    expect(render(setKey(value, "a", a), styleOf(text))).toBe(
      '{\n  "a": {\n    "type": "string",\n    "description": "A long description of this field.",\n    "pattern": "^[a-z]+$"\n  }\n}\n',
    );
  });

  it("writes new small objects on one line only when the file does", () => {
    const inline = '{\n  "a": { "b": 1 }\n}\n';
    const ref = new Map([["$ref", "#/$defs/x"]]);
    expect(render(setKey(root(inline), "c", ref), styleOf(inline))).toBe(
      '{\n  "a": { "b": 1 },\n  "c": { "$ref": "#/$defs/x" }\n}\n',
    );
    const expanded = '{\n  "a": {\n    "b": 1\n  }\n}\n';
    expect(render(setKey(root(expanded), "c", ref), styleOf(expanded))).toBe(
      '{\n  "a": {\n    "b": 1\n  },\n  "c": {\n    "$ref": "#/$defs/x"\n  }\n}\n',
    );
  });

  it("reads back what it writes", () => {
    const text = '{"1": 1, "a": [1.50, "x"], "b": {}}';
    const value = root(text);
    const next = setKey(value, "c", [new JNum("2.0"), "y"]);
    expect(identical(parseJson(render(next, styleOf(text))), next)).toBe(true);
  });
});
