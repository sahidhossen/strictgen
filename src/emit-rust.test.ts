import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { emitRust, rustString } from "./emit-rust.js";
import { ERROR_CODES, FOUND_MAX, MAX_DEPTH } from "./errors.js";
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

  it("try the variants in decode order, like Go and TypeScript, keeping the first that decodes", () => {
    expect(contents).toContain("impl helpers::Decode for Names {");
    const accountRef = contents.indexOf(
      "if let Ok(value) = <AccountRef as helpers::Decode>::decode_node(node) {\n            return Ok(Self::AccountRef(value));",
    );
    const list = contents.indexOf("if let Ok(value) = <Vec<String> as helpers::Decode>::decode_node(node) {");
    const any = contents.indexOf("if let Ok(value) = <Anything as helpers::Decode>::decode_node(node) {");
    expect(accountRef).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(accountRef);
    expect(any).toBeGreaterThan(list);
  });

  it("fail naming the union when no variant decodes", () => {
    expect(contents).toContain('        Err(helpers::mismatch("Names", node))\n');
  });
});

describe("Rust error codes", () => {
  const files = emitRust(
    buildModel(
      schemaSet({
        lib: schema("lib", {
          $defs: { color: { description: "A color.", enum: ["red", "blue"] } },
        }),
      }),
    ),
  );
  const helpers = files.find((f) => f.name === "helpers.rs")?.contents ?? "";

  it("declare every code as a constant on DecodeError, with its title", () => {
    for (const { code, title } of ERROR_CODES) {
      expect(helpers).toContain(`pub const ${code.toUpperCase()}: &'static str = "${code}";`);
      expect(helpers).toContain(`        "${code}" => "${title}",\n`);
    }
  });

  it("build the message and the compact form like Go and TypeScript", () => {
    expect(helpers).toContain(
      'f.write_str(&describe(&self.path, head, ": ", self.expected.as_deref(), self.found.as_deref()))',
    );
    expect(helpers).toContain(
      'describe(&self.path, self.code, " ", self.expected.as_deref(), self.found.as_deref())',
    );
    expect(helpers).toContain(`const MAX_DEPTH: usize = ${String(MAX_DEPTH)};`);
    expect(helpers).toContain(`const FOUND_MAX: usize = ${String(FOUND_MAX)};`);
  });

  it("re-export the error and the Decode trait from mod.rs", () => {
    expect(files[0]?.contents).toContain("pub use helpers::{Decode, DecodeError, NonNullJson};\n");
  });
});

describe("Rust enums", () => {
  const contents = emitRust(
    buildModel(
      schemaSet({
        lib: schema("lib", {
          $defs: {
            role: { description: "A role.", enum: ["owner", "admin", "a\"b\\c"] },
            only: { description: "One value.", const: "x" },
          },
        }),
      }),
    ),
  ).find((f) => f.name === "lib.rs")?.contents ?? "";

  it("order by the JSON value, so enum-keyed maps encode in code point order", () => {
    expect(contents).toContain("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]\npub enum Role {");
    expect(contents).toContain("impl Ord for Role {");
    expect(contents).toContain("        self.as_str().cmp(other.as_str())\n");
    expect(contents).toContain("impl PartialOrd for Role {");
  });

  it("decode only the listed values, naming them in schema order", () => {
    expect(contents).toContain('            "owner" => Ok(Self::Owner),\n');
    expect(contents).toContain(
      '            other => Err(helpers::not_in_enum(other, &["owner", "admin", "a\\"b\\\\c"])),\n',
    );
    expect(contents).toContain('            other => Err(helpers::not_in_enum(other, &["x"])),\n');
  });
});

describe("Rust string literals", () => {
  it("escape quotes, backslashes, control characters, U+2028 and U+2029", () => {
    expect(rustString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(rustString("\u0000\u001f\u007f\u0085\u2028\u2029é😀")).toBe(
      '"\\u{0}\\u{1f}\\u{7f}\\u{85}\\u{2028}\\u{2029}é😀"',
    );
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

describe("string families", () => {
  it("keep a patterned string a plain String, the pattern not checked yet", () => {
    const model = buildModel(
      schemaSet({
        lib: schema("lib", {
          $defs: {
            orderRef: { type: "string", pattern: "^order\\..+$" },
            note: {
              type: "object",
              properties: { ref: { type: "string", pattern: "^order\\..+$" } },
              required: ["ref"],
              unevaluatedProperties: false,
            },
          },
        }),
      }),
    );
    const out = emitRust(model)
      .map((f) => f.contents)
      .join("\n");
    expect(out).toContain("pub type OrderRef = String;\n");
    expect(out).toContain("    pub r#ref: String,\n");
  });
});

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
    expect(() => lib({ decodeError: { type: "string" } })).toThrow(
      "reserved-name: type name DecodeError is reserved in Rust",
    );
    expect(() => lib({ decode: { type: "string" } })).toThrow(
      "reserved-name: type name Decode is reserved in Rust",
    );
  });

  it("fails on a schema file named like a crate the generated code uses", () => {
    const model = buildModel(schemaSet({ serde: schema("serde", { type: "string" }) }));
    expect(() => emitRust(model)).toThrow(
      "serde.json#: reserved-name: schema file serde has no Rust module name: serde is reserved in Rust. Hint: rename the schema file",
    );
  });
});
