import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildModel } from "../build.js";
import { ERROR_CODES } from "../errors.js";
import type { Model } from "../model.js";
import type { JsonObject } from "../schema.js";
import { schemaSet } from "../schema.js";
import type { Case } from "./cases.js";
import { caseRules, coverage, coverageGaps, coverageLines, RULES } from "./coverage.js";
import { conformanceModel } from "./drivers.js";
import { loadSuite } from "./suite.js";

const BASE = "https://example.com/schemas/v1/";
const CONFORMANCE = join(import.meta.dirname, "..", "..", "conformance");

function model(files: Readonly<Record<string, JsonObject>>): Model {
  return buildModel(schemaSet(Object.fromEntries(Object.entries(files).map(([name, root]) => [name, { $id: `${BASE}${name}.json`, ...root }]))));
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const ok = { accepted: true as const, unknown: [] };

function valid(type: string, text: string, id = `${type}/valid/a`): Case {
  return { id, type, valid: true, bytes: bytes(text), strict: ok, report: ok };
}

function invalid(type: string, text: string, path: string, code: string, id = `${type}/invalid/${code}${path.replaceAll("/", "-")}`): Case {
  const outcome = { accepted: false as const, path, code };
  return { id, type, valid: false, bytes: bytes(text), strict: outcome, report: outcome };
}

/** An order with one of most constructs, from neutral data. */
const M = model({
  order: {
    title: "Order",
    type: "object",
    properties: {
      id: { $ref: "#/$defs/code" },
      note: { type: "string", minLength: 2, maxLength: 5, pattern: "^[a-z]+$" },
      at: { type: "string", format: "date-time" },
      count: { type: "integer", minimum: 1, exclusiveMaximum: 10, multipleOf: 2 },
      big: { type: "integer" },
      price: { type: "number", exclusiveMinimum: 0, maximum: 5 },
      paid: { type: "boolean" },
      version: { const: 2 },
      final: { const: true },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2, uniqueItems: true },
      labels: { type: "object", propertyNames: { $ref: "#/$defs/status" }, additionalProperties: { type: "integer" }, maxProperties: 1 },
      payment: { $ref: "#/$defs/payment" },
      contact: { $ref: "#/$defs/contact" },
      size: { oneOf: [{ type: "integer" }, { type: "string" }] },
      label: { not: { const: null } },
      meta: {},
      next: { $ref: "#" },
    },
    required: ["id"],
    additionalProperties: false,
    $defs: {
      code: { type: "string", minLength: 3 },
      status: { enum: ["open", "paid"] },
      one: { const: "only" },
      payment: { oneOf: [{ $ref: "#/$defs/card" }, { $ref: "#/$defs/wire" }] },
      card: { type: "object", properties: { kind: { const: "card" } }, required: ["kind"], additionalProperties: false },
      wire: { type: "object", properties: { kind: { const: "wire" }, iban: { type: "string" } }, required: ["kind", "iban"], additionalProperties: false },
      contact: {
        type: "object",
        properties: { email: { type: "string" }, phone: { type: "string" } },
        oneOf: [{ required: ["email"] }, { required: ["phone"] }],
        unevaluatedProperties: false,
      },
      extra: { type: "object", properties: { channel: { type: "string" } }, additionalProperties: { type: "string", maxLength: 2 } },
    },
  },
});

const rules = (c: Case): string[] => [...(caseRules(M, [c]).get(c.id) ?? [])].sort();

describe("the mapping rules a valid case covers", () => {
  it("are every type, declaration and constraint its value is read through", () => {
    const text = JSON.stringify({
      id: "abc",
      note: "ab",
      count: 2,
      price: 1,
      paid: true,
      version: 2,
      final: true,
      tags: ["a"],
      labels: { open: 1 },
      payment: { kind: "wire", iban: "x" },
      contact: { email: "a" },
      size: 1,
      label: [],
      meta: null,
    });
    expect(rules(valid("Order", text))).toEqual([
      "alias",
      "any",
      "array",
      "array.maxItems",
      "array.minItems",
      "array.uniqueItems",
      "boolean",
      "const.boolean",
      "const.integer",
      // The tag of a branch, a const of one string.
      "const.string",
      "enum",
      "integer",
      "integer.exclusiveMaximum",
      "integer.minimum",
      "integer.multipleOf",
      "map",
      "map.key",
      "map.maxProperties",
      "non-null",
      "number",
      "number.exclusiveMinimum",
      "number.maximum",
      "object",
      "object.exactly-one",
      "object.optional",
      "object.required",
      "string",
      "string.maxLength",
      "string.minLength",
      "string.pattern",
      "tagged",
      "untagged",
    ]);
  });

  it("include a recursive field, a 64-bit integer, a const string and the rest of a struct", () => {
    expect(rules(valid("Order", '{"id":"abc","next":{"id":"def"},"big":9223372036854775807}'))).toEqual(
      expect.arrayContaining(["integer.int64", "object.recursive"]),
    );
    expect(rules(valid("One", '"only"'))).toEqual(["const.string"]);
    expect(rules(valid("Extra", '{"channel":"web","x":"ab"}'))).toEqual(["object", "object.optional", "object.rest", "string", "string.maxLength"]);
    expect(rules(valid("Order", '{"id":"abc","at":"2026-01-01T00:00:00Z"}'))).toContain("format.date-time");
  });
});

describe("the mapping rules an invalid case covers", () => {
  it.each([
    ['{"id":"abc","x":1}', "/x", "unknown_key", ["object"]],
    ["{}", "/id", "missing_key", ["object.required"]],
    ['{"id":"abc","note":null}', "/note", "null_not_allowed", ["object.optional"]],
    ['{"id":"abc","label":null}', "/label", "null_not_allowed", ["non-null", "object.optional"]],
    ['{"id":"ab"}', "/id", "too_short", ["alias", "string.minLength"]],
    ['{"id":"abc","note":"abcdef"}', "/note", "too_long", ["string.maxLength"]],
    ['{"id":"abc","note":"AB"}', "/note", "pattern_mismatch", ["string.pattern"]],
    ['{"id":"abc","at":"x"}', "/at", "bad_format", ["format.date-time"]],
    ['{"id":"abc","count":0}', "/count", "too_small", ["integer.minimum"]],
    ['{"id":"abc","count":10}', "/count", "too_large", ["integer.exclusiveMaximum"]],
    ['{"id":"abc","count":3}', "/count", "not_multiple_of", ["integer.multipleOf"]],
    ['{"id":"abc","count":1.5}', "/count", "wrong_type", ["integer"]],
    ['{"id":"abc","big":9223372036854775808}', "/big", "out_of_range_integer", ["integer.int64"]],
    ['{"id":"abc","price":0}', "/price", "too_small", ["number.exclusiveMinimum"]],
    ['{"id":"abc","price":6}', "/price", "too_large", ["number.maximum"]],
    ['{"id":"abc","price":"1"}', "/price", "wrong_type", ["number"]],
    ['{"id":"abc","paid":1}', "/paid", "wrong_type", ["boolean"]],
    ['{"id":"abc","version":3}', "/version", "not_const", ["const.integer"]],
    ['{"id":"abc","final":false}', "/final", "not_const", ["const.boolean"]],
    ['{"id":"abc","tags":[]}', "/tags", "too_short", ["array.minItems"]],
    ['{"id":"abc","tags":["a","b","c"]}', "/tags", "too_long", ["array.maxItems"]],
    ['{"id":"abc","tags":["a","a"]}', "/tags/1", "not_unique", ["array.uniqueItems"]],
    ['{"id":"abc","tags":{}}', "/tags", "wrong_type", ["array"]],
    ['{"id":"abc","labels":[]}', "/labels", "wrong_type", ["map"]],
    ['{"id":"abc","labels":{"open":1,"paid":2}}', "/labels", "too_long", ["map.maxProperties"]],
    ['{"id":"abc","labels":{"gone":1}}', "/labels/gone", "not_in_enum", ["enum", "map.key"]],
    ['{"id":"abc","payment":{"kind":"cash"}}', "/payment/kind", "bad_tag", ["tagged"]],
    ['{"id":"abc","payment":{}}', "/payment/kind", "missing_key", ["tagged"]],
    ['{"id":"abc","payment":{"kind":"wire"}}', "/payment/iban", "missing_key", ["object.required"]],
    ['{"id":"abc","size":true}', "/size", "wrong_type", ["untagged"]],
    ['{"id":"abc","contact":{"email":"a","phone":"b"}}', "/contact", "wrong_type", ["object.exactly-one", "untagged"]],
    // Fails for null or a missing key, not for the keys of the other branch, unless the phone
    // branch would take the object but for the email key it forbids.
    ['{"id":"abc","contact":{"email":null}}', "/contact", "wrong_type", ["untagged"]],
    ['{"id":"abc","contact":{"email":null,"phone":"b"}}', "/contact", "wrong_type", ["object.exactly-one", "untagged"]],
    ['{"id":"abc","contact":{}}', "/contact", "wrong_type", ["untagged"]],
    ['{"id":"abc","next":{}}', "/next/id", "missing_key", ["object.recursive", "object.required"]],
    ['{"id":"abc"', "", "invalid_json", []],
  ])("%s at %s with %s", (text, path, code, want) => {
    expect(rules(invalid("Order", text, path, code))).toEqual(want);
  });

  it("tell a map key's error from its value's by the key", () => {
    const extra = (text: string, path: string, code: string): string[] => [...(caseRules(M, [invalid("Extra", text, path, code)]).values().next().value ?? [])].sort();
    expect(extra('{"x":"abc"}', "/x", "too_long")).toEqual(["object.rest", "string.maxLength"]);
    expect(rules(invalid("One", '"two"', "", "not_const"))).toEqual(["const.string"]);
  });
});

/** A reward that may cap another reward, and a condition that may negate another, each closing its cycle at a union branch. */
const R = model({
  promotion: {
    title: "Promotion",
    type: "object",
    properties: { reward: { $ref: "#/$defs/reward" }, when: { $ref: "#/$defs/when" } },
    required: ["reward"],
    additionalProperties: false,
    $defs: {
      reward: { oneOf: [{ $ref: "#/$defs/capped" }, { $ref: "#/$defs/percent" }] },
      capped: { type: "object", properties: { kind: { const: "capped" }, reward: { $ref: "#/$defs/reward" } }, required: ["kind", "reward"], additionalProperties: false },
      percent: { type: "object", properties: { kind: { const: "percent" }, n: { type: "integer", minimum: 1 } }, required: ["kind", "n"], additionalProperties: false },
      when: { oneOf: [{ type: "integer", minimum: 0 }, { $ref: "#/$defs/negation" }] },
      negation: { type: "object", properties: { unless: { $ref: "#/$defs/when" } }, required: ["unless"], additionalProperties: false },
    },
  },
});

describe("the mapping rules of a union branch that closes a cycle", () => {
  const of = (c: Case): string[] => [...(caseRules(R, [c]).get(c.id) ?? [])].sort();

  it("are boxed branches in the model", () => {
    const boxed = R.decls.flatMap((d) => (d.kind === "tagged" || d.kind === "untagged" ? d.variants.filter((v) => v.boxed).map(() => d.name) : []));
    expect(boxed).toEqual(["Reward", "When"]);
  });

  it("count for a value read through the branch", () => {
    expect(of(valid("Promotion", '{"reward":{"kind":"capped","reward":{"kind":"percent","n":1}}}'))).toContain("tagged.recursive");
    expect(of(valid("Promotion", '{"reward":{"kind":"percent","n":1}}'))).not.toContain("tagged.recursive");
    expect(of(valid("Promotion", '{"reward":{"kind":"percent","n":1},"when":{"unless":3}}'))).toContain("untagged.recursive");
    expect(of(valid("Promotion", '{"reward":{"kind":"percent","n":1},"when":3}'))).not.toContain("untagged.recursive");
  });

  it("count for an error read through the branch", () => {
    expect(of(invalid("Promotion", '{"reward":{"kind":"capped","reward":{"kind":"percent","n":0}}}', "/reward/reward/n", "too_small"))).toEqual(["integer.minimum", "tagged.recursive"]);
    expect(of(invalid("Promotion", '{"reward":{"kind":"percent","n":1},"when":{"unless":-1}}', "/when/unless", "too_small"))).toEqual([
      "integer.minimum",
      "untagged.recursive",
    ]);
    expect(of(invalid("Promotion", '{"reward":{"kind":"percent","n":0}}', "/reward/n", "too_small"))).toEqual(["integer.minimum"]);
  });
});

describe("the coverage report", () => {
  const cases = [valid("One", '"only"'), invalid("One", '"two"', "", "not_const")];
  const report = coverage(M, cases);

  it("lists each side of a rule and each code without a case", () => {
    const gaps = coverageGaps(report, new Map());
    expect(gaps).toContain("mapping rule object has no valid case");
    expect(gaps).toContain("mapping rule object has no invalid case");
    expect(gaps).not.toContain("mapping rule const.string has no valid case");
    expect(gaps).not.toContain("mapping rule const.string has no invalid case");
    expect(gaps).toContain("error code too_deep has no case");
    expect(gaps).not.toContain("error code not_const has no case");
    // Every rule and every code is checked.
    expect(gaps.length).toBe(RULES.length * 2 - 2 + ERROR_CODES.length - 1);
  });

  it("takes an allowance only with a reason it still needs", () => {
    const allowed = new Map([
      ["object/valid", "why"],
      ["const.string/valid", "why"],
      ["nothing/valid", "why"],
      ["object/both", "why"],
    ]);
    const gaps = coverageGaps(report, allowed);
    expect(gaps).not.toContain("mapping rule object has no valid case");
    expect(gaps).toContain("manifest.json: coverage const.string/valid has 1 cases now, so remove it");
    expect(gaps).toContain("manifest.json: coverage nothing/valid is not <rule>/valid or <rule>/invalid");
    expect(gaps).toContain("manifest.json: coverage object/both is not <rule>/valid or <rule>/invalid");
  });

  it("prints every rule and code with its counts", () => {
    const lines = coverageLines(report, new Map([["object/valid", "why"]]));
    expect(lines).toContain("const.string              1        1");
    expect(lines.find((l) => l.startsWith("object  "))).toBe("object                    -        MISSING");
    expect(lines.length).toBe(RULES.length + ERROR_CODES.length + 3);
  });

  it("names each rule once, by a stable id", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    expect(RULES.every((r) => /^[a-z0-9-]+(\.[a-zA-Z0-9-]+)?$/.test(r.id) && r.text.length > 0)).toBe(true);
  });
});

describe("the conformance cases", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("cover every side of every mapping rule and every error code", () => {
    const dir = mkdtempSync(join(tmpdir(), "strictgen-coverage-"));
    dirs.push(dir);
    // loadSuite fails on any gap; this lists them in the test's output too.
    const { coverage: report, manifest } = loadSuite(CONFORMANCE, conformanceModel(CONFORMANCE, dir));
    expect(coverageGaps(report, manifest.coverage)).toEqual([]);
    for (const rule of RULES) {
      for (const side of ["valid", "invalid"] as const) {
        const n = report.rules.get(rule.id)?.[side].length ?? 0;
        expect(n > 0 || manifest.coverage.has(`${rule.id}/${side}`), `${rule.id}/${side}`).toBe(true);
      }
    }
    for (const { code } of ERROR_CODES) expect(report.codes.get(code)?.length ?? 0, code).toBeGreaterThan(0);
  });
});
