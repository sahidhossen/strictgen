import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { emitRust } from "./emit-rust.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

function schema(name: string, body: JsonObject): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${BASE}${name}.json`,
    title: name,
    description: `The ${name} schema.`,
    ...body,
  };
}

describe("untagged unions", () => {
  const model = buildModel(
    schemaSet({
      common: schema("common", {
        $defs: {
          accountRef: {
            description: "An account reference.",
            type: "object",
            properties: { $account: { description: "The path.", type: "string" } },
            required: ["$account"],
            unevaluatedProperties: false,
          },
          names: {
            description: "Names, or an account reference.",
            oneOf: [
              { type: "array", items: { type: "string" } },
              { $ref: "#/$defs/accountRef" },
              { description: "Anything.", $ref: "#/$defs/anything" },
            ],
          },
          anything: { description: "Any JSON.", not: { const: null } },
        },
      }),
    }),
  );
  const contents = emitRust(model).find((f) => f.name.endsWith("common.rs"))?.contents ?? "";

  it("decode by the value's JSON kind, so a struct never reads an array, in decode order", () => {
    expect(contents).toContain("impl<'de> Deserialize<'de> for Names {");
    const accountRef = contents.indexOf(
      "if value.is_object()\n            && let Ok(inner) = <AccountRef>::deserialize(&value)",
    );
    const list = contents.indexOf(
      "if value.is_array()\n            && let Ok(inner) = <Vec<String>>::deserialize(&value)",
    );
    expect(accountRef).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(accountRef);
  });

  it("try a branch of any JSON without a kind check, and fail like serde when nothing fits", () => {
    expect(contents).toMatch(/if let Ok\(inner\) = <\w+>::deserialize\(&value\) \{/);
    expect(contents).toContain('"data did not match any variant of untagged enum Names"');
  });
});

describe("the JSON kind each variant takes", () => {
  const model = buildModel(
    schemaSet({
      common: schema("common", {
        $defs: {
          color: { description: "A color.", enum: ["red", "blue"] },
          userId: { description: "A user id.", type: "string" },
          words: { description: "Words.", type: "array", items: { type: "string" } },
          labels: {
            description: "Labels.",
            type: "object",
            additionalProperties: { type: "string" },
          },
          shape: {
            description: "A shape.",
            oneOf: ["dot", "line"].map((kind) => ({
              type: "object",
              properties: { kind: { const: kind } },
              required: ["kind"],
              unevaluatedProperties: false,
            })),
          },
          loose: { description: "Loose.", oneOf: [{ type: "string" }, { not: { const: null } }] },
          numbers: { description: "N.", oneOf: [{ type: "integer" }, { type: "boolean" }] },
          measures: { description: "M.", oneOf: [{ type: "number" }, { $ref: "#/$defs/color" }] },
          lists: {
            description: "Co.",
            oneOf: [{ $ref: "#/$defs/words" }, { $ref: "#/$defs/labels" }],
          },
          nested: {
            description: "Ne.",
            oneOf: [{ $ref: "#/$defs/shape" }, { $ref: "#/$defs/loose" }],
          },
          one: {
            description: "O.",
            oneOf: [{ const: 1 }, { type: "array", items: { type: "string" } }],
          },
          yes: {
            description: "Y.",
            oneOf: [{ const: true }, { type: "array", items: { type: "string" } }],
          },
          target: { description: "T.", oneOf: [{ $ref: "#/$defs/userId" }, { type: "boolean" }] },
        },
      }),
    }),
  );
  const contents = emitRust(model).find((f) => f.name.endsWith("common.rs"))?.contents ?? "";
  const tries = (kind: string, type: string): string =>
    `if value.is_${kind}()\n            && let Ok(inner) = <${type}>::deserialize(&value)`;

  it.each([
    ["integer", "number", "i64"],
    ["boolean", "boolean", "bool"],
    ["number", "number", "serde_json::Number"],
    ["enum", "string", "Color"],
    ["id", "string", "UserId"],
    ["alias of an array", "array", "Words"],
    ["map", "object", "Labels"],
    ["tagged union", "object", "Shape"],
    ["integer literal", "number", "ConstInt<1>"],
    ["boolean literal", "boolean", "ConstBool<true>"],
  ])("checks a %s variant is %s", (_name, kind, type) => {
    expect(contents).toContain(tries(kind, type));
  });

  it("skips the check for a nested union that takes any JSON", () => {
    expect(contents).toContain("if let Ok(inner) = <Loose>::deserialize(&value) {");
  });
});

/** A closed object whose keys are keywords in Rust, Go or TypeScript. */
const keywordFields: JsonObject = {
  type: "object",
  properties: {
    type: { type: "string" },
    match: { type: "string" },
    func: { type: "string" },
    default: { type: "boolean" },
    self: { type: "string" },
    crate: { type: "string" },
  },
  required: ["type", "default"],
  unevaluatedProperties: false,
};

describe("reserved names", () => {
  const lib = (entries: JsonObject) =>
    emitRust(buildModel(schemaSet({ lib: schema("lib", { $defs: entries }) })));

  it("escapes a field named like a keyword instead of failing", () => {
    const out = lib({ rule: keywordFields })
      .map((f) => f.contents)
      .join("\n");
    expect(out).toContain("    pub r#type: String,\n");
    expect(out).toContain("    pub r#match: Option<String>,\n");
    expect(out).toContain("    pub func: Option<String>,\n");
    expect(out).toContain("    pub default: bool,\n");
    // self and crate can't be raw identifiers, so they get a trailing underscore.
    expect(out).toContain("    pub self_: Option<String>,\n");
    expect(out).toContain("    pub crate_: Option<String>,\n");
  });

  it("fails on a type named like a keyword", () => {
    expect(() => lib({ self: { type: "string" } })).toThrow(
      "lib.json#/$defs/self: reserved-name: type name Self is reserved in Rust. Hint: rename the $defs entry",
    );
  });

  it("fails on a type named like a helper of the generated module", () => {
    expect(() => lib({ nonNullJson: { type: "string" } })).toThrow(
      "reserved-name: type name NonNullJson is reserved in Rust",
    );
    expect(() => lib({ deserialize: { type: "string" } })).toThrow(
      "reserved-name: type name Deserialize is reserved in Rust",
    );
  });

  it("fails on a schema file named like a crate the generated code uses", () => {
    const model = buildModel(schemaSet({ serde: schema("serde", { type: "string" }) }));
    expect(() => emitRust(model)).toThrow(
      "serde.json#: reserved-name: schema file serde has no Rust module name: serde is reserved in Rust. Hint: rename the schema file",
    );
  });
});
