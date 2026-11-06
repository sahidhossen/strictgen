import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { emitRust, emitRustFixtures, rustString } from "./emit-rust.js";
import { ERROR_CODES, FOUND_MAX, MAX_DEPTH } from "./errors.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";

const closed = (properties: JsonObject): JsonObject => ({
  type: "object",
  properties,
  additionalProperties: false,
});

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

describe("Rust report mode", () => {
  const model = buildModel(
    schemaSet({
      lib: schema("lib", {
        $defs: {
          carrier: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
            unevaluatedProperties: false,
          },
          delivery: { oneOf: [{ $ref: "#/$defs/carrier" }, { type: "string" }] },
          contact: {
            type: "object",
            properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
            required: ["name"],
            oneOf: [{ required: ["email"] }, { required: ["phone"] }],
            unevaluatedProperties: false,
          },
        },
      }),
    }),
  );
  const out = (read?: "strict" | "report"): string =>
    emitRust(model, read === undefined ? {} : { read })
      .map((f) => f.contents)
      .join("\n");

  it("leave strict output as it was when read is left out or strict", () => {
    expect(out("strict")).toBe(out());
    expect(out()).not.toContain("set_unknown_key_hook");
    expect(out()).toContain("        object.finish()?;\n");
  });

  it("note unknown keys in finish, passing the keys a sibling branch names", () => {
    const text = out("report");
    expect(text).toContain("        object.finish(&[])?;\n");
    expect(text).toContain('        object.finish(&["phone"])?;\n');
    expect(text).toContain("    pub(super) fn finish(self, forbidden: &[&str]) -> Result<(), DecodeError> {\n");
  });

  it("run each untagged variant through attempt, which drops what a failed one noted", () => {
    const text = out("report");
    expect(text).toContain(
      "        if let Ok(value) = helpers::attempt(|| <Carrier as helpers::Decode>::decode_node(node)) {\n",
    );
    expect(text).toContain("pub(super) fn attempt<T>(");
  });

  it("export the hook, Reported and report_from_json", () => {
    const text = out("report");
    expect(text).toContain(
      "pub use helpers::{Decode, DecodeError, NonNullJson, Reported};\n\n" +
        "// The unknown key hook, which every decode calls with the paths of its unknown keys.\n" +
        "pub use helpers::{clear_unknown_key_hook, set_unknown_key_hook};\n",
    );
    expect(text).toContain(
      "    fn report_from_json(json: impl AsRef<[u8]>) -> Result<Reported<Self>, DecodeError> {\n",
    );
  });

  it("reserve Reported in both modes", () => {
    const lib = buildModel(schemaSet({ lib: schema("lib", { $defs: { reported: { type: "string" } } }) }));
    expect(() => emitRust(lib)).toThrow("reserved-name: type name Reported is reserved in Rust");
  });
});

describe("Rust constraints", () => {
  const model = buildModel(
    schemaSet({
      common: schema("common", {
        $defs: {
          orderId: { type: "string", minLength: 4 },
          plainId: { type: "string" },
        },
      }),
      lib: schema("lib", {
        $defs: {
          item: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 5 },
              count: { type: "integer", minimum: 1, multipleOf: 2 },
              price: { type: "number", exclusiveMinimum: 0, maximum: 1e21 },
              ratio: { type: "number", minimum: -3 },
              tags: { type: "array", items: { type: "string", maxLength: 3 }, maxItems: 2 },
              byId: {
                type: "object",
                propertyNames: { $ref: `${BASE}common.json#/$defs/orderId` },
                additionalProperties: { type: "integer", maximum: 9 },
                minProperties: 1,
              },
              next: { $ref: "#/$defs/item" },
            },
            required: ["name", "count"],
            additionalProperties: false,
          },
          codes: { type: "array", items: { type: "string", minLength: 3 }, maxItems: 2 },
          plain: closed({ name: { type: "string" } }),
        },
      }),
    }),
    { ids: { file: "common", suffix: "Id" } },
  );
  const files = emitRust(model);
  const text = (name: string): string => files.find((f) => f.name === name)?.contents ?? "";

  it("check a struct's fields in schema order, after the whole value decoded", () => {
    const lib = text("lib.rs");
    const name = lib.indexOf('helpers::within("name", helpers::check_length(&self.name, Some(1), Some(5)))?;');
    const count = lib.indexOf(
      'helpers::within("count", helpers::check_integer(self.count, &[(">=", 1, "1"), ("%", 2, "2")]))?;',
    );
    expect(name).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(name);
    expect(lib).toContain(
      'helpers::within("price", helpers::check_number(value, &[(">", 0.0, "0"), ("<=", 1e+21, "1e+21")]))?;',
    );
    expect(lib).toContain('helpers::check_number(value, &[(">=", -3.0, "-3")])');
    expect(lib).toContain(
      'helpers::check_items(value, None, Some(2), |item| helpers::check_length(item, None, Some(3)))',
    );
    expect(lib).toContain(
      'helpers::check_entries(value, Some(1), None, |key| key.0.as_str(), helpers::Decode::check, |item| helpers::check_integer(*item, &[("<=", 9, "9")]))',
    );
    expect(lib).toContain('helpers::within("next", helpers::Decode::check(value))?;');
  });

  it("check an id's string, and give an alias with constraints a decode function", () => {
    expect(text("common.rs")).toContain("        helpers::check_length(&self.0, Some(4), None)\n");
    expect(text("lib.rs")).toContain(
      "pub fn decode_codes(json: impl AsRef<[u8]>) -> Result<Codes, helpers::DecodeError> {\n" +
        "    let value = <Codes as helpers::Decode>::from_json(json)?;\n" +
        "    helpers::check_items(&value, None, Some(2), |item| helpers::check_length(item, Some(3), None))?;\n",
    );
  });

  it("write no check for a type without constraints, and no unused helper", () => {
    const lib = text("lib.rs");
    const plain = lib.slice(lib.indexOf("impl helpers::Decode for Plain {"));
    expect(plain.slice(0, plain.indexOf("\n}\n"))).not.toContain("fn check");
    expect(text("common.rs").slice(text("common.rs").indexOf("for PlainId"))).not.toContain("fn check");
    const helpers = text("helpers.rs");
    for (const used of ["fn within", "fn check_length", "fn check_items", "fn check_entries", "fn check_integer", "fn check_number"]) {
      expect(helpers).toContain(used);
    }
    const none = emitRust(buildModel(schemaSet({ lib: schema("lib", { $defs: { plain: closed({ a: { type: "string" } }) } }) })));
    expect(none.map((f) => f.contents).join("\n")).not.toMatch(/fn (within|check_|limit_error|count)\b/);
  });

  it("call a decode function in the fixture registry for an alias with constraints", () => {
    const registry = emitRustFixtures(model, "crate_name");
    expect(registry).toContain('("lib", Some("codes")) => encode(crate_name::decode_codes(json)),\n');
    expect(registry).toContain('("lib", Some("item")) => run::<crate_name::Item>(json),\n');
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

  it("fails on two aliases whose decode functions share a name", () => {
    expect(() =>
      lib({
        aB: { type: "string", maxLength: 1 },
        ab: { type: "array", items: { type: "string" }, maxItems: 1 },
      }),
    ).toThrow("name-clash: the Rust function decode_ab is also used by lib.json#/$defs/aB");
  });

  it("fails on a schema file named like a crate the generated code uses", () => {
    const model = buildModel(schemaSet({ serde: schema("serde", { type: "string" }) }));
    expect(() => emitRust(model)).toThrow(
      "serde.json#: reserved-name: schema file serde has no Rust module name: serde is reserved in Rust. Hint: rename the schema file",
    );
  });
});
