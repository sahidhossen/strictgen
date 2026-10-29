import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { HEADER } from "./common.js";
import {
  emitGo,
  emitGoAttributes,
  emitGoFixtures,
  fileName,
  goType,
  literalName,
} from "./emit-go.js";
import type { Model } from "./model.js";
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

function build(files: Record<string, JsonObject>): Model {
  return buildModel(schemaSet(files), { ids: { file: "common", suffix: "Id" } });
}

/** A definitions-only schema named `lib`. */
function lib(entries: JsonObject): Model {
  return build({ lib: schema("lib", { $defs: entries }) });
}

/** Every Go file the emitter writes, joined. */
function go(model: Model): string {
  return emitGo(model)
    .map((f) => f.contents)
    .join("\n");
}

/** The file named `name`. */
function file(model: Model, name: string): string {
  const found = emitGo(model).find((f) => f.name === name);
  if (found === undefined) throw new Error(`no file ${name}`);
  return found.contents;
}

const closed = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  unevaluatedProperties: false,
});

const paymentDefs: JsonObject = {
  cardPayment: closed(
    {
      type: { description: "Type.", const: "card" },
      installments: { description: "Installments.", type: "integer" },
    },
    ["type", "installments"],
  ),
  wirePayment: closed({ type: { const: "wire" }, iban: { type: "string" } }, ["type"]),
};

describe("Go files", () => {
  const model = build({
    "user-profile": schema("user-profile", {
      $defs: { name: { type: "string" }, point: closed({ x: { type: "integer" } }, ["x"]) },
    }),
    order: schema("order", {
      title: "Order",
      type: "object",
      properties: { owner: { $ref: `${BASE}user-profile.json#/$defs/point` } },
      required: ["owner"],
      unevaluatedProperties: false,
    }),
  });

  it("write one file per schema plus the helpers, each starting with the header", () => {
    const files = emitGo(model);
    expect(files.map((f) => f.name)).toEqual(["helpers.go", "order.go", "user_profile.go"]);
    for (const f of files) expect(f.contents.startsWith(`${HEADER}\n\n`)).toBe(true);
    expect(file(model, "order.go")).toContain(
      "// Types for order.json.\n\npackage types\n",
    );
  });

  it("refer to types of other schemas without imports, since they share one package", () => {
    const order = file(model, "order.go");
    expect(order).toContain('\tOwner Point `json:"owner"`\n');
    expect(order).not.toContain("import");
  });

  it("import only the standard library packages a file uses", () => {
    expect(file(model, "helpers.go")).toContain(
      'import (\n\t"bytes"\n\t"encoding/json"\n\t"errors"\n\t"fmt"\n\t"maps"\n\t"slices"\n\t"strconv"\n\t"strings"\n\t"unicode/utf8"\n)\n',
    );
    const numbers = lib({
      size: closed({ ratio: { description: "See x.json.", type: "number" } }),
    });
    expect(file(numbers, "lib.go")).toContain('package types\n\nimport "encoding/json"\n');
    const strings = lib({
      name: closed({ text: { description: "Uses json.Marshal.", type: "string" } }),
    });
    expect(file(strings, "lib.go")).not.toContain("import");
  });

  it("name files after the schema, refusing names Go would constrain or treat as tests", () => {
    expect(fileName("user-profile", "x")).toBe("user_profile.go");
    for (const bad of ["helpers", "registry-test", "order-test", "order-linux", "a-wasm", "Order"]) {
      expect(() => fileName(bad, "x.json#")).toThrow("has no safe Go file name");
    }
  });

  it("write a fixture registry with a decoder per root and def", () => {
    const registry = emitGoFixtures(model);
    expect(registry.startsWith(`${HEADER}\n\npackage types\n`)).toBe(true);
    expect(registry).toContain('\t\t"order": asAny(decodeType[Order]),\n');
    expect(registry).toContain('\t\t"user-profile/name": asAny(decodeString),\n');
    expect(registry).toContain('\t\t"user-profile/point": asAny(decodeType[Point]),\n');
  });
});

describe("Go closed objects", () => {
  const model = lib({
    point: {
      description: "A point.",
      ...closed(
        {
          x: { description: "X.", type: "integer" },
          y: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
          $account: { type: "string" },
        },
        ["x"],
      ),
    },
    empty: { description: "Nothing.", type: "object", unevaluatedProperties: false },
  });
  const out = go(model);

  it("become structs whose optional fields are pointers with omitempty", () => {
    expect(out).toContain(
      "// Point is generated from lib.json#/$defs/point.\n//\n// A point.\ntype Point struct {\n",
    );
    expect(out).toContain('\t// X.\n\tX int64 `json:"x"`\n');
    expect(out).toContain('\t// The y key.\n\tY *int64 `json:"y,omitempty"`\n');
    expect(out).toContain('\tTags *[]string `json:"tags,omitempty"`\n');
    expect(out).toContain('\tAccount *string `json:"$account,omitempty"`\n');
  });

  it("decode strictly through a generated UnmarshalJSON", () => {
    expect(out).toContain(
      "func (v *Point) UnmarshalJSON(data []byte) error { return unmarshal(data, v) }\n\n" +
        "func (v *Point) decode(n *node) *DecodeError {\n\tvar out Point\n\treturn decodeObject(n, func(d *objectDecoder) {\n" +
        '\t\trequired(d, "x", &out.X, decodeInt)\n' +
        '\t\toptional(d, "y", &out.Y, decodeInt)\n' +
        '\t\toptional(d, "tags", &out.Tags, decodeSlice(decodeString))\n' +
        '\t\toptional(d, "$account", &out.Account, decodeString)\n' +
        "\t}, func() { *v = out })\n}\n",
    );
  });

  it("decode an empty closed object as a struct with no keys", () => {
    expect(out).toContain("type Empty struct{}\n");
    expect(out).toContain(
      "\treturn decodeObject(n, func(*objectDecoder) {}, func() { *v = out })\n",
    );
  });

  it("reject keys without a Go field name or struct tag, and keys that clash", () => {
    const cases: [JsonObject, string][] = [
      [{ "9lives": { type: "string" } }, "key 9lives has no Go field name"],
      [{ "a,b": { type: "string" } }, "key a,b can't be a Go struct tag"],
      [
        { fooBar: { type: "string" }, "foo-bar": { type: "string" } },
        "two keys map to the Go field FooBar",
      ],
      [
        { unmarshalJSON: { type: "string" } },
        "reserved-name: key unmarshalJSON maps to the Go field UnmarshalJSON, which the generated code uses itself",
      ],
    ];
    for (const [properties, message] of cases) {
      expect(() => go(lib({ x: closed(properties) }))).toThrow(message);
    }
  });
});

describe("Go tagged unions", () => {
  const model = build({
    payment: schema("payment", {
      title: "Payment",
      oneOf: [{ $ref: "#/$defs/cardPayment" }, { $ref: "#/$defs/wirePayment" }],
      $defs: {
        ...paymentDefs,
        checkout: closed(
          {
            root: { $ref: "#/$defs/anyPayment" },
            extra: { $ref: "#" },
            payments: { type: "array", items: { $ref: "#" } },
          },
          ["root"],
        ),
        anyPayment: { $ref: "#" },
      },
    }),
  });
  const out = go(model);

  it("are an interface with a marker method on each branch", () => {
    expect(out).toContain("type Payment interface {\n\tisPayment()\n}\n");
    expect(out).toContain("func (CardPayment) isPayment() {}\nfunc (WirePayment) isPayment() {}\n");
    expect(out).toContain(
      '// It holds one of CardPayment or WirePayment, picked by the "type" key.\n',
    );
  });

  it("decode by reading the tag first, through a Decode function", () => {
    expect(out).toContain(
      "func DecodePayment(data []byte) (Payment, error) { return decodeRoot(data, unionPayment) }\n\n" +
        '// unionPayment decodes a parsed Payment by its "type" key.\n' +
        "func unionPayment(n *node) (Payment, *DecodeError) {\n" +
        '\treturn decodeTagged(n, "type", map[string]func(*node) (Payment, *DecodeError){\n' +
        '\t\t"card": branch[Payment, CardPayment],\n' +
        '\t\t"wire": branch[Payment, WirePayment],\n' +
        "\t})\n}\n",
    );
  });

  it("are fields without a pointer, since a nil interface means absent", () => {
    expect(out).toContain('\tRoot AnyPayment `json:"root"`\n');
    expect(out).toContain('\tExtra Payment `json:"extra,omitempty"`\n');
    expect(out).toContain('\t\trequired(d, "root", &out.Root, unionPayment)\n');
    expect(out).toContain('\t\toptionalValue(d, "extra", &out.Extra, unionPayment)\n');
    expect(out).toContain('\t\toptional(d, "payments", &out.Payments, decodeSlice(unionPayment))\n');
  });

  it("check string consts through their enum", () => {
    expect(out).toContain(
      '\t// CardPaymentTypeCard is "card".\n\tCardPaymentTypeCard CardPaymentType = "card"\n',
    );
    expect(out).toContain(
      "func (v *CardPaymentType) decode(n *node) *DecodeError {\n\treturn decodeEnum(n, v, CardPaymentTypeCard)\n}\n",
    );
  });

  it("reject a Decode function name that a type already has", () => {
    const clash = build({
      payment: schema("payment", {
        title: "Payment",
        oneOf: [{ $ref: "#/$defs/cardPayment" }, { $ref: "#/$defs/wirePayment" }],
        $defs: { ...paymentDefs, decodePayment: { type: "string" } },
      }),
    });
    expect(() => go(clash)).toThrow("Go name DecodePayment is also used by payment.json#");
  });
});

describe("Go untagged unions", () => {
  const model = lib({
    accountRef: closed({ $account: { type: "string" } }, ["$account"]),
    currencyCode: { type: "string" },
    currencyAmounts: {
      type: "object",
      propertyNames: { $ref: "#/$defs/currencyCode" },
      additionalProperties: { type: "string" },
    },
    amountsOrRef: { oneOf: [{ $ref: "#/$defs/currencyAmounts" }, { $ref: "#/$defs/accountRef" }] },
    loose: { oneOf: [{ type: "string" }, {}] },
  });
  const out = go(model);

  it("are a struct with one field per variant, tried in the generator's order", () => {
    expect(out).toContain(
      "type AmountsOrRef struct {\n\t// AccountRef is set when the value decodes as AccountRef.\n\tAccountRef *AccountRef\n" +
        "\t// CurrencyAmounts is set when the value decodes as CurrencyAmounts.\n\tCurrencyAmounts *CurrencyAmounts\n}\n",
    );
    expect(out).toContain(
      "// Exactly one field is set. Decoding tries them in order: AccountRef or CurrencyAmounts.\n",
    );
    expect(out).toContain(
      '\treturn decodeUntagged(n, "AmountsOrRef", func() { *v = out },\n' +
        "\t\ttry(&out.AccountRef, decodeType[AccountRef]),\n" +
        "\t\ttry(&out.CurrencyAmounts, decodeMap(decodeString, decodeString)),\n\t)\n",
    );
  });

  it("encode the one variant that is set", () => {
    expect(out).toContain(
      '\treturn encodeUntagged("AmountsOrRef", some(v.AccountRef), some(v.CurrencyAmounts))\n',
    );
  });

  it("keep any JSON as a json.RawMessage, absent when nil", () => {
    expect(out).toContain("\tJson json.RawMessage\n");
    expect(out).toContain("\t\ttryValue(&out.Json, decodeAny),\n");
    expect(out).toContain('encodeUntagged("Loose", some(v.String), someRaw(v.Json))');
  });
});

describe("Go exactly-one choices and named keys beside a map", () => {
  it("decode each choice as a struct that rejects the other key as unknown", () => {
    const out = go(
      lib({
        link: {
          type: "object",
          properties: { href: { type: "string" }, userId: { type: "string" } },
          oneOf: [{ required: ["href"] }, { required: ["userId"] }],
          unevaluatedProperties: false,
        },
      }),
    );
    expect(out).toContain(
      'type LinkHref struct {\n\t// The href key.\n\tHref string `json:"href"`\n}\n',
    );
    expect(out).toContain("\tHref *LinkHref\n");
  });

  it("encode the rest map through a guard so a named key is never written twice", () => {
    const out = go(
      lib({
        prices: {
          type: "object",
          properties: { default: { type: "string" }, size: { type: "integer" } },
          additionalProperties: { type: "string" },
          required: ["default"],
        },
      }),
    );
    expect(out).toContain('\tRest map[string]string `json:"-"`\n');
    expect(out).toContain("\t\trest(d, &out.Rest, decodeString, decodeString)\n");
    expect(out).toContain(
      'func (v Prices) MarshalJSON() ([]byte, error) {\n\ttype named Prices\n\treturn encodeWithRest(named(v), v.Rest, []string{"default", "size"}, []string{})\n}\n',
    );
  });

  it("refuse a key named rest beside the map", () => {
    const bad = lib({
      prices: {
        type: "object",
        properties: { rest: { type: "string" } },
        additionalProperties: { type: "string" },
      },
    });
    expect(() => go(bad)).toThrow("reserved-name: key rest maps to the Go field Rest");
  });
});

describe("Go scalars, ids, aliases and consts", () => {
  const model = build({
    common: schema("common", {
      $defs: {
        orderId: { type: "string" },
        children: { type: "array", items: { $ref: "#/$defs/orderId" } },
        index: {
          type: "object",
          propertyNames: { $ref: "#/$defs/orderId" },
          additionalProperties: { type: "boolean" },
        },
        anyValue: {},
        jsonValue: { not: { const: null } },
        version: { const: 1 },
        flag: { const: true },
        size: closed(
          {
            ratio: { type: "number" },
            value: { $ref: "#/$defs/anyValue" },
            json: { $ref: "#/$defs/jsonValue" },
            next: { $ref: "#/$defs/version" },
            at: { type: "string", format: "date-time" },
          },
          ["ratio"],
        ),
      },
    }),
  });
  const out = go(model);

  it("make ids named strings that decode from JSON strings", () => {
    expect(out).toContain("type OrderId string\n");
    expect(out).toContain(
      "func (v *OrderId) decode(n *node) *DecodeError { return decodeStringInto(n, v) }\n",
    );
  });

  it("make aliases Go aliases and keep typed map keys", () => {
    expect(out).toContain("type Children = []OrderId\n");
    expect(out).toContain("type Index = map[OrderId]bool\n");
    expect(emitGoFixtures(model)).toContain(
      '"common/index": asAny(decodeMap(decodeType[OrderId], decodeBool)),',
    );
  });

  it("keep numbers as json.Number and any JSON as json.RawMessage, null distinct from absent", () => {
    expect(out).toContain('\tRatio json.Number `json:"ratio"`\n');
    expect(out).toContain('\tValue AnyValue `json:"value,omitempty"`\n');
    expect(out).toContain('\t\toptionalValue(d, "value", &out.Value, decodeAny)\n');
    expect(out).toContain('\tJson *JsonValue `json:"json,omitempty"`\n');
    expect(out).toContain("type JsonValue = NonNullJson\n");
    expect(out).toContain('\tAt *string `json:"at,omitempty"`\n');
  });

  it("make integer and boolean consts types that decode only their value", () => {
    expect(out).toContain("type Version = ConstInt1\n");
    expect(out).toContain("type Flag = ConstBoolTrue\n");
    expect(out).toContain(
      'func (ConstInt1) MarshalJSON() ([]byte, error) { return []byte("1"), nil }\n',
    );
    expect(out).toContain(
      "func (*ConstBoolTrue) decode(n *node) *DecodeError { return decodeConstBool(n, true) }\n",
    );
    expect(out).toContain('\t\toptional(d, "next", &out.Next, decodeType[ConstInt1])\n');
    expect(literalName(-2)).toBe("ConstIntMinus2");
    expect(literalName(false)).toBe("ConstBoolFalse");
  });

  it("decode integers that serde_json reads as integers, so -0 fails", () => {
    expect(file(model, "helpers.go")).toContain(
      "\tif v == 0 && n.raw[0] == '-' {\n\t\treturn 0, failf(\"expected an integer, found %s\", n.raw)\n\t}\n",
    );
  });

  it("spell every type expression", () => {
    expect(
      goType({
        kind: "map",
        key: { kind: "string" },
        value: { kind: "array", items: { kind: "nonNull" } },
      }),
    ).toBe("map[string][]NonNullJson");
    expect(goType({ kind: "literal", value: 3 })).toBe("ConstInt3");
  });
});

describe("Go recursion and names", () => {
  it("puts a pointer on the back edge of a cycle", () => {
    const out = go(
      lib({
        node: closed({ next: { $ref: "#/$defs/node" }, child: { $ref: "#/$defs/wrap" } }, [
          "child",
        ]),
        wrap: closed({ node: { $ref: "#/$defs/node" } }, ["node"]),
      }),
    );
    expect(out).toContain('\tNode *Node `json:"node"`\n');
    expect(out).toContain('\t\trequired(d, "node", &out.Node, boxed(decodeType[Node]))\n');
  });

  it("reject names the helpers use and enum values that clash", () => {
    expect(() => go(lib({ nonNullJson: { type: "string" } }))).toThrow(
      "type name NonNullJson is reserved in Go",
    );
    expect(() => go(lib({ constInt1: { type: "string" } }))).toThrow("reserved in Go");
    expect(() => go(lib({ codeTooDeep: { type: "string" } }))).toThrow(
      "type name CodeTooDeep is reserved in Go",
    );
    expect(() => go(lib({ code: { enum: ["duplicate_key"] } }))).toThrow(
      "Go name CodeDuplicateKey is also used by helpers.go",
    );
    expect(() => go(lib({ mode: { enum: ["a-b", "a_b"] } }))).toThrow(
      "two values map to the Go name ModeAB",
    );
    expect(() => go(lib({ mode: { enum: ["a"] }, modeA: { type: "string" } }))).toThrow(
      "Go name ModeA is also used by",
    );
  });
});

describe("Go determinism", () => {
  const files = {
    payment: schema("payment", {
      title: "Payment",
      oneOf: [{ $ref: "#/$defs/cardPayment" }, { $ref: "#/$defs/wirePayment" }],
      $defs: paymentDefs,
    }),
    lib: schema("lib", { $defs: { flag: { const: true }, version: { const: 1 } } }),
  };

  it("emits the same output on every run and for any input key order", () => {
    const reversed = Object.fromEntries(Object.entries(files).reverse());
    expect(emitGo(build(reversed))).toEqual(emitGo(build(files)));
    expect(emitGoFixtures(build(reversed))).toBe(emitGoFixtures(build(files)));
  });

  it("sorts the literal types by name", () => {
    const helpers = file(build(files), "helpers.go");
    expect(helpers.indexOf("type ConstBoolTrue")).toBeLessThan(helpers.indexOf("type ConstInt1"));
  });
});

describe("Go encoding checks", () => {
  const model = build({
    payment: schema("payment", {
      title: "Payment",
      oneOf: [{ $ref: "#/$defs/cardPayment" }, { $ref: "#/$defs/wirePayment" }],
      $defs: {
        ...paymentDefs,
        checkout: closed(
          {
            root: { $ref: "#" },
            tags: { type: "array", items: { type: "string" } },
            names: { type: "object", additionalProperties: { type: "string" } },
            title: { type: "string" },
            note: { type: "array", items: { type: "string" } },
          },
          ["root", "tags", "names", "title"],
        ),
        prices: {
          type: "object",
          properties: {
            default: { type: "string" },
            list: { type: "array", items: { type: "string" } },
          },
          additionalProperties: { type: "string" },
          required: ["default", "list"],
        },
      },
    }),
  });
  const out = go(model);

  it("fail to encode a required slice, map or union that is nil, naming the key", () => {
    expect(out).toContain(
      "func (v Checkout) MarshalJSON() ([]byte, error) {\n\ttype plain Checkout\n" +
        '\treturn encodeRequired(plain(v), []string{"root", "tags", "names"}, v.Root != nil, v.Tags != nil, v.Names != nil)\n}\n',
    );
    expect(out).not.toContain("func (v CardPayment) MarshalJSON");
  });

  it("check required fields beside a rest map too", () => {
    expect(out).toContain(
      '\treturn encodeWithRest(named(v), v.Rest, []string{"default", "list"}, []string{"list"}, v.List != nil)\n',
    );
  });

  it("list the generated files for .gitattributes and every decodable type for the tests", () => {
    expect(emitGoAttributes(["b.go", "a.go"])).toBe(
      `# ${HEADER.slice(3)}\n# Marks the generated Go files, so diffs collapse them.\na.go linguist-generated=true\nb.go linguist-generated=true\n`,
    );
    const registry = emitGoFixtures(model);
    expect(registry).toContain("\t\tnew(CardPayment),\n\t\tnew(CardPaymentType),\n");
    expect(registry).toContain("\t\tnew(NonNullJson),\n");
    expect(registry).not.toContain("new(Payment)");
  });
});

describe("JSON error codes", () => {
  const helpers = file(lib({ name: { type: "string" } }), "helpers.go");

  it("declare strictgen's own codes in the helpers", () => {
    expect(helpers).toContain(
      "const (\n" +
        "\t// CodeInvalidJSON is a syntax error, invalid UTF-8, a lone surrogate, trailing data or a\n" +
        "\t// number out of range.\n" +
        '\tCodeInvalidJSON = "invalid_json"\n' +
        "\t// CodeDuplicateKey is an object that gives the same key twice.\n" +
        '\tCodeDuplicateKey = "duplicate_key"\n' +
        "\t// CodeTooDeep is a value nested in maxDepth or more arrays and objects.\n" +
        '\tCodeTooDeep = "too_deep"\n' +
        ")\n",
    );
  });

  it("report invalid JSON, a duplicate key and too deep nesting with them", () => {
    expect(helpers).toContain('failAt(CodeInvalidJSON, invalidUTF8At(data), "not valid UTF-8")');
    expect(helpers).toContain('failAt(CodeInvalidJSON, p.pos, "trailing characters")');
    expect(helpers).toContain("return failAt(CodeInvalidJSON, p.pos, reason)");
    expect(helpers).toContain('failAt(CodeInvalidJSON, start, "lone surrogate")');
    expect(helpers).toContain('failAt(CodeInvalidJSON, start, "number out of range")');
    expect(helpers).toContain("failAt(CodeDuplicateKey, keyAt,");
    expect(helpers).toContain("failAt(CodeTooDeep, p.pos,");
  });

  it("use no code the helpers don't declare", () => {
    const used = new Set(helpers.match(/\bCode[A-Z][A-Za-z]*\b/g));
    expect([...used].sort()).toEqual(["CodeDuplicateKey", "CodeInvalidJSON", "CodeTooDeep"]);
  });
});

describe("reserved names", () => {
  it("exports a field named like a keyword instead of failing", () => {
    const out = go(
      lib({
        rule: closed(
          {
            type: { type: "string" },
            func: { type: "string" },
            default: { type: "boolean" },
            select: { type: "string" },
          },
          ["type", "default"],
        ),
      }),
    );
    expect(out).toContain('\tType string `json:"type"`\n');
    expect(out).toContain('\tFunc *string `json:"func,omitempty"`\n');
    expect(out).toContain('\tDefault bool `json:"default"`\n');
    expect(out).toContain('\tSelect *string `json:"select,omitempty"`\n');
  });

  it("fails on a type named like a helper of the generated package", () => {
    expect(() => go(lib({ decodeError: { type: "string" } }))).toThrow(
      "lib.json#/$defs/decodeError: reserved-name: type name DecodeError is reserved in Go. Hint: rename the $defs entry",
    );
  });

  it("fails on a key that maps to a method the generated type has", () => {
    expect(() => go(lib({ x: closed({ marshalJSON: { type: "string" } }) }))).toThrow(
      "reserved-name: key marshalJSON maps to the Go field MarshalJSON",
    );
  });
});
