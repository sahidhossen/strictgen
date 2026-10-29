import { describe, expect, it } from "vitest";

import { HEADER } from "./common.js";
import { emitRustSchemas, minified } from "./emit-schemas.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

const point: JsonObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `${BASE}point.json`,
  title: "Point",
  description: "A point.",
  $comment: "Kept short.",
  type: "object",
  properties: {
    title: { description: "A key named title.", type: "string", default: "x" },
    description: { type: "string", examples: ["y"] },
    tag: { const: { title: "a const keeps its keys" } },
  },
  allOf: [{ description: "In a list.", required: ["title"] }],
  $defs: { label: { title: "Label", type: "string", pattern: "^[a-z#\u200b]+$" } },
};

describe("minified", () => {
  it("drops annotations where a schema sits, and keeps keys and values that share their names", () => {
    expect(JSON.parse(minified(point))).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `${BASE}point.json`,
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        tag: { const: { title: "a const keeps its keys" } },
      },
      allOf: [{ required: ["title"] }],
      $defs: { label: { type: "string", pattern: "^[a-z#\u200b]+$" } },
    });
  });

  it("strips under every schema-valued keyword, and keeps true, false and plain values", () => {
    const doc = { description: "d" };
    expect(
      JSON.parse(
        minified({
          if: { ...doc, required: ["a"] },
          then: { ...doc, minProperties: 1 },
          else: { ...doc, maxProperties: 1 },
          not: { ...doc, const: null },
          items: { ...doc, type: "string" },
          additionalProperties: false,
          unevaluatedProperties: true,
          propertyNames: { ...doc, pattern: "^a" },
          dependentSchemas: { a: { ...doc, required: ["b"] } },
          oneOf: [true, { ...doc, type: "null" }],
          enum: [{ description: "an enum value keeps its keys" }],
        }),
      ),
    ).toEqual({
      if: { required: ["a"] },
      then: { minProperties: 1 },
      else: { maxProperties: 1 },
      not: { const: null },
      items: { type: "string" },
      additionalProperties: false,
      unevaluatedProperties: true,
      propertyNames: { pattern: "^a" },
      dependentSchemas: { a: { required: ["b"] } },
      oneOf: [true, { type: "null" }],
      enum: [{ description: "an enum value keeps its keys" }],
    });
  });

  it("writes ASCII only, escaping everything else as JSON does", () => {
    const text = minified({ pattern: "\u00e9\u200b\u{1f600}" });
    expect(text).toBe('{"pattern":"\\u00e9\\u200b\\ud83d\\ude00"}');
    expect(JSON.parse(text)).toEqual({ pattern: "\u00e9\u200b\u{1f600}" });
  });
});

describe("emitRustSchemas", () => {
  const set = schemaSet({
    point,
    common: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `${BASE}common.json`,
      $defs: {},
    },
  });
  const file = emitRustSchemas(set);

  it("lists every schema by name, sorted, as raw strings", () => {
    expect(file.name).toBe("schemas.rs");
    expect(file.contents.startsWith(`${HEADER}\n`)).toBe(true);
    const common = file.contents.indexOf('("common", r');
    expect(common).toBeGreaterThan(0);
    expect(file.contents.indexOf('("point", r')).toBeGreaterThan(common);
  });

  it("uses enough hashes that the text can't end the raw string", () => {
    const hashed = emitRustSchemas(
      schemaSet({ x: { $id: `${BASE}x.json`, pattern: '"#' } }),
    ).contents;
    expect(hashed).toContain(`("x", r##"{"$id":"${BASE}x.json","pattern":"\\"#"}"##),`);
  });
});
