import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Change } from "./breaking.js";
import { BREAKS, breakingJson, breakingLines, classify, diffModels } from "./breaking.js";
import type { BuildOptions } from "./build.js";
import { buildModel } from "./build.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from "./run.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

/** An order schema with `properties` and `required`, closed. */
function order(properties: JsonObject, required: readonly string[] = [], extra: JsonObject = {}) {
  return {
    $id: `${BASE}order.json`,
    title: "Order",
    type: "object",
    properties,
    ...(required.length === 0 ? {} : { required: [...required] }),
    unevaluatedProperties: false,
    ...extra,
  } as JsonObject;
}

function model(files: Readonly<Record<string, JsonObject>>, options: BuildOptions = {}) {
  return buildModel(schemaSet(files), options);
}

/** The changes between two schema sets, as `[kind, breaks, base, current, detail]`. */
function diff(
  before: Readonly<Record<string, JsonObject>>,
  after: Readonly<Record<string, JsonObject>>,
  options: BuildOptions = {},
): [string, string, string | null, string | null, string][] {
  return diffModels(model(before, options), model(after, options)).map((c) => [
    c.kind,
    c.breaks.join(","),
    c.base,
    c.current,
    c.detail,
  ]);
}

/** The changes for one property schema changing from `was` to `now`, as `[kind, breaks, detail]`. */
function prop(was: JsonObject, now: JsonObject): [string, string, string][] {
  return diff({ order: order({ x: was }, ["x"]) }, { order: order({ x: now }, ["x"])}).map(
    ([kind, breaks, , , detail]) => [kind, breaks, detail],
  );
}

describe("no change", () => {
  it("finds nothing between equal schemas", () => {
    const o = order({ total: { type: "integer" } }, ["total"]);
    expect(diff({ order: o }, { order: o })).toEqual([]);
  });

  it("ignores renamed defs and hoisted names, which don't change the JSON", () => {
    const before = order({ address: { $ref: "#/$defs/address" } }, ["address"], {
      $defs: {
        address: {
          type: "object",
          properties: { lines: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"], unevaluatedProperties: false } } },
          required: ["lines"],
          unevaluatedProperties: false,
        },
      },
    });
    const after = order({ address: { $ref: "#/$defs/postalAddress" } }, ["address"], {
      $defs: {
        postalAddress: {
          type: "object",
          properties: { lines: { type: "array", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"], unevaluatedProperties: false } } },
          required: ["lines"],
          unevaluatedProperties: false,
        },
      },
    });
    // Only the def itself shows: one name went away and one came.
    expect(diff({ order: before }, { order: after }).map(([k, , b, c]) => [k, b, c])).toEqual([
      ["type-removed", "order.json#/$defs/address", "order.json#/$defs"],
      ["type-added", "order.json#/$defs", "order.json#/$defs/postalAddress"],
    ]);
  });

  it("ignores descriptions and titles", () => {
    const before = order({ total: { type: "integer", description: "Total." } }, ["total"]);
    const after = order({ total: { type: "integer", description: "The total." } }, ["total"]);
    expect(diff({ order: before }, { order: after })).toEqual([]);
  });

  it("treats a field through an alias like the type it names", () => {
    const before = order({ total: { $ref: "#/$defs/cents" } }, ["total"], {
      $defs: { cents: { type: "integer" } },
    });
    const after = order({ total: { type: "integer" } }, ["total"], {
      $defs: { cents: { type: "integer" } },
    });
    expect(diff({ order: before }, { order: after })).toEqual([]);
  });
});

describe("types", () => {
  it("adding a type is safe", () => {
    const o = order({});
    const user = { $id: `${BASE}user.json`, title: "User", type: "object", properties: {}, unevaluatedProperties: false };
    expect(diff({ order: o }, { order: o, user })).toEqual([
      ["type-added", "", null, "user.json#", "type added"],
    ]);
  });

  it("removing a type breaks all consumers", () => {
    const o = order({});
    const user = { $id: `${BASE}user.json`, title: "User", type: "object", properties: {}, unevaluatedProperties: false };
    expect(diff({ order: o, user }, { order: o })).toEqual([
      ["type-removed", "all-consumers", "user.json#", null, "type removed"],
    ]);
  });

  it("changing a type breaks all consumers and producers", () => {
    expect(prop({ type: "string" }, { type: "boolean" })).toEqual([
      ["type-changed", "all-consumers,producers", "type changed from string to boolean"],
    ]);
    expect(prop({ type: "string" }, { type: "object", properties: {}, unevaluatedProperties: false })).toEqual([
      ["type-changed", "all-consumers,producers", "type changed from string to object"],
    ]);
  });

  it("integer to number breaks all consumers, number to integer breaks producers", () => {
    expect(prop({ type: "integer" }, { type: "number" })).toEqual([
      ["type-widened", "all-consumers", "integer is now number"],
    ]);
    expect(prop({ type: "number" }, { type: "integer" })).toEqual([
      ["type-narrowed", "producers", "number is now integer"],
    ]);
  });

  it("making a field nullable breaks all consumers", () => {
    expect(prop({ type: "string" }, {})).toEqual([
      ["made-nullable", "all-consumers", "string is now any JSON value, null included"],
    ]);
    expect(prop({ not: { const: null } }, {})).toEqual([
      ["made-nullable", "all-consumers", "any non-null JSON value is now any JSON value, null included"],
    ]);
  });

  it("narrowing any value breaks producers, widening to non-null breaks all consumers", () => {
    expect(prop({}, { type: "string" })).toEqual([
      ["type-narrowed", "producers", "any JSON value is now string"],
    ]);
    expect(prop({ type: "string" }, { not: { const: null } })).toEqual([
      ["type-widened", "all-consumers", "string is now any non-null JSON value"],
    ]);
  });

  it("changing a constant breaks all consumers and producers", () => {
    expect(prop({ const: 1 }, { const: 2 })).toEqual([
      ["type-changed", "all-consumers,producers", "constant changed from 1 to 2"],
    ]);
  });
});

describe("fields", () => {
  const before = order({ total: { type: "integer" } }, ["total"]);

  it("adding an optional field breaks strict consumers", () => {
    const after = order({ total: { type: "integer" }, note: { type: "string" } }, ["total"]);
    expect(diff({ order: before }, { order: after })).toEqual([
      ["field-added", "strict-consumers", "order.json#", "order.json#/properties/note", 'optional field "note" added'],
    ]);
  });

  it("adding a required field breaks strict consumers and producers", () => {
    const after = order({ total: { type: "integer" }, note: { type: "string" } }, ["total", "note"]);
    expect(diff({ order: before }, { order: after })).toEqual([
      [
        "required-field-added",
        "strict-consumers,producers",
        "order.json#",
        "order.json#/properties/note",
        'required field "note" added',
      ],
    ]);
  });

  it("removing a field breaks all consumers", () => {
    expect(diff({ order: before }, { order: order({}) })).toEqual([
      ["field-removed", "all-consumers", "order.json#/properties/total", "order.json#", 'field "total" removed'],
    ]);
  });

  it("renaming a field is a removal and an addition", () => {
    const after = order({ amount: { type: "integer" } }, ["amount"]);
    expect(diff({ order: before }, { order: after }).map(([k]) => k)).toEqual([
      "field-removed",
      "required-field-added",
    ]);
  });

  it("making a field optional breaks all consumers, required breaks producers", () => {
    const optional = order({ total: { type: "integer" } });
    expect(diff({ order: before }, { order: optional }).map(([k, b]) => [k, b])).toEqual([
      ["field-made-optional", "all-consumers"],
    ]);
    expect(diff({ order: optional }, { order: before }).map(([k, b]) => [k, b])).toEqual([
      ["field-made-required", "producers"],
    ]);
  });

  it("names nested fields by their pointer in each version", () => {
    const nest = (props: JsonObject) =>
      order({ customer: { type: "object", properties: props, unevaluatedProperties: false } });
    const changes = diff(
      { order: nest({ name: { type: "string" } }) },
      { order: nest({ name: { type: "integer" } }) },
    );
    expect(changes.map(([, , b, c]) => [b, c])).toEqual([
      ["order.json#/properties/customer/properties/name", "order.json#/properties/customer/properties/name"],
    ]);
  });

  it("follows a change into a def once, wherever it is used", () => {
    const withDef = (type: string) =>
      order({ from: { $ref: "#/$defs/place" }, to: { $ref: "#/$defs/place" } }, [], {
        $defs: { place: { type: "object", properties: { code: { type } }, unevaluatedProperties: false } },
      });
    expect(diff({ order: withDef("string") }, { order: withDef("integer") })).toEqual([
      [
        "type-changed",
        "all-consumers,producers",
        "order.json#/$defs/place/properties/code",
        "order.json#/$defs/place/properties/code",
        "type changed from string to integer",
      ],
    ]);
  });

  it("compares recursive types without looping", () => {
    const tree = (type: string) =>
      order({ node: { $ref: "#/$defs/node" } }, [], {
        $defs: {
          node: {
            type: "object",
            properties: { value: { type }, children: { type: "array", items: { $ref: "#/$defs/node" } } },
            unevaluatedProperties: false,
          },
        },
      });
    expect(diff({ order: tree("string") }, { order: tree("string") })).toEqual([]);
    expect(diff({ order: tree("string") }, { order: tree("boolean") }).map(([k]) => k)).toEqual(["type-changed"]);
  });

  it("adding a field to an object with other keys breaks all consumers", () => {
    const rest = (props: JsonObject): JsonObject => ({
      $id: `${BASE}order.json`,
      title: "Order",
      type: "object",
      properties: props,
      additionalProperties: { type: "integer" },
    });
    const changes = diff(
      { order: rest({ total: { type: "integer" } }) },
      { order: rest({ total: { type: "integer" }, note: { type: "string" } }) },
    );
    expect(changes.map(([k, b]) => [k, b])).toEqual([["field-added-to-other-keys", "all-consumers"]]);
  });

  it("allowing other keys breaks strict consumers, removing them breaks producers", () => {
    const closed = order({ total: { type: "integer" } });
    const open: JsonObject = {
      $id: `${BASE}order.json`,
      title: "Order",
      type: "object",
      properties: { total: { type: "integer" } },
      additionalProperties: { type: "integer" },
    };
    expect(diff({ order: closed }, { order: open }).map(([k, b]) => [k, b])).toEqual([
      ["other-keys-allowed", "strict-consumers"],
    ]);
    expect(diff({ order: open }, { order: closed }).map(([k, b]) => [k, b])).toEqual([
      ["other-keys-removed", "producers"],
    ]);
  });

  it("follows ids to the string they are", () => {
    const common: JsonObject = {
      $id: `${BASE}common.json`,
      $defs: { orderId: { type: "string", minLength: 1 } },
    };
    const before = order({ id: { $ref: `${BASE}common.json#/$defs/orderId` } }, ["id"]);
    const after = order({ id: { type: "string", minLength: 1 } }, ["id"]);
    const ids = { ids: { file: "common", suffix: "Id" } };
    expect(diff({ common, order: before }, { common, order: after }, ids)).toEqual([]);
  });
});

describe("enums", () => {
  const status = (values: string[]) => order({ status: { enum: values } }, ["status"]);

  it("adding a value breaks all consumers", () => {
    expect(diff({ order: status(["paid"]) }, { order: status(["paid", "refunded"]) })).toEqual([
      [
        "enum-value-added",
        "all-consumers",
        "order.json#/properties/status",
        "order.json#/properties/status",
        'value "refunded" added',
      ],
    ]);
  });

  it("removing a value breaks producers", () => {
    expect(diff({ order: status(["paid", "refunded"]) }, { order: status(["paid"]) }).map(([k, b]) => [k, b])).toEqual([
      ["enum-value-removed", "producers"],
    ]);
  });

  it("reordering values changes nothing", () => {
    expect(diff({ order: status(["paid", "refunded"]) }, { order: status(["refunded", "paid"]) })).toEqual([]);
  });
});

describe("exactly-one choices", () => {
  const contact = (...branches: (readonly string[])[]): JsonObject =>
    order(
      { email: { type: "string" }, phone: { type: "string" }, fax: { type: "string" } },
      [],
      { oneOf: branches.map((required) => ({ required: [...required] })) },
    );

  it("a key a sibling branch now names is forbidden, which breaks producers", () => {
    const changes = diff({ order: contact(["email"], ["phone"]) }, { order: contact(["email"], ["phone", "fax"]) });
    expect(changes.filter(([k]) => k.startsWith("key-")).map(([k, b, , , d]) => [k, b, d])).toEqual([
      ["key-forbidden", "producers", 'key "fax" is now forbidden'],
    ]);
  });

  it("a key no sibling branch names any more is allowed, which breaks all consumers", () => {
    const changes = diff({ order: contact(["email"], ["phone", "fax"]) }, { order: contact(["email"], ["phone"]) });
    expect(changes.filter(([k]) => k.startsWith("key-")).map(([k, b, , , d]) => [k, b, d])).toEqual([
      ["key-allowed", "all-consumers", 'key "fax" is no longer forbidden'],
    ]);
  });
});

describe("tagged unions", () => {
  const branch = (kind: string, props: JsonObject = {}) => ({
    type: "object",
    properties: { kind: { const: kind }, ...props },
    required: ["kind"],
    unevaluatedProperties: false,
  });
  const payment = (...branches: JsonObject[]) => ({
    $id: `${BASE}payment.json`,
    title: "Payment",
    oneOf: branches,
  }) as JsonObject;

  it("adding a branch breaks all consumers, removing one breaks producers", () => {
    const one = payment(branch("card"));
    const two = payment(branch("card"), branch("cash"));
    expect(diff({ payment: one }, { payment: two }).map(([k, b, base, cur, d]) => [k, b, base, cur, d])).toEqual([
      ["branch-added", "all-consumers", "payment.json#", "payment.json#/oneOf/1", 'branch "kind": "cash" added'],
    ]);
    expect(diff({ payment: two }, { payment: one }).map(([k, b]) => [k, b])).toEqual([["branch-removed", "producers"]]);
  });

  it("compares a branch that stays", () => {
    const before = payment(branch("card", { last4: { type: "string" } }));
    const after = payment(branch("card", { last4: { type: "integer" } }));
    expect(diff({ payment: before }, { payment: after }).map(([k, , b]) => [k, b])).toEqual([
      ["type-changed", "payment.json#/oneOf/0/properties/last4"],
    ]);
  });

  it("changing the tag breaks all consumers and producers", () => {
    const other = (kind: string) => ({
      type: "object",
      properties: { method: { const: kind } },
      required: ["method"],
      unevaluatedProperties: false,
    });
    expect(diff({ payment: payment(branch("card")) }, { payment: payment(other("card")) }).map(([k, b, , , d]) => [k, b, d])).toEqual([
      ["type-changed", "all-consumers,producers", 'tag changed from "kind" to "method"'],
    ]);
  });
});

describe("untagged unions", () => {
  const amount = (...branches: JsonObject[]) => order({ amount: { oneOf: branches } }, ["amount"]);

  it("adding a branch breaks all consumers, removing one breaks producers", () => {
    const one = amount({ type: "integer" });
    const two = amount({ type: "integer" }, { type: "string" });
    expect(diff({ order: one }, { order: two }).map(([k, b, , , d]) => [k, b, d])).toEqual([
      ["branch-added", "all-consumers", "branch added: string"],
    ]);
    expect(diff({ order: two }, { order: one }).map(([k, b, , , d]) => [k, b, d])).toEqual([
      ["branch-removed", "producers", "branch removed: string"],
    ]);
  });

  it("a new order of the branches breaks all consumers", () => {
    const obj = (key: string): JsonObject => ({
      type: "object",
      properties: { [key]: { type: "string" } },
      required: [key],
      unevaluatedProperties: false,
    });
    const before = amount(obj("cents"), obj("text"));
    const after = amount(obj("text"), obj("cents"));
    expect(diff({ order: before }, { order: after }).map(([k, b, , , d]) => [k, b, d])).toEqual([
      ["branch-order-changed", "all-consumers", "the order decoders try branches in changed"],
    ]);
  });

  it("compares a changed branch of the same kind", () => {
    const before = amount({ type: "integer" }, { type: "string", maxLength: 10 });
    const after = amount({ type: "integer" }, { type: "string", maxLength: 5 });
    expect(diff({ order: before }, { order: after }).map(([k, , , , d]) => [k, d])).toEqual([
      ["constraint-tightened", "maxLength 10 -> 5"],
    ]);
  });
});

describe("constraints", () => {
  it("tightening breaks producers, loosening breaks all consumers", () => {
    expect(prop({ type: "string", maxLength: 10 }, { type: "string", maxLength: 5 })).toEqual([
      ["constraint-tightened", "producers", "maxLength 10 -> 5"],
    ]);
    expect(prop({ type: "string", maxLength: 5 }, { type: "string", maxLength: 10 })).toEqual([
      ["constraint-loosened", "all-consumers", "maxLength 5 -> 10"],
    ]);
  });

  it("decides each count limit by its direction", () => {
    const kinds = (was: JsonObject, now: JsonObject) => prop(was, now).map(([k, , d]) => `${k}: ${d}`);
    expect(kinds({ type: "string" }, { type: "string", minLength: 1 })).toEqual(["constraint-tightened: minLength none -> 1"]);
    expect(kinds({ type: "string", minLength: 2 }, { type: "string", minLength: 1 })).toEqual(["constraint-loosened: minLength 2 -> 1"]);
    expect(kinds({ type: "string", maxLength: 2 }, { type: "string" })).toEqual(["constraint-loosened: maxLength 2 -> none"]);
    const list = (extra: JsonObject) => ({ type: "array", items: { type: "string" }, ...extra });
    expect(kinds(list({ minItems: 1 }), list({ minItems: 2 }))).toEqual(["constraint-tightened: minItems 1 -> 2"]);
    expect(kinds(list({ maxItems: 3 }), list({ maxItems: 4 }))).toEqual(["constraint-loosened: maxItems 3 -> 4"]);
    expect(kinds(list({}), list({ uniqueItems: true }))).toEqual(["constraint-tightened: uniqueItems added"]);
    expect(kinds(list({ uniqueItems: true }), list({}))).toEqual(["constraint-loosened: uniqueItems removed"]);
    const map = (extra: JsonObject) => ({ type: "object", additionalProperties: { type: "integer" }, ...extra });
    expect(kinds(map({}), map({ minProperties: 1 }))).toEqual(["constraint-tightened: minProperties none -> 1"]);
    expect(kinds(map({ maxProperties: 1 }), map({ maxProperties: 2 }))).toEqual(["constraint-loosened: maxProperties 1 -> 2"]);
  });

  it("compares numeric bounds, inclusive and exclusive", () => {
    const kinds = (was: JsonObject, now: JsonObject) => prop(was, now).map(([k, , d]) => `${k}: ${d}`);
    expect(kinds({ type: "number", minimum: 0 }, { type: "number", exclusiveMinimum: 0 })).toEqual([
      "constraint-tightened: lower bound >= 0 -> > 0",
    ]);
    expect(kinds({ type: "number", maximum: 10 }, { type: "number", maximum: 20 })).toEqual([
      "constraint-loosened: upper bound <= 10 -> <= 20",
    ]);
    expect(kinds({ type: "number" }, { type: "number", maximum: 1 })).toEqual(["constraint-tightened: upper bound none -> <= 1"]);
    // For integers, exclusiveMinimum 4 is minimum 5.
    expect(kinds({ type: "integer", exclusiveMinimum: 4 }, { type: "integer", minimum: 5 })).toEqual([]);
    expect(kinds({ type: "integer", minimum: 5 }, { type: "integer" })).toEqual(["constraint-loosened: lower bound >= 5 -> none"]);
  });

  it("compares multipleOf by divisibility", () => {
    const kinds = (was: JsonObject, now: JsonObject) => prop(was, now).map(([k, b, d]) => `${k} ${b}: ${d}`);
    const int = (m?: number) => (m === undefined ? { type: "integer" } : { type: "integer", multipleOf: m });
    expect(kinds(int(2), int(4))).toEqual(["constraint-tightened producers: multipleOf 2 -> 4"]);
    expect(kinds(int(4), int(2))).toEqual(["constraint-loosened all-consumers: multipleOf 4 -> 2"]);
    expect(kinds(int(2), int(3))).toEqual(["constraint-changed all-consumers,producers: multipleOf 2 -> 3"]);
    expect(kinds(int(), int(3))).toEqual(["constraint-tightened producers: multipleOf none -> 3"]);
    expect(kinds(int(3), int())).toEqual(["constraint-loosened all-consumers: multipleOf 3 -> none"]);
  });

  it("counts a changed pattern as breaking both ways, since patterns can't be compared", () => {
    const s = (pattern?: string) => (pattern === undefined ? { type: "string" } : { type: "string", pattern });
    expect(prop(s("^a"), s("^b"))).toEqual([
      ["constraint-changed", "all-consumers,producers", 'pattern changed from "^a" to "^b", which can\'t be compared'],
    ]);
    expect(prop(s(), s("^a"))).toEqual([["constraint-tightened", "producers", 'pattern "^a" added']]);
    expect(prop(s("^a"), s())).toEqual([["constraint-loosened", "all-consumers", 'pattern "^a" removed']]);
    expect(prop(s("^a"), s("^a"))).toEqual([]);
  });

  it("compares formats", () => {
    const s = (format?: string) => (format === undefined ? { type: "string" } : { type: "string", format });
    expect(prop(s(), s("uuid"))).toEqual([["constraint-tightened", "producers", 'format "uuid" added']]);
    expect(prop(s("uuid"), s())).toEqual([["constraint-loosened", "all-consumers", 'format "uuid" removed']]);
    expect(prop(s("date"), s("date-time"))).toEqual([
      ["constraint-changed", "all-consumers,producers", 'format changed from "date" to "date-time"'],
    ]);
  });

  it("compares array items and map values", () => {
    expect(prop({ type: "array", items: { type: "string" } }, { type: "array", items: { type: "integer" } }).map(([k]) => k)).toEqual([
      "type-changed",
    ]);
    const changes = diff(
      { order: order({ x: { type: "object", additionalProperties: { type: "string" } } }) },
      { order: order({ x: { type: "object", additionalProperties: { type: "integer" } } }) },
    );
    expect(changes.map(([, , b]) => b)).toEqual(["order.json#/properties/x/additionalProperties"]);
  });

  it("ignores constraints when validation is off", () => {
    const before = { order: order({ x: { type: "string", maxLength: 10 } }) };
    const after = { order: order({ x: { type: "string", maxLength: 5 } }) };
    expect(diff(before, after, { validation: false })).toEqual([]);
  });
});

describe("every change kind", () => {
  it("has a test in this file", () => {
    const text = readFileSync(new URL(import.meta.url), "utf8");
    const missing = Object.keys(BREAKS).filter((kind) => !text.includes(`"${kind}"`));
    expect(missing).toEqual([]);
  });
});

describe("report mode", () => {
  const change: Change = {
    kind: "field-added",
    base: "order.json#",
    current: "order.json#/properties/note",
    detail: 'optional field "note" added',
    breaks: ["strict-consumers"],
  };
  const required: Change = { ...change, kind: "required-field-added", breaks: ["strict-consumers", "producers"] };

  it("an added optional field is safe when every target reads in report mode", () => {
    expect(classify([change, required], true).map((c) => c.breaks)).toEqual([[], ["producers"]]);
  });

  it("keeps strict consumers when any target is strict", () => {
    expect(classify([change], false).map((c) => c.breaks)).toEqual([["strict-consumers"]]);
  });
});

describe("output", () => {
  const result = {
    base: "main",
    everyTargetReports: false,
    changes: [
      {
        kind: "field-added" as const,
        base: "order.json#",
        current: "order.json#/properties/note",
        detail: 'optional field "note" added',
        breaks: ["strict-consumers" as const],
      },
      {
        kind: "type-added" as const,
        base: null,
        current: "user.json#",
        detail: "type added",
        breaks: [],
      },
    ],
  };

  it("prints text grouped by who breaks", () => {
    expect(breakingLines(result)).toEqual([
      "Breaks strict consumers:",
      '  optional field "note" added',
      "    base:    order.json#",
      "    current: order.json#/properties/note",
      "",
      "Safe:",
      "  type added",
      "    base:    (no such file)",
      "    current: user.json#",
      "",
      "1 breaking change and 1 safe change since main.",
    ]);
  });

  it("prints a stable JSON shape", () => {
    expect(breakingJson(result)).toEqual({
      base: "main",
      breaking: true,
      everyTargetReports: false,
      changes: [
        {
          kind: "field-added",
          breaks: ["strict-consumers"],
          base: "order.json#",
          current: "order.json#/properties/note",
          detail: 'optional field "note" added',
        },
        { kind: "type-added", breaks: [], base: null, current: "user.json#", detail: "type added" },
      ],
    });
  });

  it("says when nothing changed", () => {
    expect(breakingLines({ ...result, changes: [] })).toEqual(["No changes since main."]);
  });
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "strictgen-breaking-"));
  roots.push(root);
  return root;
}

function write(root: string, files: Readonly<Record<string, unknown>>): void {
  for (const [path, value] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  }
}

function cli(argv: readonly string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, { cwd, env: process.env, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

function gitIn(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

const CONFIG = { schemas: "schemas", targets: { typescript: { out: "ts" } } };
const REPORT_CONFIG = { schemas: "schemas", targets: { typescript: { out: "ts", read: "report" } } };

describe("strictgen breaking", () => {
  const before = order({ total: { type: "integer" } }, ["total"]);
  const after = order({ total: { type: "integer" }, note: { type: "string" } }, ["total"]);

  it("compares with a schemas folder and exits 1 when something breaks", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": after, "old/order.json": before });
    const { code, out } = cli(["breaking", "--base", "old"], root);
    expect(code).toBe(EXIT_FAILED);
    expect(out[0]).toBe("Breaks strict consumers:");
  });

  it("exits 0 when every target reads in report mode", () => {
    const root = temp();
    write(root, { "strictgen.json": REPORT_CONFIG, "schemas/order.json": after, "old/order.json": before });
    const { code, out } = cli(["breaking", "--base", "old", "--json"], root);
    expect(code).toBe(EXIT_OK);
    const json = JSON.parse(out.join("\n")) as { breaking: boolean; everyTargetReports: boolean };
    expect(json.breaking).toBe(false);
    expect(json.everyTargetReports).toBe(true);
  });

  it("uses the config in a base project folder", () => {
    const root = temp();
    write(root, {
      "strictgen.json": CONFIG,
      "schemas/order.json": before,
      "old/strictgen.json": { schemas: "defs", targets: { go: { out: "go" } } },
      "old/defs/order.json": before,
    });
    const { code, out } = cli(["breaking", "--base", "old"], root);
    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["No changes since old."]);
  });

  it("compares with a git ref without touching the working tree", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    write(root, { "schemas/order.json": after });
    const { code, out } = cli(["breaking", "--base", "main", "--json"], root);
    expect(code).toBe(EXIT_FAILED);
    const json = JSON.parse(out.join("\n")) as { changes: { kind: string }[] };
    expect(json.changes.map((c) => c.kind)).toEqual(["field-added"]);
    expect(JSON.parse(readFileSync(join(root, "schemas/order.json"), "utf8"))).toEqual(after);
    expect(cli(["breaking", "--base", "HEAD"], root).code).toBe(EXIT_FAILED);
  });

  it("reads the base config at the ref, for a schemas folder that moved", () => {
    const root = temp();
    write(root, { "strictgen.json": { ...CONFIG, schemas: "old-schemas" }, "old-schemas/order.json": before });
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    expect(cli(["breaking", "--base", "main"], root)).toMatchObject({ code: EXIT_OK, out: ["No changes since main."] });
  });

  it("exits 2 for a base that is neither a folder nor a ref", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    const { code, err } = cli(["breaking", "--base", "nope"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^error: --base "nope" is neither a folder nor a git ref \(git: fatal: .+\)\. /);
    expect(err[0]).toMatch(/fetch it first \(in CI, check out with fetch-depth: 0\)$/);
    expect(cli(["breaking", "--base", "--json"], root).code).toBe(EXIT_USAGE);
  });

  it("exits 2 when git is not installed", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    const out: string[] = [];
    const err: string[] = [];
    const code = run(["breaking", "--base", "main"], {
      cwd: root,
      env: { PATH: temp() },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(err).toEqual(["error: git is not installed, so --base can only name a folder"]);
  });

  it("exits 2 for a base config at the ref that isn't valid", () => {
    const root = temp();
    write(root, { "schemas/order.json": before });
    writeFileSync(join(root, "strictgen.json"), "{ not json");
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    write(root, { "strictgen.json": CONFIG });
    const { code, err } = cli(["breaking", "--base", "main"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^error: base main: main:strictgen\.json/);
  });

  it("exits 2 outside a git repository", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    const { code, err } = cli(["breaking", "--base", "main"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err[0]).toMatch(/is not a folder, and .* is not in a git repository \(git: fatal: .+\)$/);
  });

  it("exits 2 when the schemas folder is missing at the ref", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "other/x.json": {} });
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    write(root, { "schemas/order.json": before });
    const { code, err } = cli(["breaking", "--base", "main"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toEqual(["error: base main: there is no schemas folder schemas at this ref"]);
  });

  it("exits 2 with the base named when a base schema is broken", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before, "old/order.json": { $id: `${BASE}order.json`, type: "object" } });
    const { code, err } = cli(["breaking", "--base", "old"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^error: base old: order\.json/);
  });

  it("exits 2 for a base folder without schemas", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before, "docs/x.txt": "notes" });
    mkdirSync(join(root, "empty"));
    for (const base of ["empty", "docs"]) {
      const { code, out, err } = cli(["breaking", "--base", base], root);
      expect(code).toBe(EXIT_USAGE);
      expect(out).toEqual([]);
      expect(err).toEqual([`error: base ${base}: no schema files in ${join(root, base)}`]);
    }
  });

  it("exits 2 for a base folder whose schemas declare no types", () => {
    const root = temp();
    write(root, {
      "strictgen.json": CONFIG,
      "schemas/order.json": before,
      "old/common.json": { $id: `${BASE}common.json` },
    });
    const { code, err } = cli(["breaking", "--base", "old"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toEqual([`error: base old: the schemas in ${join(root, "old")} declare no types`]);
  });

  it("exits 2 for a ref whose schemas folder has no schema files", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/notes.txt": "none yet" });
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    write(root, { "schemas/order.json": before });
    const { code, err } = cli(["breaking", "--base", "main"], root);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toEqual(["error: base main: no schema files in main:schemas"]);
  });

  it("warns when the base is both a folder and a git ref, and uses the folder", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    gitIn(root, "init", "-q", "-b", "main");
    gitIn(root, "add", ".");
    gitIn(root, "commit", "-q", "-m", "first");
    write(root, { "main/order.json": before });
    const { code, out, err } = cli(["breaking", "--base", "main"], root);
    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["No changes since main."]);
    expect(err).toEqual([
      'warning: --base "main" is both a folder and a git ref; comparing with the folder',
    ]);
  });

  it("needs --base, and --base only applies to breaking", () => {
    const root = temp();
    write(root, { "strictgen.json": CONFIG, "schemas/order.json": before });
    expect(cli(["breaking"], root).code).toBe(EXIT_USAGE);
    expect(cli(["check", "--base", "main"], root).code).toBe(EXIT_USAGE);
  });
});
