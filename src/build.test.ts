import { describe, expect, it } from "vitest";

import type { IdRule } from "./build.js";
import { buildModel } from "./build.js";
import type { EmittedFile } from "./common.js";
import { HEADER } from "./common.js";
import { emitRust } from "./emit-rust.js";
import { emitTypeScript } from "./emit-ts.js";
import type { Decl, Model } from "./model.js";
import type { Json, JsonObject } from "./schema.js";
import { CodegenError, schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";
/** The ID rule the mapping tests run with: defs of common.json ending in `Id`. */
const IDS: IdRule = { file: "common", suffix: "Id" };

function schema(name: string, body: JsonObject): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${BASE}${name}.json`,
    title: name,
    description: `The ${name} schema.`,
    ...body,
  };
}

/** A definitions-only schema named `lib`. */
function defs(entries: JsonObject): Record<string, JsonObject> {
  return { lib: schema("lib", { $defs: entries }) };
}

/** Every file an emitter writes, joined, for checking snippets. */
function joined(files: readonly EmittedFile[]): string {
  return files.map((f) => `// file: ${f.name}\n${f.contents}`).join("\n");
}

function rustOf(model: Model): string {
  return joined(emitRust(model));
}

function tsOf(model: Model): string {
  return joined(emitTypeScript(model));
}

function build(files: Record<string, JsonObject>, ids: IdRule | undefined = IDS): Model {
  return buildModel(schemaSet(files), ids === undefined ? {} : { ids });
}

function find(model: Model, name: string): Decl {
  const decl = model.decls.find((d) => d.name === name);
  if (decl === undefined)
    throw new Error(`no decl ${name} in ${model.decls.map((d) => d.name).join(", ")}`);
  return decl;
}

function failure(files: Record<string, JsonObject>): CodegenError {
  try {
    build(files);
  } catch (error) {
    if (error instanceof CodegenError) return error;
    throw error;
  }
  throw new Error("expected a CodegenError");
}

const accountRef: JsonObject = {
  description: "An account reference.",
  type: "object",
  properties: { $account: { description: "Path.", type: "string" } },
  required: ["$account"],
  unevaluatedProperties: false,
};
const currencyCode: JsonObject = { description: "A currency.", type: "string", pattern: "^[A-Z]{3}$" };
const currencyAmounts: JsonObject = {
  description: "Amount per currency.",
  type: "object",
  propertyNames: { $ref: "#/$defs/currencyCode" },
  additionalProperties: { type: "string" },
};

describe("closed objects", () => {
  const model = build(
    defs({
      point: {
        description: "A point.",
        type: "object",
        properties: {
          x: { description: "X.", type: "integer" },
          y: { description: "Y.", type: "integer" },
        },
        required: ["x"],
        unevaluatedProperties: false,
      },
      empty: { description: "Nothing.", type: "object", unevaluatedProperties: false },
    }),
  );

  it("become closed structs with required and optional fields", () => {
    const point = find(model, "Point");
    expect(point).toMatchObject({
      kind: "struct",
      closed: true,
      source: { schema: "lib", def: "point" },
    });
    expect(point.kind === "struct" && point.fields.map((f) => [f.name, f.required])).toEqual([
      ["x", true],
      ["y", false],
    ]);
  });

  it("reject unknown keys in Rust and mark optional keys in both languages", () => {
    const rust = rustOf(model);
    expect(rust).toContain('#[serde(rename_all = "camelCase")]\npub struct Point {');
    expect(rust).toContain("    pub x: i64,\n");
    expect(rust).toContain(
      '    #[serde(skip_serializing_if = "Option::is_none")]\n    pub y: Option<i64>,\n',
    );
    expect(rust).toContain(
      '            x: object.required("x")?,\n            y: object.optional("y")?,\n        };\n        object.finish()?;\n',
    );
    const ts = tsOf(model);
    expect(ts).toContain(
      "export interface Point {\n  /** X. */\n  x: number;\n  /** Y. */\n  y?: number;\n}\n",
    );
  });

  it("type an empty closed object as a record of never in TypeScript", () => {
    expect(tsOf(model)).toContain("export type Empty = Record<string, never>;");
    expect(rustOf(model)).toContain("pub struct Empty {}");
  });
});

describe("allOf bases", () => {
  const files = defs({
    base: {
      description: "Shared keys.",
      type: "object",
      properties: {
        key: { description: "Key.", type: "string" },
        hidden: { description: "Hidden.", type: "boolean" },
      },
    },
    textField: {
      description: "A text field.",
      type: "object",
      allOf: [{ $ref: "#/$defs/base" }],
      properties: { key: true, max: { description: "Max.", type: "integer" } },
      required: ["key"],
      unevaluatedProperties: false,
    },
  });

  it("are inlined into the struct, keeping the base schema for keys redeclared as true", () => {
    const decl = find(build(files), "TextField");
    expect(
      decl.kind === "struct" &&
        decl.fields.map((f) => `${f.name}:${f.type.kind}:${String(f.required)}`),
    ).toEqual(["key:string:true", "hidden:boolean:false", "max:integer:false"]);
    expect(decl).toMatchObject({ closed: true });
  });

  it("emit no type for an open base, which is only inlined", () => {
    expect(build(files).decls.map((d) => d.name)).toEqual(["TextField"]);
  });

  it("reject additionalProperties false beside an allOf base", () => {
    const bad = defs({
      base: { type: "object", properties: { key: { type: "string" } } },
      child: { type: "object", allOf: [{ $ref: "#/$defs/base" }], additionalProperties: false },
    });
    expect(failure(bad).path).toBe("lib.json#/$defs/child/additionalProperties");
  });

  it("reject a property redeclared with another schema", () => {
    const bad = defs({
      base: { type: "object", properties: { key: { type: "string" } } },
      child: {
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        properties: { key: { type: "integer" } },
        unevaluatedProperties: false,
      },
    });
    expect(failure(bad).path).toBe("lib.json#/$defs/child/properties/key");
  });
});

const paymentDefs: JsonObject = {
  cardPayment: {
    description: "A card payment.",
    type: "object",
    properties: {
      type: { description: "Type.", const: "card" },
      installments: { description: "Installments.", type: "integer" },
    },
    required: ["type", "installments"],
    unevaluatedProperties: false,
  },
  wirePayment: {
    description: "An image.",
    type: "object",
    properties: {
      type: { description: "Type.", const: "wire" },
      iban: { description: "IBAN.", type: "string" },
    },
    required: ["type"],
    unevaluatedProperties: false,
  },
};

describe("const-tagged oneOf", () => {
  const model = build({
    payment: schema("payment", {
      title: "Payment",
      oneOf: [{ $ref: "#/$defs/cardPayment" }, { $ref: "#/$defs/wirePayment" }],
      $defs: paymentDefs,
    }),
  });

  it("becomes a tagged union whose branches keep their tag", () => {
    expect(find(model, "Payment")).toMatchObject({
      kind: "tagged",
      tag: "type",
      variants: [
        { value: "card", type: "CardPayment" },
        { value: "wire", type: "WirePayment" },
      ],
    });
    expect(find(model, "CardPaymentType")).toMatchObject({ kind: "enum", values: ["card"] });
  });

  it("decodes in Rust by reading the tag first", () => {
    const rust = rustOf(model);
    expect(rust).toContain("impl helpers::Decode for Payment {");
    expect(rust).toContain('match helpers::tag(node, "type")? {');
    expect(rust).toContain(
      '"card" => <CardPayment as helpers::Decode>::decode_node(node).map(Self::Card),',
    );
    expect(rust).toContain('other => Err(helpers::bad_tag("type", other, &["card", "wire"])),');
  });

  it("is a discriminated union in TypeScript", () => {
    const ts = tsOf(model);
    expect(ts).toContain("export type Payment = CardPayment | WirePayment;");
    expect(ts).toContain('export type CardPaymentType = "card";');
  });

  it("spreads nested unions that share the tag", () => {
    const nested = build({
      payment: schema("payment", {
        title: "Payment",
        oneOf: [{ $ref: "#/$defs/card" }, { $ref: "#/$defs/wirePayment" }],
        $defs: {
          ...paymentDefs,
          card: { description: "Cards.", oneOf: [{ $ref: "#/$defs/cardPayment" }] },
        },
      }),
    });
    expect(find(nested, "Payment")).toMatchObject({
      kind: "tagged",
      variants: [{ value: "card" }, { value: "wire" }],
    });
  });
});

describe("untagged oneOf", () => {
  const model = build(
    defs({
      currencyCode,
      currencyAmounts,
      accountRef,
      amountsOrRef: {
        description: "Amounts or an account reference.",
        oneOf: [{ $ref: "#/$defs/currencyAmounts" }, { $ref: "#/$defs/accountRef" }],
      },
      scalar: {
        description: "A value.",
        oneOf: [
          { type: "boolean" },
          { type: "number" },
          { type: "string" },
          { type: "integer" },
          { type: "array", items: { type: "string" } },
        ],
      },
    }),
  );

  it("tries an object with required keys before a map", () => {
    expect(find(model, "AmountsOrRef")).toMatchObject({
      kind: "untagged",
      variants: [{ name: "AccountRef" }, { name: "CurrencyAmounts" }],
    });
    expect(rustOf(model)).toContain(
      "#[serde(untagged)]\npub enum AmountsOrRef {\n    /// A `AccountRef`.\n    AccountRef(AccountRef),\n    /// A `CurrencyAmounts`.\n    CurrencyAmounts(CurrencyAmounts),\n}",
    );
  });

  it("orders arrays, strings, integers, numbers and booleans", () => {
    const decl = find(model, "Scalar");
    expect(decl.kind === "untagged" && decl.variants.map((v) => v.name)).toEqual([
      "List",
      "String",
      "Integer",
      "Number",
      "Boolean",
    ]);
    expect(tsOf(model)).toContain(
      "export type Scalar = string[] | string | number | number | boolean;",
    );
  });
});

describe("exactly-one oneOf of required keys", () => {
  const model = build(
    defs({
      linkTarget: {
        description: "A link.",
        type: "object",
        properties: {
          href: { description: "URL.", type: "string" },
          userId: { description: "User.", type: "string" },
          target: { description: "Window.", enum: ["_self", "_blank"] },
        },
        oneOf: [
          { properties: { href: true }, required: ["href"] },
          { properties: { userId: true }, required: ["userId"] },
        ],
        unevaluatedProperties: false,
      },
    }),
  );

  it("becomes one closed struct per choice, which forbids the other keys", () => {
    expect(find(model, "LinkTarget")).toMatchObject({
      kind: "untagged",
      variants: [{ name: "Href" }, { name: "UserId" }],
    });
    expect(find(model, "LinkTargetHref")).toMatchObject({
      kind: "struct",
      closed: true,
      forbidden: ["userId"],
    });
    const ts = tsOf(model);
    expect(ts).toContain("  href: string;\n");
    expect(ts).toContain("  userId?: never;\n");
  });

  it("names a _self variant without clashing with Self", () => {
    expect(rustOf(model)).toContain('    #[serde(rename = "_self")]\n    SelfValue,');
  });

  it("needs a closed object", () => {
    const open = defs({
      link: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        oneOf: [{ required: ["a"] }, { required: ["b"] }],
      },
    });
    expect(failure(open)).toMatchObject({
      rule: "open-object",
      reason: "objects must be closed, unless only used as an allOf base",
      hint: 'add "additionalProperties": false',
    });
  });

  it("allows an at least one anyOf, a rule the types don't carry", () => {
    const rule = build(
      defs({
        flagRule: {
          type: "object",
          properties: { if: { type: "string" }, rollout: { type: "integer" } },
          anyOf: [{ required: ["if"] }, { required: ["rollout"] }],
          unevaluatedProperties: false,
        },
      }),
    );
    expect(find(rule, "FlagRule")).toMatchObject({ kind: "struct" });
    expect(rustOf(rule)).toContain("    pub r#if: Option<String>,\n");
  });
});

describe("maps", () => {
  const model = build(
    defs({
      currencyCode,
      currencyAmounts,
      weekday: { description: "A day.", enum: ["mon", "tue"] },
      hours: {
        description: "Hours per day.",
        type: "object",
        propertyNames: { $ref: "#/$defs/weekday" },
        additionalProperties: { type: "integer" },
      },
      metadata: {
        description: "Any metadata.",
        type: "object",
        additionalProperties: { not: { const: null } },
      },
    }),
  );

  it("keep a propertyNames key type", () => {
    expect(find(model, "CurrencyAmounts")).toMatchObject({
      kind: "alias",
      type: { kind: "map", key: { kind: "ref", name: "CurrencyCode" }, value: { kind: "string" } },
    });
    // CurrencyCode checks its pattern, so in Rust the map is a type of its own that checks it.
    expect(rustOf(model)).toContain("pub struct CurrencyAmounts(pub BTreeMap<CurrencyCode, String>);");
    expect(tsOf(model)).toContain("export type CurrencyAmounts = Record<CurrencyCode, string>;");
  });

  it("allow missing keys in TypeScript when keys are an enum", () => {
    expect(tsOf(model)).toContain("export type Hours = Partial<Record<Weekday, number>>;");
  });

  it("use string keys when only additionalProperties is given", () => {
    expect(rustOf(model)).toContain("pub type Metadata = BTreeMap<String, NonNullJson>;");
  });

  it("can sit beside named keys, like default beside currencies", () => {
    const priced = build(
      defs({
        currencyCode,
        prices: {
          description: "Price per currency.",
          type: "object",
          propertyNames: {
            type: "string",
            anyOf: [{ const: "default" }, { $ref: "#/$defs/currencyCode" }],
          },
          properties: { default: { description: "Fallback.", type: "string" } },
          additionalProperties: { type: "string" },
          required: ["default"],
        },
      }),
    );
    expect(find(priced, "Prices")).toMatchObject({
      kind: "struct",
      rest: { key: { kind: "ref", name: "CurrencyCode" }, value: { kind: "string" } },
    });
    const rust = rustOf(priced);
    expect(rust).toContain("    pub rest: BTreeMap<CurrencyCode, String>,");
    expect(rust).toContain("            rest: object.rest()?,\n");
    expect(tsOf(priced)).toContain("  default: string;\n  [key: string]: string;\n");
  });
});

describe("aliases and JSON values", () => {
  const model = build(
    defs({
      currencyCode,
      settlementCurrency: { description: "Same as a currency.", $ref: "#/$defs/currencyCode" },
      anyValue: { description: "Any JSON, null included." },
      jsonValue: { description: "Any JSON but null.", not: { const: null } },
      version: { description: "The version.", const: 1 },
      flag: { description: "Always true.", const: true },
    }),
  );

  it("make a def that is only a $ref an alias", () => {
    expect(find(model, "SettlementCurrency")).toMatchObject({
      kind: "alias",
      type: { kind: "ref", name: "CurrencyCode" },
    });
    expect(rustOf(model)).toContain("pub type SettlementCurrency = CurrencyCode;");
    expect(tsOf(model)).toContain("export type SettlementCurrency = CurrencyCode;");
  });

  it("keep null in anyValue and reject it in jsonValue", () => {
    expect(rustOf(model)).toContain("pub type AnyValue = serde_json::Value;");
    expect(rustOf(model)).toContain("pub type JsonValue = NonNullJson;");
    expect(tsOf(model)).toContain("export type AnyValue = unknown;");
    expect(tsOf(model)).toContain("export type JsonValue = NonNullable<unknown>;");
  });

  it("type integer and boolean consts as literals in TypeScript", () => {
    expect(tsOf(model)).toContain("export type Version = 1;");
    expect(tsOf(model)).toContain("export type Flag = true;");
    expect(rustOf(model)).toContain("pub type Version = ConstInt<1>;");
    expect(rustOf(model)).toContain("pub type Flag = ConstBool<true>;");
    expect(rustOf(model)).toContain("pub struct ConstInt<const N: i64>;");
    expect(rustOf(model)).toContain("pub struct ConstBool<const B: bool>;");
  });
});

describe("numbers", () => {
  const model = build(
    defs({
      size: {
        description: "A size.",
        type: "object",
        properties: {
          width: { description: "W.", type: "integer" },
          ratio: { description: "R.", type: "number" },
        },
        required: ["width", "ratio"],
        unevaluatedProperties: false,
      },
    }),
  );

  it("keep integers as i64 and numbers in their JSON spelling", () => {
    const rust = rustOf(model);
    expect(rust).toContain("    pub width: i64,\n");
    expect(rust).toContain("    pub ratio: serde_json::Number,\n");
    expect(tsOf(model)).toContain("  width: number;\n");
  });
});

describe("string families", () => {
  const model = build(
    defs({
      orderRef: { description: "An order reference.", type: "string", pattern: "^order\\..+$" },
      code: { description: "A code.", type: "string", pattern: "^[A-Z]{3}$" },
      byRef: {
        description: "Counts by order.",
        type: "object",
        propertyNames: { type: "string", pattern: "^order\\." },
        additionalProperties: { type: "integer" },
      },
    }),
  );

  it("keep a string's pattern in the model, for map keys too", () => {
    expect(find(model, "OrderRef")).toMatchObject({
      kind: "alias",
      type: { kind: "string", pattern: "^order\\..+$" },
    });
    expect(find(model, "ByRef")).toMatchObject({
      kind: "alias",
      type: { kind: "map", key: { kind: "string", pattern: "^order\\." } },
    });
  });

  it("type a family as a template literal in TypeScript only, a checked string in Rust", () => {
    expect(tsOf(model)).toContain("export type OrderRef = `order.${string}`;\n");
    expect(tsOf(model)).toContain("export type Code = string;\n");
    expect(rustOf(model)).toContain("pub struct OrderRef(pub String);\n");
  });

  it("keep the family type with validation off, when nothing checks the pattern", () => {
    const off = buildModel(
      schemaSet(defs({ orderRef: { type: "string", pattern: "^order\\..+$" } })),
      { validation: false },
    );
    expect(tsOf(off)).toContain("export type OrderRef = `order.${string}`;\n");
    expect(rustOf(off)).toContain("pub type OrderRef = String;\n");
  });
});

describe("if/then", () => {
  const files = {
    commands: schema("commands", {
      title: "Batch",
      type: "object",
      properties: {
        kind: { description: "Kind.", enum: ["order", "user"] },
        commands: { description: "Commands.", type: "array" },
      },
      required: ["kind", "commands"],
      unevaluatedProperties: false,
      allOf: [
        {
          if: { properties: { kind: { const: "order" } }, required: ["kind"] },
          then: { properties: { commands: { items: { $ref: "#/$defs/orderCommand" } } } },
        },
        {
          if: { properties: { kind: { const: "user" } }, required: ["kind"] },
          then: { properties: { commands: { items: { $ref: "#/$defs/userCommand" } } } },
        },
      ],
      $defs: {
        orderCommand: { description: "Order commands.", oneOf: [{ $ref: "#/$defs/createOrder" }] },
        userCommand: { description: "User commands.", oneOf: [{ $ref: "#/$defs/renameUser" }] },
        createOrder: {
          description: "Insert.",
          type: "object",
          properties: { op: { description: "Op.", const: "createOrder" } },
          required: ["op"],
          unevaluatedProperties: false,
        },
        renameUser: {
          description: "Rename a user.",
          type: "object",
          properties: { op: { description: "Op.", const: "renameUser" } },
          required: ["op"],
          unevaluatedProperties: false,
        },
      },
    }),
  };

  it("lift array items only a then branch declares into one tagged union", () => {
    const model = build(files);
    const batch = find(model, "Batch");
    expect(batch.kind === "struct" && batch.fields[1]?.type).toEqual({
      kind: "array",
      items: { kind: "ref", name: "BatchCommandsItem" },
    });
    expect(find(model, "BatchCommandsItem")).toMatchObject({
      kind: "tagged",
      tag: "op",
      variants: [
        { value: "createOrder", type: "CreateOrder" },
        { value: "renameUser", type: "RenameUser" },
      ],
    });
  });

  /** The commands schema with a shipment batch whose then branch allows `items`. */
  function withShipmentBatch(items: JsonObject): Record<string, JsonObject> {
    const root = structuredClone(files.commands) as Record<string, Json>;
    (root.properties as Record<string, Json>).kind = {
      description: "Kind.",
      enum: ["order", "shipment", "user"],
    };
    (root.allOf as JsonObject[]).push({
      if: { properties: { kind: { const: "shipment" } }, required: ["kind"] },
      then: { properties: { commands: { items } } },
    });
    return { commands: root };
  }

  it("make one variant of a def that two then branches both allow", () => {
    const model = build(withShipmentBatch({ oneOf: [{ $ref: "#/$defs/createOrder" }] }));
    expect(find(model, "BatchCommandsItem")).toMatchObject({
      kind: "tagged",
      variants: [
        { value: "createOrder", type: "CreateOrder" },
        { value: "renameUser", type: "RenameUser" },
      ],
    });
  });

  it("reject a def that one then branch repeats, even one an earlier branch allows", () => {
    const insert = { $ref: "#/$defs/createOrder" };
    expect(failure(withShipmentBatch({ oneOf: [insert, insert] })).message).toContain(
      "repeat its values",
    );
  });

  it("reject a conditional property the object doesn't declare", () => {
    const bad = defs({
      thing: {
        type: "object",
        properties: { kind: { type: "string" } },
        if: { properties: { kind: { const: "a" } } },
        then: { properties: { extra: true }, required: ["extra"] },
        unevaluatedProperties: false,
      },
    });
    expect(failure(bad).path).toBe("lib.json#/$defs/thing/then/properties/extra");
  });
});

describe("recursion", () => {
  it("boxes only the back edge of a cycle", () => {
    const model = build(
      defs({
        filter: {
          description: "A filter.",
          oneOf: [{ $ref: "#/$defs/notFilter" }, { $ref: "#/$defs/andFilter" }],
        },
        andFilter: {
          description: "And.",
          type: "object",
          properties: {
            and: { description: "All.", type: "array", items: { $ref: "#/$defs/filter" } },
          },
          required: ["and"],
          unevaluatedProperties: false,
        },
        notFilter: {
          description: "Not.",
          type: "object",
          properties: { not: { description: "Inner.", $ref: "#/$defs/filter" } },
          required: ["not"],
          unevaluatedProperties: false,
        },
      }),
    );
    const not = find(model, "NotFilter");
    expect(not.kind === "struct" && not.fields[0]?.boxed).toBe(true);
    const filter = find(model, "Filter");
    expect(filter.kind === "untagged" && filter.variants.some((v) => v.boxed)).toBe(false);
    expect(rustOf(model)).toContain("    pub not: Box<Filter>,\n");
  });

  it("rejects an alias that contains itself", () => {
    expect(
      failure(defs({ list: { type: "array", items: { $ref: "#/$defs/list" } } })).message,
    ).toContain("alias List contains itself");
  });
});

describe("names", () => {
  it("prefix defs whose names clash across files with the file name", () => {
    const model = build({
      a: schema("a", { $defs: { pointer: { type: "string" } } }),
      b: schema("b", { $defs: { pointer: { type: "string" } } }),
    });
    expect(model.decls.map((d) => d.name)).toEqual(["APointer", "BPointer"]);
  });

  it("name a typed root after its title and hoist inline types after their owner", () => {
    const model = build({
      account: schema("account", {
        title: "Account settings",
        type: "object",
        properties: { mode: { description: "Mode.", enum: ["a", "b"] } },
        unevaluatedProperties: false,
      }),
    });
    expect(model.decls.map((d) => d.name)).toEqual(["AccountSettings", "AccountSettingsMode"]);
  });

  it("reject a hoisted name that clashes with a def", () => {
    const bad = defs({
      thing: {
        type: "object",
        properties: { mode: { enum: ["a"] } },
        unevaluatedProperties: false,
      },
      thingMode: { type: "string" },
    });
    expect(failure(bad).message).toContain("type name ThingMode is also used by");
  });
});

describe("unsupported constructs", () => {
  const cases: [string, JsonObject, string][] = [
    ["an unknown keyword", { $dynamicRef: "#x" }, "lib.json#/$defs/x/$dynamicRef"],
    ["a type list", { type: ["string", "null"] }, "lib.json#/$defs/x/type"],
    [
      "an open object",
      { type: "object", properties: {}, additionalProperties: true },
      "lib.json#/$defs/x/additionalProperties",
    ],
    ["a not that isn't null", { not: { type: "string" } }, "lib.json#/$defs/x/not"],
    ["an array without items", { type: "array" }, "lib.json#/$defs/x"],
    ["an object const", { const: { a: 1 } }, "lib.json#/$defs/x/const"],
    ["a numeric enum", { enum: [1, 2] }, "lib.json#/$defs/x/enum/0"],
    ["an unknown format", { type: "string", format: "email" }, "lib.json#/$defs/x/format"],
    ["a remote $ref", { $ref: "https://example.com/x.json" }, "lib.json#/$defs/x"],
    ["a $ref with other siblings", { $ref: "#/$defs/y", enum: ["a"] }, "lib.json#/$defs/x/enum"],
    [
      "a required key without a property",
      { type: "object", required: ["a"], unevaluatedProperties: false },
      "lib.json#/$defs/x/required",
    ],
    [
      "propertyNames without values",
      { type: "object", properties: {}, propertyNames: { type: "string" } },
      "lib.json#/$defs/x/propertyNames",
    ],
    [
      "a mixed anyOf",
      {
        type: "object",
        properties: { a: { type: "string" } },
        anyOf: [{ type: "object" }],
        unevaluatedProperties: false,
      },
      "lib.json#/$defs/x/anyOf/0/type",
    ],
    [
      "an integer map key",
      {
        type: "object",
        propertyNames: { type: "integer" },
        additionalProperties: { type: "string" },
      },
      "lib.json#/$defs/x/propertyNames",
    ],
    [
      "a oneOf beside an array type",
      { type: "array", items: { type: "string" }, oneOf: [{ type: "string" }] },
      "lib.json#/$defs/x/oneOf",
    ],
  ];

  it.each(cases)("throws on %s with the schema path", (_, body, path) => {
    const error = failure(defs({ x: body, y: { type: "string" } }));
    expect(error.path).toBe(path);
  });

  it("throws when a typed schema has no title", () => {
    const root: JsonObject = { $id: `${BASE}x.json`, type: "string" };
    expect(failure({ x: root }).path).toBe("x.json#/title");
  });
});

describe("determinism", () => {
  const files = {
    payment: schema("payment", {
      title: "Payment",
      oneOf: [{ $ref: "#/$defs/cardPayment" }, { $ref: "#/$defs/wirePayment" }],
      $defs: paymentDefs,
    }),
    ...defs({ currencyCode, currencyAmounts, accountRef }),
  };

  it("emits the same output on every run and for any input key order", () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    const first = build(files);
    expect(rustOf(build(reversed))).toBe(rustOf(first));
    expect(tsOf(build(reversed))).toBe(tsOf(first));
    expect(rustOf(build(files))).toBe(rustOf(first));
  });

  it("sorts declarations by name", () => {
    const names = build(files).decls.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });
});

describe("open objects", () => {
  const open: JsonObject = { type: "object", properties: { a: { type: "string" } } };
  const base: JsonObject = { type: "object", properties: { a: { type: "string" } } };
  const user: JsonObject = {
    type: "object",
    allOf: [{ $ref: "#/$defs/base" }],
    unevaluatedProperties: false,
  };

  it.each([
    ["a def", { x: open }, "lib.json#/$defs/x"],
    [
      "a field",
      { x: { type: "object", properties: { f: open }, unevaluatedProperties: false } },
      "lib.json#/$defs/x/properties/f",
    ],
    ["an array item", { x: { type: "array", items: open } }, "lib.json#/$defs/x/items"],
    ["a union branch", { x: { oneOf: [open, { type: "string" }] } }, "lib.json#/$defs/x/oneOf/0"],
    [
      "a map value",
      { x: { type: "object", additionalProperties: open } },
      "lib.json#/$defs/x/additionalProperties",
    ],
  ])("fail as %s", (_, entries, path) => {
    expect(failure(defs(entries as JsonObject))).toMatchObject({
      path,
      rule: "open-object",
      reason: "objects must be closed, unless only used as an allOf base",
      hint: 'add "additionalProperties": false',
    });
  });

  it("fail as a root type", () => {
    expect(failure({ thing: schema("thing", open) }).path).toBe("thing.json#");
  });

  it("fail when a $ref uses an open base as a value", () => {
    const bad = defs({
      base,
      user,
      holder: {
        type: "object",
        properties: { b: { $ref: "#/$defs/base" } },
        unevaluatedProperties: false,
      },
    });
    expect(failure(bad).path).toBe("lib.json#/$defs/holder/properties/b");
  });
});

describe("ids", () => {
  const model = build({
    common: schema("common", {
      $defs: {
        orderId: { description: "An order id.", type: "string", pattern: "^ord_" },
        label: { type: "string" },
      },
    }),
  });

  it("are newtypes in Rust and branded strings in TypeScript", () => {
    expect(find(model, "OrderId")).toMatchObject({ kind: "id" });
    expect(find(model, "Label")).toMatchObject({ kind: "alias" });
    expect(rustOf(model)).toContain("#[serde(transparent)]\npub struct OrderId(pub String);");
    expect(rustOf(model)).toContain(
      "#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]\n#[serde(transparent)]",
    );
    expect(tsOf(model)).toContain(
      'export type OrderId = string & { readonly __brand: "OrderId" };',
    );
  });

  it("must be strings", () => {
    const bad = { common: schema("common", { $defs: { orderId: { type: "integer" } } }) };
    expect(failure(bad).path).toBe("common.json#/$defs/orderId");
  });

  it("are off by default, so a def ending in Id is a plain alias", () => {
    const files = {
      common: schema("common", { $defs: { orderId: { type: "string" }, count: { type: "integer" } } }),
    };
    const off = buildModel(schemaSet(files));
    expect(find(off, "OrderId")).toMatchObject({ kind: "alias", type: { kind: "string" } });
    expect(off.decls.some((d) => d.kind === "id")).toBe(false);
    expect(rustOf(off)).not.toContain("pub struct OrderId(pub String);");
  });

  it("follow a custom file and suffix", () => {
    const ids: IdRule = { file: "keys", suffix: "Key" };
    const model = build(
      {
        keys: schema("keys", {
          $defs: { userKey: { type: "string" }, orderKey: { type: "string" }, label: { type: "string" } },
        }),
        common: schema("common", { $defs: { orderId: { type: "string" } } }),
      },
      ids,
    );
    expect(find(model, "UserKey")).toMatchObject({ kind: "id" });
    expect(find(model, "OrderKey")).toMatchObject({ kind: "id" });
    expect(find(model, "Label")).toMatchObject({ kind: "alias" });
    expect(find(model, "OrderId")).toMatchObject({ kind: "alias" });
    expect(rustOf(model)).toContain("#[serde(transparent)]\npub struct UserKey(pub String);");
    const bad = { keys: schema("keys", { $defs: { userKey: { type: "boolean" } } }) };
    expect(() => build(bad, ids)).toThrow(
      "keys.json#/$defs/userKey: type-mismatch: an id must be a string. Hint: ",
    );
  });
});

describe("more unsupported constructs", () => {
  it("a def that is a $ref to itself", () => {
    expect(failure(defs({ x: { $ref: "#/$defs/x" } })).path).toBe("lib.json#/$defs/x/$ref");
  });

  it("a map key $ref that isn't a string", () => {
    const bad = defs({
      n: { type: "integer" },
      m: {
        type: "object",
        propertyNames: { $ref: "#/$defs/n" },
        additionalProperties: { type: "string" },
      },
    });
    expect(failure(bad).path).toBe("lib.json#/$defs/m/propertyNames");
  });

  it("a tag only some branches carry", () => {
    const branch = (props: JsonObject, required: string[]): JsonObject => ({
      type: "object",
      properties: props,
      required,
      unevaluatedProperties: false,
    });
    const bad = defs({
      a: branch({ kind: { const: "a" } }, ["kind"]),
      b: branch({ name: { type: "string" } }, ["name"]),
      u: { oneOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }] },
    });
    expect(failure(bad).message).toContain("branches carry the tag kind only partly");
  });

  it("a def a plain oneOf repeats", () => {
    const bad = defs({
      a: {
        type: "object",
        properties: { kind: { const: "a" } },
        required: ["kind"],
        unevaluatedProperties: false,
      },
      u: { oneOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/a" }] },
    });
    expect(failure(bad).message).toContain("repeat its values");
  });

  it("a const whose type disagrees", () => {
    expect(failure(defs({ x: { type: "string", const: 1 } })).path).toBe("lib.json#/$defs/x/type");
  });

  it("a type named like a Rust built in", () => {
    const model = build(defs({ option: { description: "Clash.", type: "string" } }));
    expect(() => rustOf(model)).toThrow(
      "lib.json#/$defs/option: reserved-name: type name Option is reserved in Rust. Hint: rename",
    );
  });
});

describe("named keys beside a map of the other keys", () => {
  it("serialize through a guard so a named key is never written twice", () => {
    const model = build(
      defs({
        prices: {
          type: "object",
          properties: {
            default: { description: "Fallback.", type: "string" },
            size: { type: "integer" },
          },
          additionalProperties: { type: "string" },
          required: ["default"],
        },
      }),
    );
    const rust = rustOf(model);
    expect(rust).toContain("impl Serialize for Prices {");
    expect(rust).toContain('        map.serialize_entry("default", &self.default)?;\n');
    expect(rust).toContain("        if let Some(value) = &self.size {\n");
    expect(rust).toContain('                && ["default", "size"].contains(&name.as_str())\n');
    expect(rust).toContain("#[derive(Debug, Clone, PartialEq, Eq)]\npub struct Prices {");
  });
});

describe("one file per schema", () => {
  const files = {
    common: schema("common", {
      $defs: { orderId: { type: "string" }, anyValue: {}, flag: { const: true } },
    }),
    "item-list": schema("item-list", {
      title: "Item list",
      type: "object",
      properties: {
        ids: { type: "array", items: { $ref: `${BASE}common.json#/$defs/orderId` } },
        value: { $ref: `${BASE}common.json#/$defs/anyValue` },
        by: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["ids"],
      unevaluatedProperties: false,
    }),
  };
  const model = build(files);

  it("writes a Rust module per schema that imports what it uses from the others", () => {
    const out = emitRust(model);
    expect(out.map((f) => f.name)).toEqual(["mod.rs", "helpers.rs", "common.rs", "item_list.rs"]);
    const itemList = out[3]?.contents ?? "";
    expect(itemList).toContain("//! Types for `item-list.json`.\n");
    expect(itemList).toContain(
      "use super::common::{AnyValue, OrderId};\nuse super::helpers;\nuse serde::Serialize;\nuse std::collections::BTreeMap;\n",
    );
    const common = out[2]?.contents ?? "";
    expect(common).toContain("use super::helpers::{self, ConstBool};\nuse serde::Serialize;\n\n");
  });

  it("declares the modules in mod.rs with the clippy allows and re-exports every type", () => {
    const root = emitRust(model)[0]?.contents ?? "";
    expect(root).toContain("#![allow(clippy::doc_markdown");
    expect(root).toContain("mod helpers;\nmod common;\nmod item_list;\n");
    expect(root).toContain(
      "pub use common::*;\npub use item_list::*;\npub use helpers::{ConstBool, Decode, DecodeError, NonNullJson};\n",
    );
  });

  it("keeps the shared Rust helpers in one module, visible to the others", () => {
    const helpers = emitRust(model)[1]?.contents ?? "";
    expect(helpers).toContain("pub struct NonNullJson(pub serde_json::Value);");
    expect(helpers).toContain("pub(super) struct Object<'n, 'a> {");
    expect(helpers).toContain("pub struct ConstBool<const B: bool>;");
    expect(helpers).toContain("pub trait Decode: Sized {");
    // Only the parts some declaration uses, so the module has no dead code.
    expect(helpers).not.toContain("ConstInt");
    expect(helpers).not.toContain("fn tag");
    expect(helpers).not.toContain("fn rest");
    expect(helpers).not.toContain("fn not_in_enum");
  });

  it("refuses a schema without a Rust module name", () => {
    const bad = build({ helpers: schema("helpers", { $defs: { x: { type: "string" } } }) });
    expect(() => emitRust(bad)).toThrow("schema file helpers has no Rust module name");
  });

  it("writes a TypeScript file per schema with type imports and an index", () => {
    const out = emitTypeScript(model, { decoders: false });
    expect(out.map((f) => f.name)).toEqual(["common.ts", "item-list.ts", "index.ts"]);
    expect(out[1]?.contents).toContain(
      '/** Types for `item-list.json`. */\n\nimport type { AnyValue, OrderId } from "./common.js";\n\n',
    );
    expect(out[0]?.contents).not.toContain("import");
    expect(out[2]?.contents).toBe(
      `${HEADER}\n\nexport * from "./common.js";\nexport * from "./item-list.js";\n`,
    );
  });

  it("imports the decoders it calls from other files, and writes helpers.ts", () => {
    const out = emitTypeScript(model);
    expect(out.map((f) => f.name)).toEqual(["common.ts", "item-list.ts", "helpers.ts", "index.ts"]);
    expect(out[1]?.contents).toContain(
      '/** Types and decoders for `item-list.json`. */\n\nimport * as h from "./helpers.js";\n' +
        "import {\n  decodeAnyValue,\n  decodeOrderId,\n  encodeAnyValue,\n  encodeOrderId,\n" +
        '  type AnyValue,\n  type OrderId,\n} from "./common.js";\n\n',
    );
    expect(out[0]?.contents).toContain('import * as h from "./helpers.js";\n\n');
    expect(out[3]?.contents).toBe(
      `${HEADER}\n\nexport * from "./common.js";\nexport * from "./item-list.js";\n` +
        'export { DecodeError, EncodeError, type DecodeResult, ErrorCode } from "./helpers.js";\n',
    );
  });

  it("imports a rest map's key type in Rust only, since TypeScript keys it by string", () => {
    const rest = build({
      common: schema("common", { $defs: { currencyCode: { type: "string" } } }),
      pricing: schema("pricing", {
        $defs: {
          prices: {
            type: "object",
            properties: { default: { type: "string" } },
            propertyNames: {
              anyOf: [{ const: "default" }, { $ref: `${BASE}common.json#/$defs/currencyCode` }],
            },
            additionalProperties: { type: "string" },
            required: ["default"],
          },
        },
      }),
    });
    expect(emitRust(rest).find((f) => f.name === "pricing.rs")?.contents).toContain(
      "use super::common::CurrencyCode;\n",
    );
    const types = emitTypeScript(rest, { decoders: false });
    expect(types.find((f) => f.name === "pricing.ts")?.contents).not.toContain("import");
    expect(emitTypeScript(rest).find((f) => f.name === "pricing.ts")?.contents).toContain(
      'import * as h from "./helpers.js";\nimport { decodeCurrencyCode, encodeCurrencyCode } from "./common.js";\n',
    );
  });

  it("refuses a schema named helpers in TypeScript", () => {
    const bad = build({ helpers: schema("helpers", { $defs: { x: { type: "string" } } }) });
    expect(() => emitTypeScript(bad)).toThrow("a schema named helpers clashes with helpers.ts");
  });

  it("refuses a schema named index in TypeScript", () => {
    const bad = build({ index: schema("index", { $defs: { x: { type: "string" } } }) });
    expect(() => emitTypeScript(bad)).toThrow("a schema named index clashes with index.ts");
  });

  it("keeps each hoisted type with the schema of its owner", () => {
    expect(model.decls.map((d) => [d.name, d.schema])).toEqual([
      ["AnyValue", "common"],
      ["Flag", "common"],
      ["ItemList", "item-list"],
      ["OrderId", "common"],
    ]);
  });
});

describe("validation constraints", () => {
  const entries: JsonObject = {
    note: { type: "string", minLength: 1, maxLength: 5, pattern: "^n", format: "date" },
    digits: { type: "string", pattern: "\\d.$" },
    unique: { type: "array", items: { type: "string" }, uniqueItems: true },
    count: {
      type: "integer",
      minimum: 0,
      exclusiveMinimum: -1,
      maximum: 10,
      exclusiveMaximum: 11,
      multipleOf: 2,
    },
    ratio: { type: "number", minimum: -0, exclusiveMaximum: 1.5 },
    tags: { type: "array", items: { type: "string", maxLength: 3 }, minItems: 1, maxItems: 4 },
    labels: {
      type: "object",
      propertyNames: { type: "string", maxLength: 2 },
      additionalProperties: { type: "string" },
      minProperties: 1,
      maxProperties: 3,
    },
    noLimits: { type: "array", items: { type: "integer" }, uniqueItems: false },
  };
  const model = build(defs(entries));
  const typeOf = (name: string): unknown => {
    const decl = find(model, name);
    return decl.kind === "alias" ? decl.type : decl;
  };

  it("reads minLength, maxLength, pattern and format", () => {
    expect(typeOf("Note")).toEqual({
      kind: "string",
      pattern: "^n",
      match: { source: "^n", regex: "^n" },
      format: "date",
      minLength: 1,
      maxLength: 5,
    });
  });

  it("keeps a pattern as written and in its portable form", () => {
    expect(typeOf("Digits")).toEqual({
      kind: "string",
      pattern: "\\d.$",
      match: { source: "\\d.$", regex: "[0-9][^\n\r\u2028\u2029]$" },
    });
  });

  it("reads uniqueItems true, and leaves out false", () => {
    expect(typeOf("Unique")).toEqual({
      kind: "array",
      items: { kind: "string" },
      uniqueItems: true,
    });
  });

  it("reads the bounds and multipleOf of an integer", () => {
    expect(typeOf("Count")).toEqual({
      kind: "integer",
      minimum: 0,
      exclusiveMinimum: -1,
      maximum: 10,
      exclusiveMaximum: 11,
      multipleOf: 2,
    });
  });

  it("reads the bounds of a number, -0 as 0", () => {
    const ratio = typeOf("Ratio") as { minimum: number };
    expect(ratio).toEqual({ kind: "number", minimum: 0, exclusiveMaximum: 1.5 });
    expect(Object.is(ratio.minimum, 0)).toBe(true);
  });

  it("reads minItems and maxItems, and the item's own limits", () => {
    expect(typeOf("Tags")).toEqual({
      kind: "array",
      items: { kind: "string", maxLength: 3 },
      minItems: 1,
      maxItems: 4,
    });
    expect(typeOf("NoLimits")).toEqual({ kind: "array", items: { kind: "integer" } });
  });

  it("reads minProperties and maxProperties on a map, and the key's limits", () => {
    expect(typeOf("Labels")).toEqual({
      kind: "map",
      key: { kind: "string", maxLength: 2 },
      value: { kind: "string" },
      minProperties: 1,
      maxProperties: 3,
    });
  });

  it("keeps an id's constraints", () => {
    const ids = build({
      common: schema("common", { $defs: { orderId: { type: "string", minLength: 4 } } }),
    });
    expect(find(ids, "OrderId")).toMatchObject({
      kind: "id",
      type: { kind: "string", minLength: 4 },
    });
  });

  it("leaves constraints out with validation off, but keeps the pattern for typing", () => {
    const off = buildModel(schemaSet(defs(entries)), { validation: false });
    expect(find(off, "Note")).toMatchObject({ type: { kind: "string", pattern: "^n" } });
    for (const name of ["Note", "Count", "Ratio", "Tags", "Labels", "Unique"]) {
      const decl = find(off, name);
      const type = decl.kind === "alias" ? decl.type : decl;
      expect(JSON.stringify(type)).not.toMatch(/min|max|multiple|match|format|unique/i);
    }
  });

  it("still fails on a pattern outside the subset with validation off", () => {
    expect(() =>
      buildModel(schemaSet(defs({ x: { type: "string", pattern: "(?=a)" } })), {
        validation: false,
      }),
    ).toThrow("unsupported-pattern");
  });

  it("still fails on a bad constraint with validation off", () => {
    expect(() =>
      buildModel(schemaSet(defs({ x: { type: "string", minLength: -1 } })), { validation: false }),
    ).toThrow("invalid-constraint: minLength must be a whole number");
  });

  it.each<[string, JsonObject, string]>([
    [
      "a string limit on an integer",
      { x: { type: "integer", maxLength: 3 } },
      'lib.json#/$defs/x/maxLength: misplaced-keyword: maxLength doesn\'t apply to an integer. Hint: use it beside "type": "string"',
    ],
    [
      "a number limit on a string",
      { x: { type: "string", minimum: 3 } },
      'lib.json#/$defs/x/minimum: misplaced-keyword: minimum doesn\'t apply to a string. Hint: use it beside "type": "integer" or "number"',
    ],
    [
      "a limit beside $ref",
      { y: { type: "string" }, x: { $ref: "#/$defs/y", maxLength: 3 } },
      "lib.json#/$defs/x/maxLength: misplaced-keyword: maxLength doesn't apply beside $ref. Hint: put it on the def the $ref names",
    ],
    [
      "a limit beside enum",
      { x: { enum: ["a", "bb"], maxLength: 1 } },
      "lib.json#/$defs/x/maxLength: misplaced-keyword: maxLength doesn't apply beside enum. Hint: remove it, the enum lists every value",
    ],
    [
      "a limit without a type",
      { x: { minLength: 1 } },
      'lib.json#/$defs/x/minLength: misplaced-keyword: minLength doesn\'t apply without a type. Hint: add a "type", like "type": "string"',
    ],
    [
      "key counts on a closed object",
      { x: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false, minProperties: 1 } },
      'lib.json#/$defs/x/minProperties: misplaced-keyword: minProperties doesn\'t apply to an object with named properties. Hint: list the keys it needs in "required"; key counts only apply to maps, objects with "additionalProperties" and no "properties"',
    ],
    [
      "a limit in an allOf part of an object",
      {
        base: { type: "object", properties: { a: { type: "string" } } },
        x: { type: "object", allOf: [{ $ref: "#/$defs/base" }, { maxProperties: 1 }], unevaluatedProperties: false },
      },
      'lib.json#/$defs/x/allOf/1/maxProperties: misplaced-keyword: maxProperties doesn\'t apply to an allOf part of an object. Hint: list the keys the object needs in "required" instead',
    ],
    [
      "multipleOf on a number",
      { x: { type: "number", multipleOf: 0.5 } },
      'lib.json#/$defs/x/multipleOf: unsupported-constraint: multipleOf on a number can give different results in each language, since floats round. Hint: use "type": "integer" with a multipleOf, or remove it',
    ],
    [
      "a non-boolean uniqueItems",
      { x: { type: "array", items: { type: "string" }, uniqueItems: 1 } },
      "lib.json#/$defs/x/uniqueItems: invalid-constraint: uniqueItems must be true or false",
    ],
    [
      "a format other than date-time, date and uuid",
      { x: { type: "string", format: "email" } },
      'lib.json#/$defs/x/format: unsupported-format: only the date-time, date and uuid formats are supported. Hint: remove "format", or check the shape with "pattern"',
    ],
    [
      "a not beside a string",
      { x: { type: "string", not: { pattern: "^_" } } },
      'lib.json#/$defs/x/not: unsupported-not: not beside a string type is not checked. Hint: use "pattern" for the strings that are allowed, or an "enum" of them',
    ],
    [
      "a not of values beside a string",
      { x: { type: "string", not: { enum: ["a"] } } },
      "lib.json#/$defs/x/not: unsupported-not",
    ],
    [
      "a lookahead",
      { x: { type: "string", pattern: "^(?!_)" } },
      "lib.json#/$defs/x/pattern: unsupported-pattern: lookarounds are not supported by Rust's regex and Go's RE2 at character 2",
    ],
    [
      "a lookbehind",
      { x: { type: "string", pattern: "(?<=a)b" } },
      "unsupported-pattern: lookarounds are not supported",
    ],
    [
      "a backreference",
      { x: { type: "string", pattern: "(a)\\1" } },
      "unsupported-pattern: backreferences are not supported by Rust's regex and Go's RE2 at character 4",
    ],
    [
      "a named group",
      { x: { type: "string", pattern: "(?<year>[0-9]{4})" } },
      'unsupported-pattern: named groups are not supported at character 1. Hint: use a plain group, "(...)"',
    ],
    [
      "a word boundary",
      { x: { type: "string", pattern: "\\bword" } },
      "unsupported-pattern: the word boundary \\b at character 1. Hint: Rust's regex reads it by Unicode rules, Go and ECMAScript by ASCII ones",
    ],
    [
      "a Unicode property escape",
      { x: { type: "string", pattern: "\\p{Lu}" } },
      "unsupported-pattern: Unicode property escapes are not supported",
    ],
    [
      "a repeat above 1000",
      { x: { type: "string", pattern: "a{1001}" } },
      "unsupported-pattern: a repeat count above 1000, which Go's RE2 rejects",
    ],
    [
      "nested repeats above 1000",
      { x: { type: "string", pattern: "(a{50}){21}" } },
      "unsupported-pattern: nested repeats that multiply to more than 1000",
    ],
    [
      "a pattern that isn't ECMAScript",
      { x: { type: "string", pattern: "a{2,1}" } },
      "unsupported-pattern: not a valid ECMAScript pattern with the u flag",
    ],
    [
      "a pattern that ECMAScript only reads without the u flag",
      { x: { type: "string", pattern: "\\-" } },
      "unsupported-pattern: not a valid ECMAScript pattern with the u flag",
    ],
    [
      "a class that matches nothing",
      { x: { type: "string", pattern: "[]" } },
      "unsupported-pattern: a class that matches nothing",
    ],
    [
      "a pattern on a map key",
      {
        x: {
          type: "object",
          propertyNames: { type: "string", pattern: "(?=a)" },
          additionalProperties: { type: "string" },
        },
      },
      "lib.json#/$defs/x/propertyNames/pattern: unsupported-pattern",
    ],
    [
      "contains, outside the subset",
      { x: { type: "array", items: { type: "string" }, contains: { const: "a" } } },
      "lib.json#/$defs/x/contains: unsupported-keyword: unsupported keyword contains",
    ],
    [
      "a negative length",
      { x: { type: "string", minLength: -1 } },
      "lib.json#/$defs/x/minLength: invalid-constraint: minLength must be a whole number from 0 to 9007199254740991",
    ],
    [
      "a fractional count",
      { x: { type: "array", items: { type: "string" }, maxItems: 1.5 } },
      "lib.json#/$defs/x/maxItems: invalid-constraint: maxItems must be a whole number from 0 to 9007199254740991",
    ],
    [
      "a fractional bound on an integer",
      { x: { type: "integer", minimum: 0.5 } },
      "lib.json#/$defs/x/minimum: invalid-constraint: minimum of an integer must be a whole number from -9007199254740991 to 9007199254740991. Hint: every language holds a bound in that range exactly",
    ],
    [
      "an integer bound past the safe range",
      { x: { type: "integer", maximum: 9223372036854775807 } },
      "lib.json#/$defs/x/maximum: invalid-constraint: maximum of an integer must be a whole number",
    ],
    [
      "a boolean exclusiveMinimum, from an older draft",
      { x: { type: "number", minimum: 0, exclusiveMinimum: true } },
      'lib.json#/$defs/x/exclusiveMinimum: invalid-constraint: exclusiveMinimum must be a number. Hint: give the bound itself, like "exclusiveMinimum": 0',
    ],
    [
      "a zero multipleOf",
      { x: { type: "integer", multipleOf: 0 } },
      "lib.json#/$defs/x/multipleOf: invalid-constraint: multipleOf of an integer must be a whole number from 1 to 9007199254740991",
    ],
    [
      "a minimum above the maximum",
      { x: { type: "string", minLength: 3, maxLength: 2 } },
      "lib.json#/$defs/x/minLength: invalid-constraint: minLength 3 and maxLength 2 leave no value that fits",
    ],
    [
      "exclusive bounds that meet",
      { x: { type: "number", exclusiveMinimum: 1, maximum: 1 } },
      "lib.json#/$defs/x/exclusiveMinimum: invalid-constraint: exclusiveMinimum 1 and maximum 1 leave no value that fits",
    ],
    [
      "a non-string pattern",
      { x: { type: "string", pattern: 1 } },
      "lib.json#/$defs/x/pattern: invalid-constraint: pattern must be a string",
    ],
  ])("fails on %s", (_, body, message) => {
    expect(failure(defs(body)).message).toContain(message);
  });
});
