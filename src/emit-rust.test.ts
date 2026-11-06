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
  it("are ASCII: quotes and backslashes escaped, every other character as \\u{...}", () => {
    expect(rustString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(rustString("\u0000\u001f\u007f\u0085\u2028\u2029\u00e9\u{1f600}")).toBe(
      '"\\u{0}\\u{1f}\\u{7f}\\u{85}\\u{2028}\\u{2029}\\u{e9}\\u{1f600}"',
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
  it("keep a patterned field a plain String, and make a patterned def a newtype that checks it", () => {
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
    expect(out).toContain("pub struct OrderRef(pub String);\n");
    expect(out).toContain("    pub r#ref: String,\n");
    expect(out).toContain('helpers::within("ref", helpers::check_pattern(&self.r#ref, 0))?;');
    expect(out).toContain('    ("^order\\\\.[^\\u{a}\\u{d}\\u{2028}\\u{2029}]+$", "^order\\\\..+$"),\n');
    expect(out).toContain("pub(super) fn check_pattern(text: &str, index: usize)");
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

  it("check an id's string", () => {
    expect(text("common.rs")).toContain("        helpers::check_length(&self.0, Some(4), None)\n");
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

});

describe("Rust patterns, formats and unique items", () => {
  const entries: JsonObject = {
    item: closed(
      {
        code: { type: "string", maxLength: 4, pattern: "^[A-Z]+$" },
        day: { type: "string", pattern: "^20", format: "date" },
        at: { type: "string", format: "date-time" },
        id: { type: "string", format: "uuid" },
        tags: { type: "array", items: { type: "string", maxLength: 1 }, maxItems: 3, uniqueItems: true },
        byCode: {
          type: "object",
          propertyNames: { type: "string", pattern: "^[a-z]+$" },
          additionalProperties: { type: "integer" },
        },
      },
    ),
    stamp: { type: "string", format: "date-time" },
  };
  const files = emitRust(buildModel(schemaSet({ lib: schema("lib", { $defs: entries }) })));
  const text = (name: string): string => files.find((f) => f.name === name)?.contents ?? "";

  it("check the length, then the pattern, then the format, one after the other", () => {
    const lib = text("lib.rs");
    expect(lib).toContain(
      'helpers::check_length(value, None, Some(4)).and_then(|()| helpers::check_pattern(value, 1))',
    );
    expect(lib).toContain(
      'helpers::check_pattern(value, 0).and_then(|()| helpers::check_date(value))',
    );
    expect(lib).toContain("helpers::check_date_time(value)");
    expect(lib).toContain("helpers::check_uuid(value)");
    expect(lib).toContain(
      "helpers::check_unique_items(value, None, Some(3), |item| helpers::check_length(item, None, Some(1)))",
    );
    expect(lib).toContain("|item| helpers::check_pattern(item, 2)");
  });

  it("make an alias with a format a newtype that checks it", () => {
    expect(text("lib.rs")).toContain("pub struct Stamp(pub String);\n");
    expect(text("lib.rs")).toContain("        helpers::check_date_time(&self.0)\n");
  });

  it("compile the patterns once with the regex crate, from a table in the portable form", () => {
    const helpers = text("helpers.rs");
    expect(helpers).toContain(
      'const PATTERNS: [(&str, &str); 3] = [\n    ("^20", "^20"),\n    ("^[A-Z]+$", "^[A-Z]+$"),\n    ("^[a-z]+$", "^[a-z]+$"),\n];\n',
    );
    expect(helpers).toContain("static COMPILED: std::sync::LazyLock<Vec<regex::Regex>>");
    expect(helpers).toContain("pub(super) fn check_unique_items<T: Serialize>(");
    expect(helpers).toContain("fn canonical(value: &serde_json::Value, out: &mut String) {");
  });

  it("check an id's pattern", () => {
    const ids = emitRust(
      buildModel(
        schemaSet({ common: schema("common", { $defs: { orderId: { type: "string", pattern: "^ord_" } } }) }),
        { ids: { file: "common", suffix: "Id" } },
      ),
    );
    expect(ids.find((f) => f.name === "common.rs")?.contents).toContain("        helpers::check_pattern(&self.0, 0)\n");
  });

  it("depend on regex only when a schema checks a pattern", () => {
    const plain = emitRust(buildModel(schemaSet({ lib: schema("lib", { $defs: { at: entries.stamp ?? {} } }) })));
    const all = plain.map((f) => f.contents).join("\n");
    expect(all).toContain("check_date_time");
    expect(all).not.toContain("regex");
  });

  it("write a long pattern row as rustfmt does, so formatting doesn't change it", () => {
    const long = emitRust(
      buildModel(schemaSet({ lib: schema("lib", { $defs: { s: { type: "string", pattern: "^\\s$" } } }) })),
    );
    expect(long.find((f) => f.name === "helpers.rs")?.contents).toContain(
      '    (\n        "^[\\u{9}-\\u{d} \\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}]$",\n        "^\\\\s$",\n    ),\n',
    );
  });
});

describe("Rust constrained aliases", () => {
  const model = buildModel(
    schemaSet({
      lib: schema("lib", {
        $defs: {
          codes: { type: "array", items: { type: "string", minLength: 3 }, maxItems: 2 },
          code: { type: "string", minLength: 3, maxLength: 3 },
          count: { type: "integer", minimum: 1 },
          ratio: { type: "number", maximum: 1 },
          byCode: {
            type: "object",
            propertyNames: { $ref: "#/$defs/code" },
            additionalProperties: { type: "integer" },
          },
          codeList: { type: "array", items: { $ref: "#/$defs/code" } },
          moreCodes: { $ref: "#/$defs/codes" },
          item: closed({ name: { type: "string", maxLength: 2 } }),
          itemAlias: { $ref: "#/$defs/item" },
          names: { type: "array", items: { type: "string" } },
          holder: closed({ codes: { $ref: "#/$defs/codes" }, more: { $ref: "#/$defs/moreCodes" } }),
        },
      }),
    }),
  );
  const lib = emitRust(model).find((f) => f.name === "lib.rs")?.contents ?? "";
  const registry = emitRustFixtures(model, "crate_name");

  it("make an alias with constraints a newtype whose Decode impl checks them", () => {
    expect(lib).toContain(
      "#[derive(Debug, Clone, PartialEq, Eq, Serialize)]\n#[serde(transparent)]\npub struct Codes(pub Vec<String>);\n\n" +
        "impl helpers::Decode for Codes {\n" +
        "    fn decode_node(node: &helpers::Node<'_>) -> Result<Self, helpers::DecodeError> {\n" +
        "        <Vec<String> as helpers::Decode>::decode_node(node).map(Self)\n    }\n\n" +
        "    fn check(&self) -> Result<(), helpers::DecodeError> {\n" +
        "        helpers::check_items(&self.0, None, Some(2), |item| helpers::check_length(item, Some(3), None))\n    }\n}\n",
    );
    expect(lib).toContain("pub struct Count(pub i64);");
    expect(lib).toContain('        helpers::check_integer(self.0, &[(">=", 1, "1")])\n');
    expect(lib).toContain("pub struct Ratio(pub serde_json::Number);");
    expect(lib).toContain('        helpers::check_number(&self.0, &[("<=", 1.0, "1")])\n');
    expect(lib).not.toContain("pub fn decode_");
  });

  it("order a newtype of a string, so it keys a map, and name its key by the string", () => {
    expect(lib).toContain(
      "#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]\n#[serde(transparent)]\npub struct Code(pub String);",
    );
    expect(lib).toContain("pub struct ByCode(pub BTreeMap<Code, i64>);");
    expect(lib).toContain(
      "helpers::check_entries(&self.0, None, None, |key| key.0.as_str(), helpers::Decode::check, |_| Ok(()))",
    );
  });

  it("make an alias whose constraints are only inside it a newtype too, since Vec doesn't check its items", () => {
    expect(lib).toContain("pub struct CodeList(pub Vec<Code>);");
    expect(lib).toContain("        helpers::check_items(&self.0, None, None, helpers::Decode::check)\n");
  });

  it("keep an alias of another declaration and an alias without constraints plain", () => {
    expect(lib).toContain("pub type MoreCodes = Codes;\n");
    expect(lib).toContain("pub type ItemAlias = Item;\n");
    expect(lib).toContain("pub type Names = Vec<String>;\n");
  });

  it("check a field of a constrained alias through its type", () => {
    expect(lib).toContain('        helpers::within("codes", helpers::Decode::check(value))?;\n');
    expect(lib).toContain('        helpers::within("more", helpers::Decode::check(value))?;\n');
  });

  it("decode every root and def through from_json in the fixture registry", () => {
    expect(registry).toContain('("lib", Some("codes")) => run::<crate_name::Codes>(json),\n');
    expect(registry).toContain('("lib", Some("moreCodes")) => run::<crate_name::MoreCodes>(json),\n');
    expect(registry).not.toContain("encode(crate_name::");
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
