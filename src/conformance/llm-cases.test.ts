import { describe, expect, it } from "vitest";

import { buildModel } from "../build.js";
import type { Model } from "../model.js";
import type { JsonObject } from "../schema.js";
import { schemaSet } from "../schema.js";
import type { Case, Mark } from "./cases.js";
import { llmCases, SKIPS } from "./llm-cases.js";

const BASE = "https://example.com/schemas/v1/";

function model(files: Readonly<Record<string, JsonObject>>): Model {
  return buildModel(schemaSet(Object.fromEntries(Object.entries(files).map(([name, root]) => [name, { $id: `${BASE}${name}.json`, ...root }]))));
}

/** An order with a map of each kind, an optional key, a union and a wrapped alias, from neutral data. */
const M = model({
  order: {
    title: "Order",
    type: "object",
    properties: {
      id: { type: "string", minLength: 2 },
      note: { type: "string" },
      count: { type: "integer" },
      labels: { type: "object", propertyNames: { type: "string", maxLength: 3 }, additionalProperties: { type: "string", maxLength: 3 } },
      contact: { oneOf: [{ type: "string" }, { type: "object", additionalProperties: { type: "integer" } }] },
    },
    required: ["id"],
    additionalProperties: false,
    $defs: {
      codes: { type: "array", items: { type: "string" }, maxItems: 2 },
      sizes: { type: "object", additionalProperties: { type: "integer" } },
    },
  },
});

const TYPES = new Set(["Order", "Codes", "Sizes"]);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const ok = { accepted: true as const, unknown: [] };

function valid(type: string, json: string, id = `${type}/valid/a`): Case {
  return { id, type, valid: true, bytes: bytes(json), strict: ok, report: ok };
}

function invalid(type: string, json: string, path: string, code: string, id = `${type}/invalid/b`): Case {
  const outcome = { accepted: false as const, path, code };
  return { id, type, valid: false, bytes: bytes(json), strict: outcome, report: { accepted: true, unknown: [path] } };
}

const run = (cases: Case[], shape: "entries" | "objects", marks: Mark[] = [], otherShape = false, skipped = new Map<string, string>()) =>
  llmCases(M, cases, marks, TYPES, { shape, readsEntries: shape === "entries", otherShape }, skipped);

describe("cases in the LLM form", () => {
  it("give null for an absent optional key, entries or objects for maps, and keep the normal JSON to compare with", () => {
    const c = valid("Order", '{"id":"ab","labels":{"x":"y"},"count":1.0}');
    const [entries] = run([c], "entries");
    expect(text(entries?.case.bytes ?? bytes(""))).toBe('{"id":"ab","note":null,"count":1.0,"labels":[{"key":"x","value":"y"}],"contact":null}');
    expect(entries?.case.encodes).toBe(c.bytes);
    const [objects] = run([c], "objects");
    expect(text(objects?.case.bytes ?? bytes(""))).toBe('{"id":"ab","note":null,"count":1.0,"labels":{"x":"y"},"contact":null}');
  });

  it("wrap a type that isn't a struct, and keep a number as it is spelled", () => {
    const [c] = run([valid("Sizes", '{"a":9223372036854775807,"b":-0}')], "entries");
    expect(text(c?.case.bytes ?? bytes(""))).toBe('{"value":[{"key":"a","value":9223372036854775807},{"key":"b","value":-0}]}');
  });

  it("keep an invalid case's strict error, its path moved into the payload", () => {
    const at = (json: string, path: string, code: string, shape: "entries" | "objects" = "entries"): unknown =>
      run([invalid("Order", json, path, code)], shape)[0]?.case.strict;
    // A value of a map read from entries is its entry's value, a key that fails its entry's key.
    expect(at('{"id":"ab","labels":{"a":"long"}}', "/labels/a", "too_long")).toEqual({ accepted: false, path: "/labels/0/value", code: "too_long" });
    expect(at('{"id":"ab","labels":{"long":"a"}}', "/labels/long", "too_long")).toEqual({ accepted: false, path: "/labels/0/key", code: "too_long" });
    expect(at('{"id":"ab","labels":{"long":"a"}}', "/labels/long", "too_long", "objects")).toEqual({ accepted: false, path: "/labels/long", code: "too_long" });
    // Report mode's reading doesn't apply: LLM decoders are strict.
    const [u] = run([invalid("Order", '{"id":"ab","x":1}', "/x", "unknown_key")], "entries");
    expect(u?.case.report).toEqual({ accepted: false, path: "/x", code: "unknown_key" });
    expect(run([invalid("Codes", '["a","b","c"]', "", "too_long")], "entries")[0]?.case.strict).toEqual({ accepted: false, path: "/value", code: "too_long" });
  });

  it("leave out the invalid cases the LLM form changes the meaning of, each with the reason", () => {
    const skipped = new Map<string, string>();
    const cases = [
      invalid("Order", '{"id":"ab","note":null}', "/note", "null_not_allowed", "Order/invalid/null"),
      invalid("Order", '{"id":"ab","id":"cd"}', "/id", "duplicate_key", "Order/invalid/twice"),
      invalid("Order", '{"id":"ab","labels":[]}', "/labels", "wrong_type", "Order/invalid/array"),
    ];
    expect(run(cases, "entries", [], false, skipped).filter((c) => !c.case.valid)).toEqual([]);
    expect(skipped).toEqual(
      new Map([
        ["Order/invalid/null", SKIPS.null],
        ["Order/invalid/twice", SKIPS.text],
        ["Order/invalid/array", SKIPS.entries],
      ]),
    );
    // Code that reads only objects takes an array for a map as the wrong type it is.
    const objects = llmCases(M, [cases[2] as Case], [], TYPES, { shape: "objects", readsEntries: false });
    expect(objects[0]?.case.strict).toEqual({ accepted: false, path: "/labels", code: "wrong_type" });
  });

  it("add the near misses only the LLM form has, labelled by hand", () => {
    const misses = run([valid("Sizes", '{"a":1}')], "entries")
      .slice(1)
      .map((c) => [c.case.id.replace("Sizes/valid/a (llm: ", "").replace(/\)$/, ""), text(c.case.bytes), c.case.strict]);
    expect(misses).toEqual([
      ["no value key", "{}", { accepted: false, path: "/value", code: "missing_key" }],
      ["a key beside value", '{"value":[{"key":"a","value":1}],"extra":1}', { accepted: false, path: "/extra", code: "unknown_key" }],
      ["the value without the object around it", '[{"key":"a","value":1}]', { accepted: false, path: "", code: "wrong_type" }],
      ["a string for the entries at /value", '{"value":"text"}', { accepted: false, path: "/value", code: "wrong_type" }],
      ["the first entry at /value again", '{"value":[{"key":"a","value":1},{"key":"a","value":1}]}', { accepted: false, path: "/value/1/key", code: "duplicate_key" }],
      ["no key in the entry at /value/0", '{"value":[{"value":1}]}', { accepted: false, path: "/value/0/key", code: "missing_key" }],
      ["no value in the entry at /value/0", '{"value":[{"key":"a"}]}', { accepted: false, path: "/value/0/value", code: "missing_key" }],
      ["a third key in the entry at /value/0", '{"value":[{"key":"a","value":1,"note":"x"}]}', { accepted: false, path: "/value/0/note", code: "unknown_key" }],
      ["a number for the key at /value/0", '{"value":[{"key":12,"value":1}]}', { accepted: false, path: "/value/0/key", code: "wrong_type" }],
      ["an array for the entry at /value/0", '{"value":[[]]}', { accepted: false, path: "/value/0", code: "wrong_type" }],
      ["the last character cut off", '{"value":[{"key":"a","value":1}]', { accepted: false, path: "", code: "invalid_json" }],
      ['the key "value" twice', '{"value":[{"key":"a","value":1}],"value":[{"key":"a","value":1}]}', { accepted: false, path: "/value", code: "duplicate_key" }],
    ]);
  });

  it("give an invalid case that fails a constraint a third key in its first entry, which fails first", () => {
    const strict = (c: Case): [string, string, unknown] => [c.id, text(c.bytes), c.strict];
    // The constraint is on the root's first key, which the checks read before the map.
    const first = run([invalid("Order", '{"id":"a","labels":{"x":"y"}}', "/id", "too_short")], "entries").map((c) => strict(c.case));
    expect(first).toEqual([
      ["Order/invalid/b", '{"id":"a","note":null,"count":null,"labels":[{"key":"x","value":"y"}],"contact":null}', { accepted: false, path: "/id", code: "too_short" }],
      [
        "Order/invalid/b (llm: a third key in the entry at /labels/0, which fails before the too_short)",
        '{"id":"a","note":null,"count":null,"labels":[{"key":"x","value":"y","note":"x"}],"contact":null}',
        { accepted: false, path: "/labels/0/note", code: "unknown_key" },
      ],
    ]);
    // The constraint is in the same entry, whose value is read before its keys are closed.
    const same = run([invalid("Order", '{"id":"ab","labels":{"x":"long"}}', "/labels/x", "too_long")], "entries");
    expect(same.map((c) => c.case.strict)).toEqual([
      { accepted: false, path: "/labels/0/value", code: "too_long" },
      { accepted: false, path: "/labels/0/note", code: "unknown_key" },
    ]);
    // None for objects, an error of the structure, or a map inside a union.
    expect(run([invalid("Order", '{"id":"a","labels":{"x":"y"}}', "/id", "too_short")], "objects")).toHaveLength(1);
    expect(run([invalid("Order", '{"id":"ab","labels":{"x":1}}', "/labels/x", "wrong_type")], "entries")).toHaveLength(1);
    expect(run([invalid("Order", '{"id":"a","contact":{"x":1}}', "/id", "too_short")], "entries")).toHaveLength(1);
  });

  it("give a decoder that reads one shape a case's one map in the other shape too", () => {
    const one = run([valid("Order", '{"id":"ab","labels":{"x":"y"}}')], "entries", [], true);
    const other = one.find((c) => c.case.id.endsWith("(llm: the map at /labels as an object)"));
    expect(other?.case.strict).toEqual({ accepted: false, path: "/labels", code: "wrong_type" });
    expect(text(other?.case.bytes ?? bytes(""))).toContain('"labels":{"x":"y"}');
    // A map inside a union fails the union, not the map, so it gets none.
    const union = run([valid("Order", '{"id":"ab","contact":{"a":1}}')], "objects", [], true);
    expect(union.some((c) => c.case.id.includes(" as "))).toBe(false);
  });

  it("move a mark's path with the case, and make no near misses of a case a language is held apart on", () => {
    const c = valid("Sizes", '{"a":9223372036854775807}');
    const mark: Mark = { case: c.id, kind: "ts-unsafe-integer", path: "/a", reason: "why" };
    const [only, ...rest] = run([c], "entries", [mark]);
    expect(only?.marks).toEqual([{ ...mark, path: "/value/0/value" }]);
    expect(only?.origin.get(only.marks[0] as Mark)).toBe(mark);
    expect(rest).toEqual([]);
  });
});
