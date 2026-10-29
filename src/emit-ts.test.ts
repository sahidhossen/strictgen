import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { emitTypeScript } from "./emit-ts.js";
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

/** Every TypeScript file the emitter writes for a definitions-only schema named `lib`, joined. */
function lib(entries: JsonObject): string {
  return emitTypeScript(buildModel(schemaSet({ lib: schema("lib", { $defs: entries }) })))
    .map((f) => f.contents)
    .join("\n");
}

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
  it("keeps a property named like a keyword, which TypeScript allows", () => {
    const out = lib({ rule: keywordFields });
    expect(out).toContain("  type: string;\n");
    expect(out).toContain("  match?: string;\n");
    expect(out).toContain("  func?: string;\n");
    expect(out).toContain("  default: boolean;\n");
    expect(out).toContain("  self?: string;\n");
  });

  it("quotes a key that is not an identifier", () => {
    const out = lib({
      rule: {
        type: "object",
        properties: { "content-type": { type: "string" } },
        unevaluatedProperties: false,
      },
    });
    expect(out).toContain('  "content-type"?: string;\n');
  });

  it("fails on a type named like a global type the output uses", () => {
    expect(() => lib({ record: { type: "string" } })).toThrow(
      "lib.json#/$defs/record: reserved-name: type name Record is reserved in TypeScript. Hint: rename the $defs entry",
    );
    expect(() => lib({ partial: { type: "string" } })).toThrow(
      "type name Partial is reserved in TypeScript",
    );
  });

  it("allows type names other languages reserve", () => {
    expect(lib({ self: { type: "string" }, decodeError: { type: "string" } })).toContain(
      "export type Self = string;\n",
    );
  });
});
