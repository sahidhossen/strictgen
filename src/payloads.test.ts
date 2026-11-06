import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { loadConfig } from "./config.js";
import type { ReadMode } from "./config.js";
import { emitTypeScript } from "./emit-ts.js";
import type { Model } from "./model.js";
import type { NearMiss, Payload } from "./payloads.js";
import { canonical, GenerateError, inFormat, PayloadGenerator, Random } from "./payloads.js";
import type { JsonObject } from "./schema.js";
import { loadSchemas, schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

function schema(name: string, body: JsonObject): JsonObject {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${BASE}${name}.json`,
    title: name,
    ...body,
  };
}

function build(files: Record<string, JsonObject>, validation = true): Model {
  return buildModel(schemaSet(files), { ids: { file: "common", suffix: "Id" }, validation });
}

function lib(entries: JsonObject): Model {
  return build({ lib: schema("lib", { $defs: entries }) });
}

const closed = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

/** More seeds for a longer run, like PAYLOAD_SEED_SCALE=50 pnpm vitest run src/payloads.test.ts. */
const SCALE = Number(process.env.PAYLOAD_SEED_SCALE ?? "1");
/** The time a test that decodes payloads for many seeds may take. */
const RUN_TIMEOUT = 60_000 * SCALE;

/** A tsc cold start takes longer than vitest's default hook timeout. */
const COMPILE_TIMEOUT = 60_000;

const folders: string[] = [];
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

type Fn = (...args: unknown[]) => unknown;
interface Decoded {
  readonly ok: boolean;
  readonly error?: { readonly path: string; readonly code: string; readonly message: string };
}

/** Typechecks the generated TypeScript, transpiles it and loads `index.js`. */
async function decoders(model: Model, read: ReadMode = "strict"): Promise<(name: string) => Fn> {
  const files = emitTypeScript(model, { read });
  const dir = mkdtempSync(join(tmpdir(), "strictgen-payloads-"));
  folders.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  for (const f of files) writeFileSync(join(dir, f.name), f.contents);
  const program = ts.createProgram(
    files.map((f) => join(dir, f.name)),
    {
      target: ts.ScriptTarget.ES2023,
      lib: ["lib.es2023.d.ts"],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      types: [],
    },
  );
  const problems = ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    return d.file === undefined ? text : `${relative(dir, d.file.fileName)}: ${text}`;
  });
  if (problems.length > 0) throw new Error(`generated TypeScript fails to compile:\n${problems.join("\n")}`);
  for (const f of files) {
    const js = ts.transpileModule(f.contents, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    writeFileSync(join(dir, f.name.replace(/\.ts$/, ".js")), js);
  }
  const module = (await import(pathToFileURL(join(dir, "index.js")).href)) as Record<string, unknown>;
  return (name) => {
    const fn = module[name];
    if (typeof fn !== "function") throw new Error(`index.ts exports no function ${name}`);
    return fn as Fn;
  };
}

/** Decodes a payload as `type` from its JSON text, the way a service reads it. */
function decode(fn: (name: string) => Fn, type: string, payload: Payload): Decoded {
  return fn(`tryDecode${type}FromJson`)(JSON.stringify(payload)) as Decoded;
}

/**
 * Checks, for `seeds` seeds, that every valid payload of every type decodes and every near
 * miss fails with its label. Returns the codes the near misses had, to check what was covered.
 */
function checkAll(
  model: Model,
  fn: (name: string) => Fn,
  options: { seeds: number; read?: ReadMode; skip?: readonly string[] },
): Set<string> {
  const codes = new Set<string>();
  for (const decl of model.decls) {
    if (options.skip?.includes(decl.name)) continue;
    for (let seed = 0; seed < options.seeds * SCALE; seed++) {
      const g = new PayloadGenerator(model, { seed, ...(options.read === undefined ? {} : { read: options.read }) });
      const value = g.valid(decl.name);
      const result = decode(fn, decl.name, value);
      if (!result.ok) {
        throw new Error(`valid ${decl.name} (seed ${String(seed)}) failed: ${JSON.stringify(value)}: ${result.error?.message ?? ""}`);
      }
      for (const miss of g.nearMisses(decl.name)) {
        const failed = decode(fn, decl.name, miss.payload);
        const got = failed.ok ? "accepted" : `${failed.error?.path ?? ""} ${failed.error?.code ?? ""}`;
        if (got !== `${miss.path} ${miss.code}`) {
          throw new Error(
            `near miss of ${decl.name} (seed ${String(seed)}, ${miss.change}): ${JSON.stringify(miss.payload)} ` +
              `should fail with ${miss.path} ${miss.code}, got ${got}`,
          );
        }
        codes.add(miss.code);
      }
    }
  }
  return codes;
}

/** A model with every construct: ids, enums, consts, unions of each kind, maps, rest keys, recursion and every constraint. */
function richModel(validation = true): Model {
  const common = schema("common", {
    $defs: {
      orderId: { description: "An order id.", type: "string", pattern: "^ord_[a-z0-9]{4,8}$" },
      userId: { type: "string", minLength: 3, maxLength: 6 },
    },
  });
  const order = schema("order", {
    type: "object",
    properties: {
      id: { $ref: `${BASE}common.json#/$defs/orderId` },
      buyer: { $ref: `${BASE}common.json#/$defs/userId` },
      quantity: { type: "integer", minimum: 1, maximum: 99 },
      packSize: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 50, multipleOf: 6 },
      price: { type: "number", minimum: 0.5, exclusiveMaximum: 1000 },
      discount: { type: "number", exclusiveMinimum: 0, maximum: 0.75 },
      note: { type: "string", minLength: 2, maxLength: 5 },
      sku: { type: "string", pattern: "^[A-Z]{2}-\\d{3}$" },
      loose: { type: "string", pattern: "x+y", maxLength: 8 },
      placedAt: { type: "string", format: "date-time" },
      day: { type: "string", format: "date" },
      ref: { type: "string", format: "uuid" },
      status: { enum: ["open", "paid", "shipped"] },
      kind: { const: "order" },
      version: { const: 2 },
      flag: { const: true },
      tags: { type: "array", items: { type: "string", maxLength: 3 }, minItems: 1, maxItems: 3, uniqueItems: true },
      lines: { type: "array", items: { $ref: "#/$defs/line" }, maxItems: 2 },
      attributes: {
        type: "object",
        propertyNames: { type: "string", maxLength: 4 },
        additionalProperties: { type: "integer", minimum: 0 },
        minProperties: 1,
        maxProperties: 2,
      },
      byStatus: {
        type: "object",
        propertyNames: { enum: ["open", "paid"] },
        additionalProperties: { type: "boolean" },
      },
      size: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", maxLength: 2 }] },
      payment: { $ref: "#/$defs/payment" },
      contact: { $ref: "#/$defs/contact" },
      extra: {},
      data: { $ref: "#/$defs/category" },
      prices: { $ref: "#/$defs/prices" },
    },
    required: ["id", "quantity", "price", "status", "tags", "payment"],
    additionalProperties: false,
    $defs: {
      line: closed({ sku: { type: "string", minLength: 3, maxLength: 3 }, count: { type: "integer", minimum: 1 } }, [
        "sku",
        "count",
      ]),
      payment: {
        oneOf: [
          closed({ type: { const: "card" }, last4: { type: "string", pattern: "^\\d{4}$" } }, ["type", "last4"]),
          closed({ type: { const: "bank" }, iban: { type: "string", minLength: 5 } }, ["type", "iban"]),
        ],
      },
      contact: {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
        required: ["name"],
        oneOf: [{ required: ["email"] }, { required: ["phone"] }],
        unevaluatedProperties: false,
      },
      category: closed(
        { name: { type: "string", maxLength: 10 }, children: { type: "array", items: { $ref: "#/$defs/category" } } },
        ["name"],
      ),
      prices: {
        type: "object",
        properties: { default: { type: "number", minimum: 0 } },
        required: ["default"],
        propertyNames: { type: "string", maxLength: 3 },
        additionalProperties: { type: "number", minimum: 0 },
      },
    },
  });
  return build({ common, order }, validation);
}

describe("random numbers", () => {
  it("give the same numbers for the same seed, and others for another", () => {
    const a = new Random(7);
    const b = new Random(7);
    const c = new Random(8);
    const first = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(first);
    expect(first.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("keep integers within their bounds", () => {
    const r = new Random(1);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(-3, 3);
      expect(n >= -3 && n <= 3 && Number.isInteger(n)).toBe(true);
    }
    expect(r.int(5, 5)).toBe(5);
  });
});

describe("payload generator determinism", () => {
  const model = richModel();

  it("gives the same payloads and near misses for the same seed", () => {
    const run = (seed: number): string => {
      const g = new PayloadGenerator(model, { seed });
      return JSON.stringify([g.valid("Order"), g.valid("Order"), g.nearMisses("Order")]);
    };
    expect(run(3)).toBe(run(3));
    expect(run(3)).not.toBe(run(4));
  });

  it("labels near misses with a JSON Pointer, a code and what changed", () => {
    const misses = new PayloadGenerator(model, { seed: 1 }).nearMisses("Order");
    expect(misses.length).toBeGreaterThan(20);
    expect(misses).toContainEqual(
      expect.objectContaining({ path: "/id", code: "missing_key", change: 'removed the required key "id"' }),
    );
    expect(misses).toContainEqual(expect.objectContaining({ path: "/unexpected", code: "unknown_key" }));
    expect(misses).toContainEqual(expect.objectContaining({ path: "/payment/type", code: "bad_tag" }));
  });
});

describe("payload generator against the TypeScript decoders", () => {
  const model = richModel();
  let fn: (name: string) => Fn;
  beforeAll(async () => {
    fn = await decoders(model);
  }, COMPILE_TIMEOUT);

  it("makes valid payloads that decode, and near misses that fail with their label", () => {
    const codes = checkAll(model, fn, { seeds: 25 });
    expect([...codes].sort()).toEqual(
      [
        "bad_format",
        "bad_tag",
        "missing_key",
        "not_const",
        "not_in_enum",
        "not_multiple_of",
        "not_unique",
        "null_not_allowed",
        "pattern_mismatch",
        "too_large",
        "too_long",
        "too_short",
        "too_small",
        "unknown_key",
        "wrong_type",
      ].sort(),
    );
  }, RUN_TIMEOUT);

  it("keeps every constraint in valid payloads", () => {
    for (let seed = 0; seed < 50; seed++) {
      const order = new PayloadGenerator(model, { seed }).valid("Order") as Record<string, Payload>;
      expect(order.id).toMatch(/^ord_[a-z0-9]{4,8}$/);
      expect(Number.isInteger(order.quantity) && Number(order.quantity) >= 1 && Number(order.quantity) <= 99).toBe(true);
      const tags = order.tags as string[];
      expect(new Set(tags.map((t) => canonical(t))).size).toBe(tags.length);
      for (const t of tags) expect([...t].length).toBeLessThanOrEqual(3);
      if (order.packSize !== undefined) expect(Number(order.packSize) % 6).toBe(0);
      if (order.placedAt !== undefined) expect(inFormat("date-time", String(order.placedAt))).toBe(true);
    }
  });

  it("labels an untagged union's error with the union's path when no variant takes the change", () => {
    const misses = new PayloadGenerator(model, { seed: 2 }).nearMisses("Contact", { name: "Ann", email: "a@b" });
    // Removing the email leaves an object neither variant takes, so the error is the union's.
    expect(misses).toContainEqual(expect.objectContaining({ path: "", code: "wrong_type", change: 'removed the required key "email"' }));
    // A phone beside the email is a key the email variant forbids, and the phone variant doesn't take the email.
    expect(misses.some((m) => m.code === "missing_key")).toBe(false);
    for (const miss of misses) {
      const failed = decode(fn, "Contact", miss.payload);
      expect(`${failed.error?.path ?? ""} ${failed.error?.code ?? ""}`).toBe(`${miss.path} ${miss.code}`);
    }
  });

  it("leaves out a near miss whose change another variant takes", () => {
    // Size is an integer from 1 or a string: a string in place of the integer is the other variant.
    const misses = new PayloadGenerator(model, { seed: 0 }).nearMisses("OrderSize", 5);
    expect(misses.map((m) => [m.path, m.code, m.payload])).toEqual([
      ["", "null_not_allowed", null],
      ["", "wrong_type", true],
      ["", "wrong_type", 1.5],
      ["", "too_small", 0],
    ]);
  });

  it("puts text with <, > and & where a pattern or a format doesn't take it", () => {
    const misses = new PayloadGenerator(model, { seed: 0 }).nearMisses("Order");
    const markup = misses.filter((m: NearMiss) => m.change.startsWith("text with <, > and &"));
    expect(markup.map((m) => `${m.path} ${m.code}`)).toContain("/id pattern_mismatch");
    expect(markup.every((m) => JSON.stringify(m.payload).includes("<>&"))).toBe(true);
  });
});

describe("payload generator in report mode", () => {
  const model = richModel();
  let fn: (name: string) => Fn;
  let strictFn: (name: string) => Fn;
  beforeAll(async () => {
    fn = await decoders(model, "report");
    strictFn = await decoders(model, "strict");
  }, COMPILE_TIMEOUT);

  it("labels near misses with the errors report mode gives, leaving out unknown keys it accepts", () => {
    const codes = checkAll(model, fn, { seeds: 15, read: "report" });
    expect(codes.has("missing_key")).toBe(true);
    const misses = new PayloadGenerator(model, { read: "report" }).nearMisses("Order");
    expect(misses.some((m) => m.path === "/unexpected")).toBe(false);
  }, RUN_TIMEOUT);

  it("still labels a key a sibling branch names as unknown_key", () => {
    const misses = new PayloadGenerator(model, { read: "report" }).nearMisses("ContactEmail", { name: "Ann", email: "a@b" });
    expect(misses).toContainEqual(expect.objectContaining({ path: "/phone", code: "unknown_key" }));
  });

  it("makes payloads that hold in every read mode it is given", () => {
    for (let seed = 0; seed < 15; seed++) {
      for (const decl of model.decls) {
        const g = new PayloadGenerator(model, { seed, read: ["strict", "report"] });
        const value = g.valid(decl.name);
        expect(decode(fn, decl.name, value).ok).toBe(true);
        expect(decode(strictFn, decl.name, value).ok).toBe(true);
        for (const miss of g.nearMisses(decl.name)) {
          for (const f of [fn, strictFn]) {
            const failed = decode(f, decl.name, miss.payload);
            expect(`${failed.error?.path ?? ""} ${failed.error?.code ?? ""}`).toBe(`${miss.path} ${miss.code}`);
          }
        }
      }
    }
  }, RUN_TIMEOUT);
});

describe("payload generator without validation", () => {
  const model = richModel(false);
  let fn: (name: string) => Fn;
  beforeAll(async () => {
    fn = await decoders(model);
  }, COMPILE_TIMEOUT);

  it("makes no constraint near misses, since decoders check none", () => {
    const codes = checkAll(model, fn, { seeds: 10 });
    for (const code of ["too_long", "too_short", "too_small", "too_large", "pattern_mismatch", "bad_format", "not_unique"]) {
      expect(codes.has(code)).toBe(false);
    }
  }, RUN_TIMEOUT);
});

describe("payload generator recursion", () => {
  const model = lib({
    tree: closed({ label: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/tree" } } }, ["label"]),
    list: closed({ value: { type: "integer" }, next: { $ref: "#/$defs/list" } }, ["value"]),
    forever: closed({ self: { $ref: "#/$defs/forever" } }, ["self"]),
  });

  function depthOf(value: Payload): number {
    if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
    if (typeof value === "object" && value !== null) return 1 + Math.max(0, ...Object.values(value).map(depthOf));
    return 0;
  }

  it("bounds how deep recursive types nest", () => {
    for (let seed = 0; seed < 50; seed++) {
      const g = new PayloadGenerator(model, { seed, depth: 2 });
      expect(depthOf(g.valid("Tree"))).toBeLessThanOrEqual(5);
      expect(depthOf(g.valid("List"))).toBeLessThanOrEqual(3);
    }
  });

  it("fails for a type every value of which holds another", () => {
    expect(() => new PayloadGenerator(model).valid("Forever")).toThrow(GenerateError);
    expect(() => new PayloadGenerator(model).valid("Forever")).toThrow("Forever has no value that ends");
  });
});

describe("payload generator fails closed", () => {
  it("fails for a pattern no string matches", () => {
    const model = lib({ never: { type: "string", pattern: "a^b" } });
    expect(() => new PayloadGenerator(model).valid("Never")).toThrow(
      "can't generate a payload for Never: no string found that matches a^b",
    );
  });

  it("fails for a pattern its strings can't match within the length limits", () => {
    const model = lib({ code: { type: "string", pattern: "^a{5}$", maxLength: 3 } });
    expect(() => new PayloadGenerator(model).valid("Code")).toThrow(
      "no string found that matches ^a{5}$ with at most 3 characters",
    );
  });

  it("fails for a format its strings can't keep within the length limits", () => {
    const model = lib({ day: { type: "string", format: "date", maxLength: 8 } });
    expect(() => new PayloadGenerator(model).valid("Day")).toThrow("no string found that is a date with at most 8 characters");
  });

  it("fails for more unique items than the item type has values", () => {
    const model = lib({ pair: { type: "array", items: { type: "boolean" }, minItems: 3, uniqueItems: true } });
    expect(() => new PayloadGenerator(model).valid("Pair")).toThrow("can't find 3 unique items");
  });

  it("misses a multipleOf next to the value and on both sides of zero, where the range takes them", () => {
    const model = lib({ step: { type: "integer", minimum: -50, maximum: 50, multipleOf: 5 } });
    const found = (base: number): number[] => new PayloadGenerator(model).nearMisses("Step", base).filter((m) => m.code === "not_multiple_of").map((m) => m.payload as number);
    expect(found(20)).toEqual([21, -1, 1, -4, -6]);
    // Only what the range takes: none below zero for a range that starts at 0.
    const positive = lib({ step: { type: "integer", minimum: 0, maximum: 50, multipleOf: 5 } });
    expect(new PayloadGenerator(positive).nearMisses("Step", 50).filter((m) => m.code === "not_multiple_of").map((m) => m.payload)).toEqual([49, 1]);
  });

  it("fails for an integer range with no multiple in it", () => {
    const model = lib({ odd: { type: "integer", minimum: 1, maximum: 5, multipleOf: 10 } });
    expect(() => new PayloadGenerator(model).valid("Odd")).toThrow("no multiple of 10 is within its bounds");
  });

  it("fails for an impossible optional key with every seed, not only the seeds that include it", () => {
    const model = lib({
      order: closed({ id: { type: "string" }, ref: { type: "string", format: "uuid", pattern: "^[a-z]{1,3}$" } }, ["id"]),
    });
    for (let seed = 0; seed < 20; seed++) {
      const g = new PayloadGenerator(model, { seed });
      expect(() => g.valid("Order")).toThrow("can't generate a payload for Order at /ref: no string found that is a uuid");
      // A second try fails the same way: a failed check isn't remembered as passed.
      expect(() => g.nearMisses("Order")).toThrow(GenerateError);
    }
  });

  it("names the path of the value it can't make", () => {
    const model = lib({ order: closed({ code: { type: "string", pattern: "a^b" } }, ["code"]) });
    expect(() => new PayloadGenerator(model).valid("Order")).toThrow("can't generate a payload for Order at /code:");
  });

  it("reaches a minimum length by repeating more, quickly also for patterns with nested repeats", () => {
    const model = lib({
      nested: { type: "string", pattern: "^(a+)+$", minLength: 40 },
      long: { type: "string", pattern: "^[a-z]+$", minLength: 500, maxLength: 600 },
      loose: { type: "string", pattern: "ab", minLength: 20 },
    });
    const started = Date.now();
    for (let seed = 0; seed < 20; seed++) {
      const g = new PayloadGenerator(model, { seed });
      expect(g.valid("Nested")).toMatch(/^a{40,}$/);
      expect([...String(g.valid("Long"))].length).toBeGreaterThanOrEqual(500);
      expect(g.valid("Loose")).toMatch(/ab/);
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("makes strings for patterns with classes, alternatives and repeats that match them", () => {
    const patterns = ["^[a-f0-9]{8}$", "^(?:red|green|blue)-\\d+$", "^\\S+@\\S+\\.[a-z]{2,3}$", "^.{2,4}$", "[^a-z]", "^\\u{1F600}+$"];
    const model = lib(Object.fromEntries(patterns.map((p, i) => [`p${String(i)}`, { type: "string", pattern: p }])));
    for (let seed = 0; seed < 30; seed++) {
      const g = new PayloadGenerator(model, { seed });
      patterns.forEach((p, i) => {
        expect(g.valid(`P${String(i)}`)).toMatch(new RegExp(p, "u"));
      });
    }
  });
});

describe("payload generator on the example projects", () => {
  for (const [name, read] of [
    ["basic", "strict"],
    ["report", "report"],
  ] as const) {
    describe(name, () => {
      const config = loadConfig(join("examples", name, "strictgen.json"));
      const model = buildModel(loadSchemas(config.schemas), {
        ...(config.ids === undefined ? {} : { ids: config.ids }),
        validation: config.validation,
      });
      let fn: (name: string) => Fn;
      beforeAll(async () => {
        fn = await decoders(model, read);
      }, COMPILE_TIMEOUT);

      it("makes payloads every type's decoder takes, and near misses it rejects with their label", () => {
        checkAll(model, fn, { seeds: 10, read });
      }, RUN_TIMEOUT);
    });
  }
});
