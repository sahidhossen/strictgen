import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { HEADER } from "./common.js";
import { emitRust, emitRustRoots } from "./emit-rust.js";
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

describe("emitRustRoots", () => {
  const model = buildModel(
    schemaSet({
      point: schema("point", {
        type: "object",
        properties: { x: { description: "X.", type: "integer" } },
        required: ["x"],
        unevaluatedProperties: false,
        $defs: { label: { description: "A label.", type: "string" } },
      }),
      common: schema("common", {
        $defs: { name: { description: "A name.", type: "string" } },
      }),
    }),
  );
  const file = emitRustRoots(model);

  it("decodes each schema with a root type by its name, strictly", () => {
    expect(file.name).toBe("roots.rs");
    expect(file.contents.startsWith(`${HEADER}\n`)).toBe(true);
    expect(file.contents).toContain('"point" => run::<crate::Point>(bytes),');
    expect(file.contents).toContain("crate::json::decode(bytes)?");
  });

  it("leaves out defs and definitions-only schemas", () => {
    expect(file.contents).not.toContain('"common"');
    expect(file.contents).not.toContain("Label");
  });
});

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
