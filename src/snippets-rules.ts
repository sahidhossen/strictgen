/**
 * One small example per generation rule, for docs/schemas.md: schema files that break the rule,
 * and the same files fixed. `pnpm docs` runs `strictgen generate` on both, so the error the docs
 * show is the real one and the fixed files really generate. A schema given as an object gets a
 * `$schema` and an `$id` of `https://example.com/schemas/<file>` unless it has an `$id`; one
 * given as a string is written as it is.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuleId } from "./rules.js";

export interface RuleExample {
  /** Schema files by name, under `schemas/`. */
  readonly files: Readonly<Record<string, Record<string, unknown> | string>>;
  /** The same files, fixed. Left out when the fix isn't a schema change. */
  readonly fixed?: Readonly<Record<string, Record<string, unknown> | string>>;
  /** Config keys beside `schemas` and a TypeScript target. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** The command, `generate` when left out. */
  readonly args?: readonly string[];
  /** Prepares the folder after the files are written. */
  readonly setup?: (folder: string) => void;
}

const closed = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
  ...extra,
});

const ORDER = { title: "Order" };

/**
 * The example of every rule, or null for a rule no schema can trigger. `internal` is a generator
 * bug, never a schema problem.
 */
export const RULE_EXAMPLES: Readonly<Record<RuleId, RuleExample | null>> = {
  "read-failed": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
    config: { schemas: "schema" },
  },
  "invalid-json": {
    files: { "order.json": '{ "title": "Order", "type": "object", }\n' },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
  },
  "invalid-schema": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), required: "id" } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
  },
  "schema-id": {
    files: {
      "order.json": { $id: "https://example.com/schemas/order.json", ...ORDER, ...closed({ id: { type: "string" } }) },
      "user.json": { $id: "https://example.com/users/user.json", title: "User", ...closed({ id: { type: "string" } }) },
    },
    fixed: {
      "order.json": { $id: "https://example.com/schemas/order.json", ...ORDER, ...closed({ id: { type: "string" } }) },
      "user.json": { $id: "https://example.com/schemas/user.json", title: "User", ...closed({ id: { type: "string" } }) },
    },
  },
  "missing-title": {
    files: { "order.json": closed({ id: { type: "string" } }) },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
  },
  "unresolved-ref": {
    files: { "order.json": { ...ORDER, ...closed({ user: { $ref: "https://example.com/schemas/user.json" } }) } },
    fixed: {
      "order.json": { ...ORDER, ...closed({ user: { $ref: "https://example.com/schemas/user.json" } }) },
      "user.json": { title: "User", ...closed({ id: { type: "string" } }) },
    },
  },
  "ref-form": {
    files: {
      "order.json": {
        ...ORDER,
        ...closed({ id: { type: "string" }, copy: { $ref: "#/properties/id" } }),
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        ...closed({ id: { $ref: "#/$defs/orderId" }, copy: { $ref: "#/$defs/orderId" } }),
        $defs: { orderId: { type: "string" } },
      },
    },
  },
  "ref-cycle": {
    files: { "order.json": { ...ORDER, ...closed({ id: { $ref: "#/$defs/code" } }), $defs: { code: { $ref: "#/$defs/code" } } } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { $ref: "#/$defs/code" } }), $defs: { code: { type: "string" } } } },
  },
  "ref-siblings": {
    files: {
      "order.json": {
        ...ORDER,
        ...closed({ customer: { $ref: "#/$defs/customer", properties: { vip: { type: "boolean" } } } }),
        $defs: { customer: closed({ name: { type: "string" } }) },
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        ...closed({ customer: { $ref: "#/$defs/customer" } }),
        $defs: { customer: closed({ name: { type: "string" }, vip: { type: "boolean" } }) },
      },
    },
  },
  "unsupported-keyword": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string", contentEncoding: "base64" } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string", description: "Base64 text." } }) } },
  },
  "misplaced-keyword": {
    files: { "order.json": { ...ORDER, ...closed({ quantity: { type: "integer", maxLength: 3 } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ quantity: { type: "integer", maximum: 999 } }) } },
  },
  "unsupported-type": {
    files: { "order.json": { ...ORDER, ...closed({ note: { type: ["string", "null"] } }) } },
    fixed: { "order.json": { ...ORDER, type: "object", properties: { note: { type: "string" } }, additionalProperties: false } },
  },
  "unsupported-format": {
    files: { "order.json": { ...ORDER, ...closed({ email: { type: "string", format: "email" } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ email: { type: "string", pattern: "^[^@]+@[^@]+$" } }) } },
  },
  "unsupported-pattern": {
    files: { "order.json": { ...ORDER, ...closed({ code: { type: "string", pattern: "^(?=.*\\d)[A-Z0-9]+$" } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ code: { type: "string", pattern: "^[A-Z]*[0-9][A-Z0-9]*$" } }) } },
  },
  "unsupported-constraint": {
    files: { "order.json": { ...ORDER, ...closed({ price: { type: "number", multipleOf: 0.01 } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ cents: { type: "integer", multipleOf: 1 } }) } },
  },
  "invalid-constraint": {
    files: { "order.json": { ...ORDER, ...closed({ note: { type: "string", minLength: 10, maxLength: 5 } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ note: { type: "string", minLength: 5, maxLength: 10 } }) } },
  },
  "unsupported-not": {
    files: { "order.json": { ...ORDER, ...closed({ role: { type: "string", not: { enum: ["admin"] } } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ role: { enum: ["owner", "member"] } }) } },
  },
  "unsupported-const": {
    files: { "order.json": { ...ORDER, ...closed({ rate: { const: 1.5 } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ rate: { const: "1.5" } }) } },
  },
  "unsupported-enum": {
    files: { "order.json": { ...ORDER, ...closed({ size: { enum: [1, 2, 3] } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ size: { enum: ["1", "2", "3"] } }) } },
  },
  "missing-type": {
    files: { "order.json": { ...ORDER, ...closed({ line: { description: "A line.", properties: { sku: { type: "string" } } } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ line: { description: "A line.", ...closed({ sku: { type: "string" } }) } }) } },
  },
  "type-mismatch": {
    files: { "order.json": { ...ORDER, ...closed({ id: { $ref: "#/$defs/orderId" } }), $defs: { orderId: { type: "integer" } } } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { $ref: "#/$defs/orderId" } }), $defs: { orderId: { type: "string" } } } },
    config: { ids: { file: "order", suffix: "Id" } },
  },
  "missing-items": {
    files: { "order.json": { ...ORDER, ...closed({ tags: { type: "array" } }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ tags: { type: "array", items: { type: "string" } } }) } },
  },
  "map-values": {
    files: { "order.json": { ...ORDER, ...closed({ labels: { type: "object", propertyNames: { type: "string", maxLength: 8 } } }) } },
    fixed: {
      "order.json": {
        ...ORDER,
        ...closed({ labels: { type: "object", propertyNames: { type: "string", maxLength: 8 }, additionalProperties: { type: "string" } } }),
      },
    },
  },
  "unsupported-map-key": {
    files: {
      "order.json": {
        ...ORDER,
        ...closed({ counts: { type: "object", propertyNames: { type: "integer" }, additionalProperties: { type: "integer" } } }),
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        ...closed({ counts: { type: "object", propertyNames: { type: "string", pattern: "^[0-9]+$" }, additionalProperties: { type: "integer" } } }),
      },
    },
  },
  "open-object": {
    files: { "order.json": { ...ORDER, type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
  },
  "closed-with-allof": {
    files: {
      "order.json": {
        ...ORDER,
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        properties: { total: { type: "integer" } },
        additionalProperties: false,
        $defs: { base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        properties: { total: { type: "integer" } },
        unevaluatedProperties: false,
        $defs: { base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      },
    },
  },
  "undeclared-key": {
    files: { "order.json": { ...ORDER, type: "object", properties: { id: { type: "string" } }, required: ["id", "total"], additionalProperties: false } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" }, total: { type: "integer" } }) } },
  },
  "property-redeclared": {
    files: {
      "order.json": {
        ...ORDER,
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        properties: { id: { type: "integer" } },
        unevaluatedProperties: false,
        $defs: { base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        type: "object",
        allOf: [{ $ref: "#/$defs/base" }],
        properties: { id: { type: "string" } },
        unevaluatedProperties: false,
        $defs: { base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      },
    },
  },
  "unsupported-branch": {
    files: {
      "order.json": {
        ...ORDER,
        type: "object",
        properties: { email: { type: "string" }, phone: { type: "string" } },
        oneOf: [{ required: ["email"], properties: { email: { type: "string" } } }, { required: ["phone"] }],
        unevaluatedProperties: false,
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        type: "object",
        properties: { email: { type: "string" }, phone: { type: "string" } },
        oneOf: [{ required: ["email"] }, { required: ["phone"] }],
        unevaluatedProperties: false,
      },
    },
  },
  "union-tag": {
    files: {
      "payment.json": {
        title: "Payment",
        oneOf: [
          closed({ type: { const: "card" }, last4: { type: "string" } }),
          closed({ type: { const: "card" }, iban: { type: "string" } }),
        ],
      },
    },
    fixed: {
      "payment.json": {
        title: "Payment",
        oneOf: [
          closed({ type: { const: "card" }, last4: { type: "string" } }),
          closed({ type: { const: "wire" }, iban: { type: "string" } }),
        ],
      },
    },
  },
  "untagged-union": {
    files: {
      "payment.json": {
        title: "Payment",
        oneOf: [{ type: "string", maxLength: 4 }, { type: "string", pattern: "^[0-9]+$" }],
      },
    },
    fixed: {
      "payment.json": {
        title: "Payment",
        oneOf: [{ type: "string", maxLength: 4 }, { type: "integer" }],
      },
    },
  },
  "alias-cycle": {
    files: {
      "order.json": {
        ...ORDER,
        ...closed({ parts: { $ref: "#/$defs/parts" } }),
        $defs: { parts: { type: "array", items: { $ref: "#/$defs/parts" } } },
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        ...closed({ parts: { $ref: "#/$defs/parts" } }),
        $defs: {
          parts: { type: "array", items: { $ref: "#/$defs/part" } },
          part: closed({ parts: { $ref: "#/$defs/parts" } }),
        },
      },
    },
  },
  "name-clash": {
    files: {
      "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), $defs: { orderLine: { type: "string" }, OrderLine: { type: "integer" } } },
    },
    fixed: {
      "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), $defs: { orderLine: { type: "string" }, lineCount: { type: "integer" } } },
    },
  },
  "reserved-name": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), $defs: { record: closed({ id: { type: "string" } }) } } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), $defs: { auditRecord: closed({ id: { type: "string" } }) } } },
  },
  "unsupported-name": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), $defs: { "2fa": { type: "string" } } } },
    fixed: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }), $defs: { twoFactor: { type: "string" } } } },
  },
  "llm-unsupported": {
    files: { "order.json": { ...ORDER, ...closed({ meta: {} }) } },
    fixed: { "order.json": { ...ORDER, ...closed({ meta: { type: "object", additionalProperties: { type: "string" } } }) } },
    config: { llm: { profiles: ["openai"], out: "out/llm" } },
  },
  "llm-limit": {
    files: {
      "order.json": {
        ...ORDER,
        ...closed({ size: { enum: ["xs", "s", "m", "l", "xl", "xxl"] } }),
      },
    },
    fixed: {
      "order.json": {
        ...ORDER,
        ...closed({ size: { enum: ["s", "m", "l"] } }),
      },
    },
    config: { llm: { profiles: ["profiles/small.json"], out: "out/llm" } },
    setup: (folder) => {
      mkdirSync(join(folder, "profiles"), { recursive: true });
      writeFileSync(
        join(folder, "profiles", "small.json"),
        `${JSON.stringify({ name: "small", version: 1, date: "2026-11-06", description: "A provider that takes at most 5 enum values", sources: [{ url: "https://example.com/structured-output", checked: "2026-11-06", notes: "At most 5 enum values." }], keywords: [], formats: [], maps: "entries", recursion: false, limits: { maxEnumValues: 5 } }, null, 2)}\n`,
      );
    },
  },
  "output-conflict": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
    config: { targets: { go: { out: "go", package: "types", shared: true } } },
    setup: (folder) => {
      mkdirSync(join(folder, "go"), { recursive: true });
      writeFileSync(join(folder, "go", "order.go"), "package types\n\n// Written by hand.\n");
    },
  },
  "write-failed": {
    files: { "order.json": { ...ORDER, ...closed({ id: { type: "string" } }) } },
    setup: (folder) => {
      // A folder no one may write in, so the output folder can't be made in it.
      mkdirSync(join(folder, "out"), { recursive: true, mode: 0o555 });
    },
  },
  internal: null,
};
