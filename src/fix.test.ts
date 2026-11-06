import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";
import type { FixInput, FixResult } from "./fix.js";
import { FIX_RULES, fixSchemas, noteText } from "./fix.js";
import { configTargets } from "./targets.js";

const BASE = "https://example.com/schemas/v1/";

const TARGETS = configTargets(
  parseConfig(
    { targets: { rust: { out: "rust" }, go: { out: "go" }, typescript: { out: "ts" } } },
    "/project/strictgen.json",
  ),
);

type Schemas = Readonly<Record<string, object | string>>;

function inputs(schemas: Schemas): FixInput[] {
  return Object.entries(schemas).map(([name, schema]) => ({
    name,
    text: typeof schema === "string" ? schema : `${JSON.stringify(schema, null, 2)}\n`,
  }));
}

/** Runs fix, checks that a second run changes nothing, and returns the result. */
function fix(schemas: Schemas): FixResult {
  const result = fixSchemas(inputs(schemas), { targets: TARGETS });
  const again = fixSchemas(
    result.files.map((f) => ({ name: f.file.slice(0, -5), text: f.after })),
    { targets: TARGETS },
  );
  expect(again.files.map((f) => f.after)).toEqual(result.files.map((f) => f.after));
  expect(again.files.every((f) => f.before === f.after)).toBe(true);
  expect(again.passes).toBe(1);
  return result;
}

/** The fixed schema of `name`, parsed. */
function fixed(result: FixResult, name = "order"): unknown {
  const file = result.files.find((f) => f.file === `${name}.json`);
  return JSON.parse(file?.after ?? "null");
}

function schema(body: object, name = "order", title = "Order"): object {
  return { $id: `${BASE}${name}.json`, title, ...body };
}

const notes = (result: FixResult): string[] => result.notes.map(noteText);

describe("close-objects", () => {
  it("adds additionalProperties false to open objects, nested ones too", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: {
          total: { type: "integer" },
          address: { type: "object", properties: { city: { type: "string" } } },
          lines: {
            type: "array",
            items: { type: "object", properties: { sku: { type: "string" } } },
          },
        },
      }),
    });
    expect(result.problem).toBeUndefined();
    expect(fixed(result)).toMatchObject({
      additionalProperties: false,
      properties: {
        address: { additionalProperties: false },
        lines: { items: { additionalProperties: false } },
      },
    });
  });

  it("uses unevaluatedProperties false beside allOf, oneOf, anyOf or if", () => {
    const result = fix({
      order: schema({
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        properties: { total: { type: "integer" } },
        $defs: { base: { type: "object", properties: { id: { type: "string" } } } },
      }),
    });
    const order = fixed(result) as Record<string, unknown>;
    expect(order.unevaluatedProperties).toBe(false);
    expect(order.additionalProperties).toBeUndefined();
    expect(result.problem).toBeUndefined();
  });

  it("leaves an allOf base, allOf parts and if/then branches open", () => {
    const result = fix({
      order: schema({
        type: "object",
        allOf: [
          { $ref: "#/$defs/base" },
          { type: "object", properties: { total: { type: "integer" } } },
          { if: { type: "object", properties: { total: { const: 0 } } }, then: { type: "object" } },
        ],
        unevaluatedProperties: false,
        $defs: { base: { type: "object", properties: { id: { type: "string" } } } },
      }),
    });
    const order = fixed(result) as { allOf: Record<string, unknown>[]; $defs: { base: object } };
    expect(order.$defs.base).not.toHaveProperty("additionalProperties");
    expect(order.allOf[1]).not.toHaveProperty("additionalProperties");
    expect(order.allOf[2]?.if).not.toHaveProperty("additionalProperties");
  });

  it("leaves closed objects and maps as they are", () => {
    const order = schema({
      type: "object",
      properties: {
        prices: { type: "object", additionalProperties: { type: "integer" } },
        tags: {
          type: "object",
          propertyNames: { enum: ["a"] },
          additionalProperties: { type: "string" },
        },
      },
      unevaluatedProperties: false,
    });
    const result = fix({ order });
    expect(result.files[0]?.after).toBe(result.files[0]?.before);
    expect(result.problem).toBeUndefined();
  });

  it.each(["$ref", "$dynamicRef", "dependentSchemas"])(
    "leaves an object with %s beside its properties open, with a note",
    (keyword) => {
      const value =
        keyword === "dependentSchemas"
          ? { a: { properties: { b: { type: "string" } } } }
          : "#/$defs/base";
      const result = fix({
        order: schema({
          type: "object",
          properties: {
            item: { type: "object", [keyword]: value, properties: { a: { type: "string" } } },
          },
          additionalProperties: false,
          $defs: { base: { type: "object", properties: { id: { type: "string" } } } },
        }),
      });
      const order = fixed(result) as { properties: { item: object } };
      expect(order.properties.item).not.toHaveProperty("additionalProperties");
      expect(order.properties.item).not.toHaveProperty("unevaluatedProperties");
      expect(
        notes(result).some((n) =>
          n.startsWith(
            `order.json#/properties/item: close-objects: an object with ${keyword} beside its properties stays open`,
          ),
        ),
      ).toBe(true);
    },
  );

  it("leaves additionalProperties true, which the author chose, for a change by hand", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: true,
      }),
    });
    expect(result.files[0]?.after).toBe(result.files[0]?.before);
    expect(result.problem?.rule).toBe("open-object");
  });

  it("leaves an object without properties open, with a note, since closing it allows only {}", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: { meta: { type: "object" } },
        additionalProperties: false,
      }),
    });
    expect(notes(result)).toEqual([
      expect.stringMatching(
        /^order\.json#\/properties\/meta: close-objects: an object with no properties/,
      ),
    ]);
    expect(result.problem?.message).toMatch(/^order\.json#\/properties\/meta: open-object:/);
  });
});

describe("tag-unions", () => {
  const card = {
    type: "object",
    properties: { kind: { const: "card" }, last4: { type: "string" } },
    required: ["kind"],
    additionalProperties: false,
  };

  it("requires the tag, turns a one value enum into a const, types the branches and drops the parent type", () => {
    const result = fix({
      order: schema({
        type: "object",
        oneOf: [
          { properties: { kind: { enum: ["card"] }, last4: { type: "string" } } },
          { properties: { kind: { const: "bank" }, iban: { type: "string" } }, required: ["iban"] },
        ],
      }),
    });
    expect(result.problem).toBeUndefined();
    expect(fixed(result)).toEqual({
      $id: `${BASE}order.json`,
      title: "Order",
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "card" }, last4: { type: "string" } },
          required: ["kind"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "bank" }, iban: { type: "string" } },
          required: ["iban", "kind"],
          additionalProperties: false,
        },
      ],
    });
  });

  it("picks the property that is a tag on every branch, preferring one already required", () => {
    const result = fix({
      order: schema({
        oneOf: [
          {
            type: "object",
            properties: { v: { const: "1" }, kind: { const: "a" } },
            required: ["kind"],
          },
          { type: "object", properties: { v: { const: "1" }, kind: { const: "b" } } },
        ],
      }),
    });
    const order = fixed(result) as { oneOf: { required: string[] }[] };
    expect(order.oneOf.map((b) => b.required)).toEqual([["kind"], ["kind"]]);
  });

  it("notes a tag whose values repeat", () => {
    const result = fix({
      order: schema({
        oneOf: [
          { ...card },
          { ...card, properties: { kind: { const: "card" }, iban: { type: "string" } } },
        ],
      }),
    });
    expect(notes(result)).toEqual([
      'order.json#/oneOf: tag-unions: two branches have the same value "card" for the tag kind. Hint: give every branch a different kind const',
    ]);
    expect(result.problem?.rule).toBe("union-tag");
  });

  it("doesn't change a def that a $ref branch names, and says what it needs", () => {
    const result = fix({
      order: schema({
        oneOf: [{ $ref: "#/$defs/card" }, { $ref: "#/$defs/bank" }],
        $defs: {
          card,
          bank: {
            type: "object",
            properties: { kind: { const: "bank" } },
            additionalProperties: false,
          },
        },
      }),
    });
    expect(fixed(result)).toMatchObject({
      $defs: { bank: { properties: { kind: { const: "bank" } } } },
    });
    expect((fixed(result) as { $defs: { bank: object } }).$defs.bank).not.toHaveProperty(
      "required",
    );
    expect(notes(result)).toEqual([
      'order.json#/$defs/bank: tag-unions: this branch of the union at order.json# needs kind in "required". Hint: change it by hand, since other schemas may use it too',
    ]);
  });

  it("leaves a union without a shared const, and one that is already tagged", () => {
    const untagged = schema({ oneOf: [{ type: "string" }, { type: "integer" }] });
    const tagged = schema(
      { oneOf: [card, { ...card, properties: { kind: { const: "bank" } } }] },
      "payment",
      "Payment",
    );
    const result = fix({ order: untagged, payment: tagged });
    expect(result.files.every((f) => f.before === f.after)).toBe(true);
    expect(result.problem).toBeUndefined();
  });
});

describe("merge-allof", () => {
  it("merges allOf parts of a string", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: {
          note: { allOf: [{ type: "string" }, { maxLength: 20, description: "A note." }] },
        },
        additionalProperties: false,
      }),
    });
    expect(fixed(result)).toMatchObject({
      properties: { note: { type: "string", maxLength: 20, description: "A note." } },
    });
    expect(result.problem).toBeUndefined();
  });

  it("merges object parts: properties and required, then closes the object", () => {
    const result = fix({
      order: schema({
        type: "object",
        required: ["id"],
        allOf: [
          { properties: { id: { type: "string" } } },
          {
            type: "object",
            properties: { total: { type: "integer" }, id: { type: "string" } },
            required: ["total", "id"],
          },
        ],
      }),
    });
    expect(fixed(result)).toEqual({
      $id: `${BASE}order.json`,
      title: "Order",
      type: "object",
      required: ["id", "total"],
      properties: { id: { type: "string" }, total: { type: "integer" } },
      additionalProperties: false,
    });
    expect(result.problem).toBeUndefined();
  });

  it("refuses parts that disagree, with a note", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: { a: { allOf: [{ type: "string" }, { type: "integer" }] } },
        additionalProperties: false,
      }),
    });
    expect(notes(result)).toEqual([
      "order.json#/properties/a/allOf: merge-allof: the allOf parts disagree on type, so they can't be merged. Hint: merge them by hand into one schema, keeping the value each part needs",
    ]);
    expect(result.problem).toBeDefined();
  });

  it("refuses properties declared twice with different schemas", () => {
    const result = fix({
      order: schema({
        type: "object",
        allOf: [
          { properties: { a: { type: "string" } } },
          { properties: { a: { type: "integer" } } },
        ],
      }),
    });
    expect(notes(result)[0]).toMatch(/disagree on the schema of property a/);
  });

  it("leaves an allOf with a $ref, an if, or beside additionalProperties", () => {
    const result = fix({
      order: schema({
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }, { properties: { total: { type: "integer" } } }],
        unevaluatedProperties: false,
        $defs: { base: { type: "object", properties: { id: { type: "string" } } } },
      }),
      user: schema(
        {
          type: "object",
          allOf: [{ properties: { a: { type: "string" } } }],
          additionalProperties: false,
        },
        "user",
        "User",
      ),
    });
    expect(result.files.every((f) => f.before === f.after)).toBe(true);
    expect(result.problem?.rule).toBe("closed-with-allof");
  });

  it("means the same as the allOf it replaces, checked with Ajv", () => {
    const original = schema({
      type: "object",
      allOf: [
        { properties: { id: { type: "string", minLength: 2 } }, required: ["id"] },
        { properties: { total: { type: "integer", minimum: 0 } } },
      ],
      unevaluatedProperties: false,
    });
    const result = fix({ order: original });
    expectSameMeaning(original, fixed(result) as object, [
      { id: "ab" },
      { id: "ab", total: 3 },
      { id: "a" },
      { total: 3 },
      { id: "ab", total: -1 },
      { id: "ab", other: 1 },
      "text",
    ]);
  });
});

/** Ajv accepts and rejects every payload the same with both schemas. */
function expectSameMeaning(before: object, after: object, payloads: readonly unknown[]): void {
  const a = new Ajv2020({ strict: false }).compile(before);
  const b = new Ajv2020({ strict: false }).compile(after);
  for (const payload of payloads) expect([payload, b(payload)]).toEqual([payload, a(payload)]);
}

describe("hoist-defs", () => {
  it("turns definitions into $defs and points the refs at them, from other files too", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: { line: { $ref: "#/definitions/line" } },
        additionalProperties: false,
        definitions: {
          line: {
            type: "object",
            properties: { sku: { type: "string" } },
            additionalProperties: false,
          },
        },
      }),
      user: schema(
        {
          type: "object",
          properties: { last: { $ref: `${BASE}order.json#/definitions/line` } },
          additionalProperties: false,
        },
        "user",
        "User",
      ),
    });
    expect(result.problem).toBeUndefined();
    expect(fixed(result)).toMatchObject({
      properties: { line: { $ref: "#/$defs/line" } },
      $defs: { line: {} },
    });
    expect(fixed(result)).not.toHaveProperty("definitions");
    expect(fixed(result, "user")).toMatchObject({
      properties: { last: { $ref: `${BASE}order.json#/$defs/line` } },
    });
  });

  it("moves a schema a $ref points into to $defs, with a name from its path that is free", () => {
    const address = {
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
    };
    const result = fix({
      order: schema({
        type: "object",
        properties: {
          shipping: { type: "object", properties: { address }, additionalProperties: false },
          billing: { $ref: "#/properties/shipping/properties/address" },
        },
        additionalProperties: false,
        $defs: { address: { type: "string" } },
      }),
    });
    expect(result.problem).toBeUndefined();
    expect(fixed(result)).toMatchObject({
      properties: {
        shipping: { properties: { address: { $ref: "#/$defs/shippingAddress" } } },
        billing: { $ref: "#/$defs/shippingAddress" },
      },
      $defs: { address: { type: "string" }, shippingAddress: address },
    });
  });

  it("moves $defs written inside a schema up to the root", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: {
          line: {
            $defs: { sku: { type: "string", minLength: 3 } },
            type: "object",
            properties: { sku: { $ref: "#/properties/line/$defs/sku" } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      }),
    });
    expect(result.problem).toBeUndefined();
    expect(fixed(result)).toMatchObject({
      properties: { line: { properties: { sku: { $ref: "#/$defs/sku" } } } },
      $defs: { sku: { type: "string", minLength: 3 } },
    });
    expect((fixed(result) as { properties: { line: object } }).properties.line).not.toHaveProperty(
      "$defs",
    );
  });

  it("renames a def a $ref can't name, like order-item", () => {
    const result = fix({
      order: schema({
        type: "array",
        items: { $ref: "#/$defs/order-item" },
        $defs: { "order-item": { type: "string" } },
      }),
    });
    expect(result.problem).toBeUndefined();
    expect(fixed(result)).toMatchObject({
      items: { $ref: "#/$defs/orderItem" },
      $defs: { orderItem: { type: "string" } },
    });
  });

  it("leaves a file with an inner $id, with a note", () => {
    const result = fix({
      order: schema({
        type: "object",
        properties: { a: { $id: "inner.json", type: "string" }, b: { $ref: "#/properties/a" } },
        additionalProperties: false,
      }),
    });
    expect(result.files[0]?.after).toBe(result.files[0]?.before);
    expect(notes(result)).toEqual([
      expect.stringMatching(
        /^order\.json#\/properties\/a: hoist-defs: a schema in this file has its own \$id/,
      ),
    ]);
    expect(result.problem).toBeDefined();
  });

  it("means the same as before, checked with Ajv", () => {
    const original = schema({
      type: "object",
      properties: {
        shipping: {
          type: "object",
          properties: {
            address: {
              type: "object",
              properties: { city: { type: "string", minLength: 2 } },
              required: ["city"],
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        billing: { $ref: "#/properties/shipping/properties/address" },
        line: { $ref: "#/definitions/line" },
      },
      additionalProperties: false,
      definitions: {
        line: {
          type: "object",
          properties: { qty: { type: "integer" } },
          additionalProperties: false,
        },
      },
    });
    const result = fix({ order: original });
    expectSameMeaning(original, fixed(result) as object, [
      {},
      { billing: { city: "Oslo" } },
      { billing: { city: "O" } },
      { billing: {} },
      { shipping: { address: { city: "Oslo", zip: 1 } } },
      { line: { qty: 2 } },
      { line: { qty: "2" } },
    ]);
  });
});

describe("fix", () => {
  /** A schema that needs every rule. */
  const messy = schema({
    type: "object",
    properties: {
      id: { type: "string" },
      note: { allOf: [{ type: "string" }, { maxLength: 20 }] },
      shipping: {
        type: "object",
        properties: {
          address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
      billing: { $ref: "#/properties/shipping/properties/address" },
      payment: {
        type: "object",
        oneOf: [
          { properties: { kind: { enum: ["card"] }, last4: { type: "string" } } },
          { properties: { kind: { const: "bank" }, iban: { type: "string" } }, required: ["kind"] },
        ],
      },
      lines: { type: "array", items: { $ref: "#/definitions/line" } },
    },
    required: ["id"],
    definitions: { line: { type: "object", properties: { sku: { type: "string" } } } },
  });

  it("fixes a schema that needs every rule, and it generates", () => {
    const result = fix({ order: messy });
    expect(result.problem).toBeUndefined();
    expect(result.notes).toEqual([]);
    expect(fixed(result)).toEqual({
      $id: `${BASE}order.json`,
      title: "Order",
      type: "object",
      properties: {
        id: { type: "string" },
        note: { type: "string", maxLength: 20 },
        shipping: {
          type: "object",
          properties: { address: { $ref: "#/$defs/address" } },
          additionalProperties: false,
        },
        billing: { $ref: "#/$defs/address" },
        payment: {
          oneOf: [
            {
              type: "object",
              properties: { kind: { const: "card" }, last4: { type: "string" } },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { const: "bank" }, iban: { type: "string" } },
              required: ["kind"],
              additionalProperties: false,
            },
          ],
        },
        lines: { type: "array", items: { $ref: "#/$defs/line" } },
      },
      required: ["id"],
      $defs: {
        line: {
          type: "object",
          properties: { sku: { type: "string" } },
          additionalProperties: false,
        },
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });
  });

  it("stops with a clean error when the rules don't settle within the pass limit", () => {
    expect(() => fixSchemas(inputs({ order: messy }), { targets: TARGETS, maxPasses: 1 })).toThrow(
      "schemas: internal: strictgen fix did not settle after 1 passes, a rule keeps undoing another",
    );
  });

  it("is deterministic", () => {
    const a = fix({ order: messy });
    const b = fix({ order: messy });
    expect(a.files).toEqual(b.files);
  });

  it("returns the first generation error, with file, pointer and rule", () => {
    const result = fix({ order: schema({ type: "object", properties: { a: { type: "null" } } }) });
    expect(result.problem?.message).toMatch(
      /^order\.json#\/properties\/a\/type: unsupported-type:/,
    );
  });

  it("fails cleanly on a file that isn't JSON, or has a duplicate key", () => {
    expect(() => fixSchemas(inputs({ order: "{ nope" }), { targets: TARGETS })).toThrow(
      /^order\.json: invalid-json: not valid JSON: unexpected character "n" at line 1, column 3$/,
    );
    expect(() => fixSchemas(inputs({ order: '{ "a": 1, "a": 2 }' }), { targets: TARGETS })).toThrow(
      /duplicate key "a" at line 1, column 11/,
    );
  });

  it("leaves untouched files byte for byte, odd spacing included", () => {
    const text = `{"$id":"${BASE}order.json",   "title":"Order","type":"string"}`;
    const result = fix({ order: text });
    expect(result.files[0]?.after).toBe(text);
  });

  it("documents every rule", () => {
    expect(Object.keys(FIX_RULES).sort()).toEqual([
      "close-objects",
      "hoist-defs",
      "merge-allof",
      "tag-unions",
    ]);
  });
});
