import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import type { EmittedFile } from "./common.js";
import { loadConfig } from "./config.js";
import type { TypeScriptOptions } from "./emit-ts.js";
import { emitTypeScript } from "./emit-ts.js";
import type { Model } from "./model.js";
import type { JsonObject } from "./schema.js";
import { loadSchemas, schemaSet } from "./schema.js";

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
function libModel(entries: JsonObject): Model {
  return build({ lib: schema("lib", { $defs: entries }) });
}

/** Every TypeScript file the emitter writes for a definitions-only schema named `lib`, joined. */
function lib(entries: JsonObject, options: TypeScriptOptions = {}): string {
  return emitTypeScript(libModel(entries), options)
    .map((f) => f.contents)
    .join("\n");
}

const closed = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  unevaluatedProperties: false,
});

/** The options generated code must compile under, as strict as a careful project sets them. */
const STRICT: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitReturns: true,
  noImplicitOverride: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  noEmit: true,
  types: [],
};

const folders: string[] = [];
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes `files` and `extra` sources to a new folder, typechecks them all under {@link STRICT},
 * failing with every diagnostic, then transpiles each to JavaScript next to it.
 */
function compile(files: readonly EmittedFile[], extra: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "strictgen-ts-"));
  folders.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  const sources = [...files.map((f) => [f.name, f.contents] as const), ...Object.entries(extra)];
  for (const [name, contents] of sources) writeFileSync(join(dir, name), contents);
  const program = ts.createProgram(
    sources.map(([name]) => join(dir, name)),
    STRICT,
  );
  const problems = ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file === undefined || d.start === undefined) return text;
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    return `${relative(dir, d.file.fileName)}:${String(line + 1)}: ${text}`;
  });
  if (problems.length > 0) throw new Error(`generated TypeScript fails to compile:\n${problems.join("\n")}`);
  for (const [name, contents] of sources) {
    const js = ts.transpileModule(contents, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    writeFileSync(join(dir, name.replace(/\.ts$/, ".js")), js);
  }
  return dir;
}

type Fn = (...args: unknown[]) => unknown;

/** The generated module, through `index.ts`, with typed access to its functions. */
interface Loaded {
  readonly fn: (name: string) => Fn;
  readonly DecodeError: new (...args: never[]) => Error;
  readonly EncodeError: new (...args: never[]) => Error;
}

async function load(
  model: Model,
  options: TypeScriptOptions = {},
  extra: Readonly<Record<string, string>> = {},
): Promise<Loaded> {
  const dir = compile(emitTypeScript(model, options), extra);
  const module = (await import(pathToFileURL(join(dir, "index.js")).href)) as Record<
    string,
    unknown
  >;
  const value = (name: string): unknown => {
    if (!(name in module)) throw new Error(`index.ts exports no ${name}`);
    return module[name];
  };
  return {
    fn: (name) => value(name) as Fn,
    DecodeError: value("DecodeError") as Loaded["DecodeError"],
    EncodeError: value("EncodeError") as Loaded["EncodeError"],
  };
}

/** The message of the DecodeError that decoding `json` as `type` throws. */
function failure(m: Loaded, type: string, json: unknown, path?: string): string {
  try {
    m.fn(`decode${type}`)(json, ...(path === undefined ? [] : [path]));
  } catch (error) {
    if (!(error instanceof m.DecodeError)) throw error;
    return error.message;
  }
  throw new Error(`decode${type} accepted ${JSON.stringify(json)}`);
}

/** Decodes the JSON text as `type`, encodes it again, and returns the JSON text of that. */
function roundTrip(m: Loaded, type: string, text: string): string {
  return JSON.stringify(m.fn(`encode${type}`)(m.fn(`decode${type}`)(JSON.parse(text))));
}

describe("TypeScript files", () => {
  const model = libModel({ order: closed({ id: { type: "string" } }, ["id"]) });

  it("write helpers.ts beside the types, with no package to import", () => {
    const files = emitTypeScript(model);
    expect(files.map((f) => f.name)).toEqual(["lib.ts", "helpers.ts", "index.ts"]);
    const helpers = files[1]?.contents ?? "";
    expect(helpers).not.toMatch(/^import /m);
    expect(helpers).toContain("export class DecodeError extends Error {");
    expect(helpers).toContain("  readonly path: string;\n");
    expect(helpers).toContain("  readonly reason: string;\n");
  });

  it("give every type decodeX, tryDecodeX and encodeX", () => {
    const out = lib({ order: closed({ id: { type: "string" } }, ["id"]) });
    expect(out).toContain('export function decodeOrder(json: unknown, path = ""): Order {\n');
    expect(out).toContain("export function tryDecodeOrder(json: unknown): h.DecodeResult<Order> {\n");
    expect(out).toContain("export function encodeOrder(value: Order): unknown {\n");
  });

  it("write only types when decoders are off", () => {
    const files = emitTypeScript(model, { decoders: false });
    expect(files.map((f) => f.name)).toEqual(["lib.ts", "index.ts"]);
    expect(files[0]?.contents).not.toContain("function");
    expect(files[0]?.contents).not.toContain("helpers");
  });

  it("compile under strict and exactOptionalPropertyTypes, both with and without decoders", () => {
    expect(() => compile(emitTypeScript(model))).not.toThrow();
    expect(() => compile(emitTypeScript(model, { decoders: false }))).not.toThrow();
  });

  it("return the error from tryDecodeX instead of throwing it", async () => {
    const m = await load(model);
    expect(m.fn("tryDecodeOrder")({ id: "o1" })).toEqual({ ok: true, value: { id: "o1" } });
    const result = m.fn("tryDecodeOrder")({ id: 1 }) as { ok: boolean; error: Error };
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(m.DecodeError);
    expect(result.error).toMatchObject({
      path: "/id",
      reason: "expected a string, found a number",
      message: "/id: expected a string, found a number",
    });
  });

  it("start error paths under the path given", async () => {
    const m = await load(model);
    expect(failure(m, "Order", { id: null }, "/orders/3")).toBe(
      "/orders/3/id: expected a string, found null",
    );
  });
});

describe("TypeScript closed objects", () => {
  const model = libModel({
    order: closed(
      {
        id: { type: "string" },
        quantity: { type: "integer" },
        note: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        shipping: { $ref: "#/$defs/address" },
        "a/b~c": { type: "boolean" },
      },
      ["id", "quantity"],
    ),
    address: closed({ city: { type: "string" }, "post-code": { type: "string" } }, ["city"]),
    empty: { type: "object", unevaluatedProperties: false },
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("decode every key in schema order, then reject the keys left over", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      "  const o = h.object(json, path);\n  const value: Order = {\n" +
        '    id: h.required(o, "id", path, h.decodeString),\n' +
        '    quantity: h.required(o, "quantity", path, h.decodeInteger),\n' +
        '    ...h.optional(o, "note", path, h.decodeString),\n' +
        '    ...h.optional(o, "tags", path, h.array(h.decodeString)),\n' +
        '    ...h.optional(o, "shipping", path, decodeAddress),\n' +
        '    ...h.optional(o, "a/b~c", path, h.decodeBoolean),\n' +
        "  };\n" +
        '  h.closed(o, path, ["id", "quantity", "note", "tags", "shipping", "a/b~c"]);\n' +
        "  return value;\n",
    );
  });

  it("accept a valid object and leave absent optional keys out", () => {
    const value = m.fn("decodeOrder")({ id: "o1", quantity: 2 });
    expect(value).toEqual({ id: "o1", quantity: 2 });
    expect(Object.keys(value as object)).toEqual(["id", "quantity"]);
  });

  it("fail on an unknown key, naming it", () => {
    expect(failure(m, "Order", { id: "o1", quantity: 2, coupon: "x" })).toBe('unknown key "coupon"');
    expect(failure(m, "Order", { id: "o1", quantity: 2, shipping: { city: "c", zip: "1" } })).toBe(
      '/shipping: unknown key "zip"',
    );
    expect(failure(m, "Empty", { a: 1 })).toBe('unknown key "a"');
  });

  it("fail on a missing required key", () => {
    expect(failure(m, "Order", { id: "o1" })).toBe('missing key "quantity"');
    expect(failure(m, "Order", { id: "o1", quantity: 1, shipping: {} })).toBe(
      '/shipping: missing key "city"',
    );
  });

  it("fail on null for an optional key, which only absence leaves out", () => {
    expect(failure(m, "Order", { id: "o1", quantity: 1, note: null })).toBe(
      "/note: expected a string, found null",
    );
    expect(failure(m, "Order", { id: "o1", quantity: 1, note: undefined })).toBe(
      "/note: expected a string, found a value that is not JSON",
    );
  });

  it("report the first problem in schema order, as Go does", () => {
    expect(failure(m, "Order", { coupon: 1, quantity: "x" })).toBe('missing key "id"');
    expect(failure(m, "Order", { coupon: 1, id: "o1", quantity: "x" })).toBe(
      "/quantity: expected a number, found a string",
    );
  });

  it("name the JSON Pointer of nested values, escaping ~ and /", () => {
    expect(failure(m, "Order", { id: "o1", quantity: 1, tags: ["a", 2] })).toBe(
      "/tags/1: expected a string, found a number",
    );
    expect(failure(m, "Order", { id: "o1", quantity: 1, "a/b~c": "yes" })).toBe(
      "/a~1b~0c: expected a boolean, found a string",
    );
    expect(
      failure(m, "Order", { id: "o1", quantity: 1, shipping: { city: "c", "post-code": 1 } }),
    ).toBe("/shipping/post-code: expected a string, found a number");
  });

  it("accept only plain objects", () => {
    expect(failure(m, "Order", [])).toBe("expected an object, found an array");
    expect(failure(m, "Order", null)).toBe("expected an object, found null");
    expect(failure(m, "Order", "o1")).toBe("expected an object, found a string");
    expect(failure(m, "Order", new Date(0))).toBe(
      "expected an object, found an object that is not plain JSON",
    );
    expect(m.fn("decodeEmpty")(Object.create(null))).toEqual({});
    expect(m.fn("decodeEmpty")({})).toEqual({});
  });

  it("encode keys in schema order, leaving absent optional keys out", () => {
    expect(
      roundTrip(m, "Order", '{"shipping":{"post-code":"1","city":"c"},"quantity":2,"id":"o1"}'),
    ).toBe('{"id":"o1","quantity":2,"shipping":{"city":"c","post-code":"1"}}');
    expect(roundTrip(m, "Empty", "{}")).toBe("{}");
  });
});

describe("TypeScript prototype keys", () => {
  // Built from JSON text: a "__proto__" key in an object literal would set its prototype.
  const odd = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},' +
      '"toString":{"type":"boolean"}},"required":["__proto__"],"unevaluatedProperties":false}',
  ) as JsonObject;
  const tally = {
    type: "object",
    properties: { total: { type: "integer" } },
    additionalProperties: { type: "integer" },
    required: ["total"],
  };
  const model = libModel({ odd, tally, plain: closed({ id: { type: "string" } }, ["id"]) });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("read __proto__ and constructor as data keys, never as object internals", () => {
    const text = '{"__proto__":"p","constructor":"c","toString":true}';
    const value = m.fn("decodeOdd")(JSON.parse(text)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe("p");
    expect(roundTrip(m, "Odd", text)).toBe(text);
  });

  it("don't take inherited properties for present keys", () => {
    expect(failure(m, "Odd", {})).toBe('missing key "__proto__"');
    const value = m.fn("decodeOdd")(JSON.parse('{"__proto__":"p"}')) as object;
    expect(Object.hasOwn(value, "constructor")).toBe(false);
    expect(Object.hasOwn(value, "toString")).toBe(false);
  });

  it("reject __proto__ as an unknown key like any other", () => {
    expect(failure(m, "Plain", JSON.parse('{"id":"x","__proto__":{"polluted":true}}'))).toBe(
      'unknown key "__proto__"',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keep __proto__ in a map of other keys as a data key", () => {
    const text = '{"total":1,"__proto__":2,"constructor":3}';
    const value = m.fn("decodeTally")(JSON.parse(text)) as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["total", "__proto__", "constructor"]);
    expect(roundTrip(m, "Tally", text)).toBe('{"total":1,"__proto__":2,"constructor":3}');
  });
});

describe("TypeScript exactly-one choices and named keys beside a map", () => {
  const model = libModel({
    currency: { enum: ["usd", "eur", "gbp"] },
    prices: {
      type: "object",
      propertyNames: { anyOf: [{ const: "default" }, { $ref: "#/$defs/currency" }] },
      properties: { default: { type: "integer" }, note: { type: "string" } },
      additionalProperties: { type: "integer" },
      required: ["default"],
    },
    labels: {
      type: "object",
      properties: { main: { type: "string" } },
      additionalProperties: { type: "string" },
    },
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("decode the named keys first, then every other key into the map", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      '    ...h.rest(o, path, ["default", "note"], decodeCurrency, h.decodeInteger),\n  };\n  return value;\n',
    );
    expect(m.fn("decodePrices")({ eur: 2, default: 1, usd: 3 })).toEqual({
      default: 1,
      eur: 2,
      usd: 3,
    });
    expect(failure(m, "Prices", { eur: 2 })).toBe('missing key "default"');
    expect(failure(m, "Prices", { default: 1, note: 5, eur: "x" })).toBe(
      "/note: expected a string, found a number",
    );
  });

  it("check the key type and the value type of the other keys", () => {
    expect(failure(m, "Prices", { default: 1, yen: 2 })).toBe(
      'key "yen": unknown value "yen", expected one of "usd", "eur", "gbp"',
    );
    expect(failure(m, "Prices", { default: 1, eur: "2" })).toBe(
      "/eur: expected a number, found a string",
    );
    expect(m.fn("decodeLabels")({ x: "1", main: "m" })).toEqual({ main: "m", x: "1" });
  });

  it("encode the named keys, then the other keys sorted by code point", () => {
    expect(roundTrip(m, "Prices", '{"usd":3,"eur":2,"note":"n","default":1}')).toBe(
      '{"default":1,"note":"n","eur":2,"usd":3}',
    );
    // UTF-16 order would put U+FF5E before U+1F600; code point order, like UTF-8 bytes, doesn't.
    expect(roundTrip(m, "Labels", '{"\u{1F600}":"a","～":"b","main":"m"}')).toBe(
      '{"main":"m","～":"b","\u{1F600}":"a"}',
    );
  });
});

describe("TypeScript scalars, ids, aliases and consts", () => {
  const model = build({
    common: schema("common", {
      $defs: {
        orderId: { type: "string" },
        userId: { type: "string" },
        stamp: { type: "string", format: "date-time" },
        status: { enum: ["open", "closed"] },
        kind: { const: "refund" },
        version: { const: 1 },
        below: { const: -2 },
        flag: { const: true },
        count: { type: "integer" },
        ratio: { type: "number" },
        names: { type: "array", items: { type: "string" } },
        grid: { type: "array", items: { type: "array", items: { type: "boolean" } } },
        line: closed(
          {
            order: { $ref: "#/$defs/orderId" },
            status: { $ref: "#/$defs/status" },
            version: { $ref: "#/$defs/version" },
            at: { $ref: "#/$defs/stamp" },
            orders: { type: "array", items: { $ref: "#/$defs/orderId" } },
          },
          ["order", "status", "version"],
        ),
      },
    }),
  });
  const ids = [
    'import { asOrderId, asUserId, decodeOrderId, type OrderId, type UserId } from "./index.js";',
    'export const order: OrderId = asOrderId("ord_1");',
    'export const decoded: OrderId = decodeOrderId("ord_2");',
    "// @ts-expect-error a UserId is not an OrderId",
    'export const mixed: OrderId = asUserId("usr_1");',
    "// @ts-expect-error a plain string is not an OrderId",
    'export const plain: OrderId = "ord_3";',
    "export const asText: string = order;",
    "// @ts-expect-error an OrderId is not a UserId",
    "export const back: UserId = order;",
    "",
  ].join("\n");
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model, {}, { "ids.ts": ids });
  });

  it("decode strings and booleans strictly", () => {
    expect(m.fn("decodeStamp")("2030-01-01T00:00:00Z")).toBe("2030-01-01T00:00:00Z");
    expect(failure(m, "Stamp", 1)).toBe("expected a string, found a number");
    expect(failure(m, "Grid", [[true], ["true"]])).toBe("/1/0: expected a boolean, found a string");
    expect(m.fn("decodeGrid")([[true, false], []])).toEqual([[true, false], []]);
  });

  it("decode arrays strictly, naming the index", () => {
    expect(m.fn("decodeNames")(["a", "b"])).toEqual(["a", "b"]);
    expect(failure(m, "Names", ["a", null])).toBe("/1: expected a string, found null");
    expect(failure(m, "Names", { 0: "a" })).toBe("expected an array, found an object");
    expect(failure(m, "Names", "a")).toBe("expected an array, found a string");
  });

  it("accept only the listed values of an enum or a string const, naming them", () => {
    expect(m.fn("decodeStatus")("open")).toBe("open");
    expect(failure(m, "Status", "Open")).toBe('unknown value "Open", expected one of "open", "closed"');
    expect(failure(m, "Status", 1)).toBe("expected a string, found a number");
    expect(m.fn("decodeKind")("refund")).toBe("refund");
    expect(failure(m, "Kind", "sale")).toBe('unknown value "sale", expected one of "refund"');
  });

  it("accept only the value of an integer or boolean const", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain("export type Version = 1;\n");
    expect(m.fn("decodeVersion")(1)).toBe(1);
    expect(failure(m, "Version", 2)).toBe("expected 1, found 2");
    expect(failure(m, "Version", 1.5)).toBe("expected an integer, found 1.5");
    expect(failure(m, "Version", "1")).toBe("expected a number, found a string");
    expect(m.fn("decodeBelow")(-2)).toBe(-2);
    expect(failure(m, "Below", 2)).toBe("expected -2, found 2");
    expect(m.fn("decodeFlag")(true)).toBe(true);
    expect(failure(m, "Flag", false)).toBe("expected true, found false");
    expect(failure(m, "Flag", 1)).toBe("expected a boolean, found a number");
    expect(failure(m, "Line", { order: "o", status: "open", version: 2 })).toBe(
      "/version: expected 1, found 2",
    );
  });

  it("decode integers only when whole and within Number.MAX_SAFE_INTEGER, and never -0", () => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const ok of [0, 1, -1, max, -max]) expect(m.fn("decodeCount")(ok)).toBe(ok);
    expect(failure(m, "Count", 1.5)).toBe("expected an integer, found 1.5");
    expect(failure(m, "Count", -0)).toBe("expected an integer, found -0");
    expect(failure(m, "Count", JSON.parse("-0.0"))).toBe("expected an integer, found -0");
    const range = "expected an integer from -9007199254740991 to 9007199254740991, found";
    expect(failure(m, "Count", max + 1)).toBe(`${range} 9007199254740992`);
    expect(failure(m, "Count", -max - 1)).toBe(`${range} -9007199254740992`);
    // JSON.parse rounds 9007199254740993 to 2^53, which fails instead of decoding as 2^53.
    expect(failure(m, "Count", JSON.parse("9007199254740993"))).toBe(`${range} 9007199254740992`);
    expect(failure(m, "Count", 1e21)).toBe(`${range} 1e+21`);
    expect(failure(m, "Count", Number.NaN)).toBe("expected a number, found a number that is not finite");
    expect(failure(m, "Count", "1")).toBe("expected a number, found a string");
    expect(failure(m, "Count", 1n)).toBe("expected a number, found a value that is not JSON");
  });

  it("decode any finite number, which re-encodes as JavaScript spells it", () => {
    for (const ok of [0, -0, 1.5, -2e-7, 1e300, Number.MAX_VALUE]) {
      expect(m.fn("decodeRatio")(ok)).toBe(ok);
    }
    expect(failure(m, "Ratio", Number.POSITIVE_INFINITY)).toBe(
      "expected a number, found a number that is not finite",
    );
    expect(failure(m, "Ratio", JSON.parse("1e400"))).toBe(
      "expected a number, found a number that is not finite",
    );
    expect(failure(m, "Ratio", Number.NaN)).toBe("expected a number, found a number that is not finite");
    expect(roundTrip(m, "Ratio", "12.0")).toBe("12");
    expect(roundTrip(m, "Ratio", "-0")).toBe("0");
  });

  it("document the number limits in the generated helpers", () => {
    const helpers = emitTypeScript(model).find((f) => f.name === "helpers.ts")?.contents ?? "";
    expect(helpers).toContain("12.0 and 1e2 decode as the integers 12 and 100");
    expect(helpers).toContain("a number re-encodes as JavaScript spells it");
  });

  it("brand ids, so ids of different kinds don't mix at compile time", () => {
    const out = emitTypeScript(model)[0]?.contents ?? "";
    expect(out).toContain('export type OrderId = string & { readonly __brand: "OrderId" };\n');
    expect(out).toContain(
      "export function asOrderId(value: string): OrderId {\n  return value as OrderId;\n}\n",
    );
    // ids.ts compiled with load: each @ts-expect-error line must fail to compile.
    expect(m.fn("decodeOrderId")("ord_1")).toBe("ord_1");
    expect(m.fn("asOrderId")("ord_1")).toBe("ord_1");
    expect(failure(m, "OrderId", 1)).toBe("expected a string, found a number");
  });

  it("fail when an id type mixes, which the @ts-expect-error checks rely on", () => {
    const loose = ids.replaceAll("// @ts-expect-error", "//");
    expect(() => compile(emitTypeScript(model), { "ids.ts": loose })).toThrow(
      "Type 'UserId' is not assignable to type 'OrderId'",
    );
  });

  it("decode aliases as their target, and fields through their types' decoders", () => {
    const value = { order: "o1", status: "closed", version: 1, at: "t", orders: ["a", "b"] };
    expect(m.fn("decodeLine")(value)).toEqual(value);
    expect(failure(m, "Line", { ...value, orders: ["a", 1] })).toBe(
      "/orders/1: expected a string, found a number",
    );
    expect(failure(m, "Line", { ...value, status: "gone" })).toBe(
      '/status: unknown value "gone", expected one of "open", "closed"',
    );
    expect(roundTrip(m, "Line", JSON.stringify(value))).toBe(JSON.stringify(value));
  });
});

/** The message of the EncodeError that encoding `value` as `type` throws. */
function refusal(m: Loaded, type: string, value: unknown): string {
  try {
    m.fn(`encode${type}`)(value);
  } catch (error) {
    if (!(error instanceof m.EncodeError)) throw error;
    return error.message;
  }
  throw new Error(`encode${type} accepted ${String(value)}`);
}

const paymentDefs: JsonObject = {
  cardPayment: closed(
    { type: { const: "card" }, installments: { type: "integer" } },
    ["type", "installments"],
  ),
  wirePayment: closed({ type: { const: "wire" }, iban: { type: "string" } }, ["type"]),
};

describe("TypeScript tagged unions", () => {
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
        // A union whose second branch is itself a union: its branches are spread into this one.
        transfer: {
          oneOf: [{ $ref: "#/$defs/cashTransfer" }, { $ref: "#" }],
        },
        cashTransfer: closed({ type: { const: "cash" } }, ["type"]),
      },
    }),
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("read the tag first and decode only the branch it names", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      '  return h.tagged<Payment>(json, path, "type", [\n' +
        '    ["card", decodeCardPayment],\n    ["wire", decodeWirePayment],\n  ]);\n',
    );
    expect(m.fn("decodePayment")({ type: "wire" })).toEqual({ type: "wire" });
    expect(m.fn("decodePayment")({ installments: 3, type: "card" })).toEqual({
      type: "card",
      installments: 3,
    });
  });

  it("fail on a missing tag, a tag that is not a string and an unknown tag, naming the tags", () => {
    expect(failure(m, "Payment", { iban: "x" })).toBe('missing key "type"');
    expect(failure(m, "Payment", { type: 1 })).toBe('"type" must be a string, found a number');
    expect(failure(m, "Payment", { type: null })).toBe('"type" must be a string, found null');
    expect(failure(m, "Payment", { type: "cash" })).toBe(
      'unknown type "cash", expected one of card, wire',
    );
    expect(failure(m, "Payment", [])).toBe("expected an object, found an array");
  });

  it("name the branch in errors inside it, keeping the path", () => {
    expect(failure(m, "Payment", { type: "card" })).toBe('type "card": missing key "installments"');
    expect(failure(m, "Payment", { type: "wire", installments: 1 })).toBe(
      'type "wire": unknown key "installments"',
    );
    expect(failure(m, "Checkout", { root: { type: "card", installments: "2" } })).toBe(
      '/root/installments: type "card": expected a number, found a string',
    );
    expect(failure(m, "Checkout", { root: { type: "wire" }, payments: [{ type: "x" }] })).toBe(
      '/payments/0: unknown type "x", expected one of card, wire',
    );
  });

  it("decode nested tagged unions spread into one, as Rust and Go do", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      "export type Transfer = CashTransfer | CardPayment | WirePayment;\n",
    );
    expect(m.fn("decodeTransfer")({ type: "cash" })).toEqual({ type: "cash" });
    expect(m.fn("decodeTransfer")({ type: "wire" })).toEqual({ type: "wire" });
    expect(failure(m, "Transfer", { type: "gift" })).toBe(
      'unknown type "gift", expected one of card, cash, wire',
    );
  });

  it("encode the branch the tag names, refusing a tag no branch has", () => {
    expect(roundTrip(m, "Payment", '{"installments":2,"type":"card"}')).toBe(
      '{"type":"card","installments":2}',
    );
    expect(roundTrip(m, "Checkout", '{"payments":[{"type":"wire"}],"root":{"type":"wire"}}')).toBe(
      '{"root":{"type":"wire"},"payments":[{"type":"wire"}]}',
    );
    expect(refusal(m, "Payment", { type: "cash" })).toBe(
      'unknown type "cash", expected one of card, wire',
    );
    expect(refusal(m, "Payment", {})).toBe('missing key "type"');
    expect(refusal(m, "Payment", { type: "card", installments: 1.5 })).toBe(
      '/installments: type "card": expected an integer, found 1.5',
    );
    expect(refusal(m, "Checkout", {})).toBe("/root: expected an object, found a value that is not JSON");
  });
});

describe("TypeScript untagged unions", () => {
  const model = libModel({
    accountRef: closed({ $account: { type: "string" } }, ["$account"]),
    currencyCode: { type: "string" },
    currencyAmounts: {
      type: "object",
      propertyNames: { $ref: "#/$defs/currencyCode" },
      additionalProperties: { type: "string" },
    },
    amountsOrRef: { oneOf: [{ $ref: "#/$defs/currencyAmounts" }, { $ref: "#/$defs/accountRef" }] },
    loose: { oneOf: [{ type: "string" }, {}] },
    scalar: {
      oneOf: [
        { type: "boolean" },
        { type: "number" },
        { type: "integer" },
        { type: "string" },
        { enum: ["auto"] },
        { type: "array", items: { type: "integer" } },
      ],
    },
    contact: {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
      required: ["name"],
      oneOf: [{ required: ["email"] }, { required: ["phone"] }],
      unevaluatedProperties: false,
    },
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("try the variants in the model's order, the same as Rust and Go", () => {
    const out = emitTypeScript(model)[0]?.contents ?? "";
    // Objects with required keys first, then maps, as in Go's decodeUntagged list.
    expect(out).toContain(
      '  return h.untagged<AmountsOrRef>(json, path, "AmountsOrRef", [\n' +
        "    decodeAccountRef,\n    decodeCurrencyAmounts,\n  ]);\n",
    );
    // Arrays, enums, strings, integers, numbers, booleans.
    expect(out).toContain(
      "export type Scalar = number[] | ScalarVariant5 | string | number | number | boolean;\n",
    );
    expect(out).toContain('h.untagged<Loose>(json, path, "Loose", [h.decodeString, h.decodeAny]);\n');
  });

  it("pick the first variant that matches when two do, as Rust and Go", () => {
    // A map of strings would take {"$account": "a"} too; the account reference comes first.
    const ref = m.fn("decodeAmountsOrRef")({ $account: "a" });
    expect(ref).toEqual({ $account: "a" });
    expect(m.fn("decodeAmountsOrRef")({ usd: "1" })).toEqual({ usd: "1" });
    // "auto" is a string too; the enum comes first. 2 is a number too; the integer comes first.
    expect(m.fn("decodeScalar")("auto")).toBe("auto");
    expect(m.fn("decodeScalar")(2)).toBe(2);
    expect(m.fn("decodeScalar")(2.5)).toBe(2.5);
    expect(m.fn("decodeScalar")([1])).toEqual([1]);
    expect(m.fn("decodeLoose")(null)).toBe(null);
  });

  it("fail with the union's name when no variant matches, at its path", () => {
    expect(failure(m, "AmountsOrRef", { usd: 1 })).toBe("data did not match any variant of AmountsOrRef");
    expect(failure(m, "Scalar", null)).toBe("data did not match any variant of Scalar");
    expect(failure(m, "Scalar", [1.5], "/x")).toBe("/x: data did not match any variant of Scalar");
  });

  it("map an exactly-one oneOf of required keys to one struct per choice, as Rust and Go", () => {
    const out = emitTypeScript(model)[0]?.contents ?? "";
    expect(out).toContain("export type Contact = ContactEmail | ContactPhone;\n");
    expect(out).toContain("  phone?: never;\n");
    expect(m.fn("decodeContact")({ name: "n", email: "e" })).toEqual({ name: "n", email: "e" });
    expect(m.fn("decodeContact")({ name: "n", phone: "p" })).toEqual({ name: "n", phone: "p" });
    expect(failure(m, "Contact", { name: "n", email: "e", phone: "p" })).toBe(
      "data did not match any variant of Contact",
    );
    expect(failure(m, "Contact", { name: "n" })).toBe("data did not match any variant of Contact");
  });

  it("encode with the first variant in decode order that takes the value", () => {
    expect(roundTrip(m, "AmountsOrRef", '{"$account":"a"}')).toBe('{"$account":"a"}');
    expect(roundTrip(m, "AmountsOrRef", '{"usd":"1","eur":"2"}')).toBe('{"eur":"2","usd":"1"}');
    expect(roundTrip(m, "Contact", '{"phone":"p","name":"n"}')).toBe('{"name":"n","phone":"p"}');
    expect(roundTrip(m, "Scalar", "2.5")).toBe("2.5");
    expect(roundTrip(m, "Loose", '{"a":[null]}')).toBe('{"a":[null]}');
  });

  it("refuse a value no variant takes, where Go refuses zero or several variants set", () => {
    expect(refusal(m, "AmountsOrRef", { usd: 1 })).toBe("value did not match any variant of AmountsOrRef");
    expect(refusal(m, "Contact", { name: "n", email: "e", phone: "p" })).toBe(
      "value did not match any variant of Contact",
    );
    expect(refusal(m, "Scalar", Number.NaN)).toBe("value did not match any variant of Scalar");
    expect(refusal(m, "Loose", undefined)).toBe("value did not match any variant of Loose");
  });
});

describe("TypeScript maps", () => {
  const model = libModel({
    currency: { enum: ["usd", "eur"] },
    byCurrency: {
      type: "object",
      propertyNames: { $ref: "#/$defs/currency" },
      additionalProperties: { type: "integer" },
    },
    labels: { type: "object", additionalProperties: { type: "array", items: { type: "string" } } },
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("type an enum-keyed map as a partial record", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      "export type ByCurrency = Partial<Record<Currency, number>>;\n",
    );
  });

  it("check the key type, enum keys included, and the value type", () => {
    expect(m.fn("decodeByCurrency")({ eur: 1 })).toEqual({ eur: 1 });
    expect(failure(m, "ByCurrency", { yen: 1 })).toBe(
      'key "yen": unknown value "yen", expected one of "usd", "eur"',
    );
    expect(failure(m, "ByCurrency", { usd: 1.5 })).toBe("/usd: expected an integer, found 1.5");
    expect(failure(m, "Labels", { a: ["x", 1] })).toBe("/a/1: expected a string, found a number");
    expect(failure(m, "Labels", [])).toBe("expected an object, found an array");
  });

  it("encode keys sorted by code point, refusing a key or value the types don't allow", () => {
    expect(roundTrip(m, "ByCurrency", '{"usd":2,"eur":1}')).toBe('{"eur":1,"usd":2}');
    expect(refusal(m, "ByCurrency", { yen: 1 })).toBe(
      'key "yen": unknown value "yen", expected one of "usd", "eur"',
    );
    expect(refusal(m, "ByCurrency", { usd: 2 ** 53 })).toBe(
      "/usd: expected an integer from -9007199254740991 to 9007199254740991, found 9007199254740992",
    );
    expect(refusal(m, "ByCurrency", { usd: undefined })).toBe(
      "/usd: expected a number, found a value that is not JSON",
    );
    expect(refusal(m, "Labels", { a: ["x", 1] })).toBe("/a/1: expected a string, found a number");
    expect(refusal(m, "Labels", [])).toBe("expected an object, found an array");
  });
});

describe("TypeScript any values, non-null values and recursion", () => {
  const model = libModel({
    holder: closed({ any: {}, nonNull: { not: { const: null } }, list: { type: "array", items: {} } }),
    tree: closed(
      {
        name: { type: "string" },
        children: { type: "array", items: { $ref: "#/$defs/tree" } },
        next: { $ref: "#/$defs/tree" },
      },
      ["name"],
    ),
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("decode {} as any JSON value, null included, and keep it as it is", () => {
    for (const any of [null, 1, "x", true, [], { a: [null, { b: 2 }] }]) {
      expect(m.fn("decodeHolder")({ any })).toEqual({ any });
    }
    expect(failure(m, "Holder", { any: { a: [1, undefined] } })).toBe(
      "/any/a/1: expected a JSON value, found a value that is not JSON",
    );
    expect(failure(m, "Holder", { list: [Number.NaN] })).toBe(
      "/list/0: expected a JSON value, found a number that is not finite",
    );
    expect(failure(m, "Holder", { any: new Map() })).toBe(
      "/any: expected a JSON value, found an object that is not plain JSON",
    );
  });

  it("decode a non-null value as any JSON value but null", () => {
    expect(m.fn("decodeHolder")({ nonNull: { a: null } })).toEqual({ nonNull: { a: null } });
    expect(failure(m, "Holder", { nonNull: null })).toBe("/nonNull: expected a JSON value other than null");
  });

  it("decode deep any values without running out of stack", () => {
    const deep = JSON.parse("[".repeat(20000) + "]".repeat(20000)) as unknown;
    expect(m.fn("decodeHolder")({ any: deep })).toEqual({ any: deep });
  });

  it("encode any and non-null values, refusing what JSON can't hold", () => {
    expect(roundTrip(m, "Holder", '{"any":null,"nonNull":[1],"list":[{},null]}')).toBe(
      '{"any":null,"nonNull":[1],"list":[{},null]}',
    );
    expect(refusal(m, "Holder", { nonNull: null })).toBe("/nonNull: expected a JSON value other than null");
    expect(refusal(m, "Holder", { any: { a: Number.POSITIVE_INFINITY } })).toBe(
      "/any/a: expected a JSON value, found a number that is not finite",
    );
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(refusal(m, "Holder", { any: cycle })).toBe("/any/0: expected a JSON value, found a value that holds itself");
  });

  it("decode and encode recursive types as deep as the input", () => {
    const text = '{"name":"a","children":[{"name":"b","next":{"name":"c"}}]}';
    expect(roundTrip(m, "Tree", text)).toBe(text);
    expect(failure(m, "Tree", { name: "a", children: [{ name: "b", next: { name: 1 } }] })).toBe(
      "/children/0/next/name: expected a string, found a number",
    );
  });
});

describe("TypeScript encoding checks", () => {
  const model = libModel({
    status: { enum: ["open", "closed"] },
    version: { const: 1 },
    order: closed(
      {
        id: { type: "string" },
        count: { type: "integer" },
        ratio: { type: "number" },
        status: { $ref: "#/$defs/status" },
        version: { $ref: "#/$defs/version" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: "string" },
      },
      ["id", "count", "tags"],
    ),
    prices: {
      type: "object",
      properties: { default: { type: "integer" } },
      additionalProperties: { type: "integer" },
      required: ["default"],
    },
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });
  const order = { id: "o1", count: 1, tags: [] };

  it("refuse integers JSON.stringify would change or Rust and Go can't hold", () => {
    const range = "expected an integer from -9007199254740991 to 9007199254740991, found";
    expect(refusal(m, "Order", { ...order, count: 1.5 })).toBe("/count: expected an integer, found 1.5");
    expect(refusal(m, "Order", { ...order, count: -0 })).toBe("/count: expected an integer, found -0");
    expect(refusal(m, "Order", { ...order, count: 2 ** 53 })).toBe(`/count: ${range} 9007199254740992`);
    expect(refusal(m, "Order", { ...order, count: Number.NaN })).toBe(
      "/count: expected a number, found a number that is not finite",
    );
    expect(refusal(m, "Order", { ...order, count: Number.NEGATIVE_INFINITY })).toBe(
      "/count: expected a number, found a number that is not finite",
    );
  });

  it("refuse numbers that are not finite, which JSON.stringify writes as null", () => {
    expect(refusal(m, "Order", { ...order, ratio: Number.NaN })).toBe(
      "/ratio: expected a number, found a number that is not finite",
    );
    expect(JSON.stringify(m.fn("encodeOrder")({ ...order, ratio: -0 }))).toContain('"ratio":0');
  });

  it("refuse an enum value or a const the type doesn't list", () => {
    expect(refusal(m, "Status", "gone")).toBe('unknown value "gone", expected one of "open", "closed"');
    expect(refusal(m, "Order", { ...order, status: "Open" })).toBe(
      '/status: unknown value "Open", expected one of "open", "closed"',
    );
    expect(refusal(m, "Version", 2)).toBe("expected 1, found 2");
  });

  it("refuse a missing required key and a value of the wrong type", () => {
    expect(refusal(m, "Order", { id: "o1", count: 1 })).toBe(
      "/tags: expected an array, found a value that is not JSON",
    );
    expect(refusal(m, "Order", { ...order, id: null })).toBe("/id: expected a string, found null");
    expect(refusal(m, "Order", { ...order, note: null })).toBe("/note: expected a string, found null");
    expect(refusal(m, "Order", { ...order, tags: ["a", 1] })).toBe("/tags/1: expected a string, found a number");
    expect(refusal(m, "Order", null)).toBe("expected an object, found null");
  });

  it("refuse a key the type doesn't name, which would be dropped", () => {
    expect(refusal(m, "Order", { ...order, coupon: "x" })).toBe('unknown key "coupon"');
    expect(JSON.stringify(m.fn("encodeOrder")({ ...order, note: undefined }))).toBe(
      '{"id":"o1","count":1,"tags":[]}',
    );
  });

  it("check the other keys beside named ones, which share the object so none is written twice", () => {
    expect(roundTrip(m, "Prices", '{"b":2,"default":1,"a":3}')).toBe('{"default":1,"a":3,"b":2}');
    expect(refusal(m, "Prices", { default: 1, eur: 0.5 })).toBe("/eur: expected an integer, found 0.5");
  });
});

describe("TypeScript determinism", () => {
  it("writes the same files every run", () => {
    const entries: JsonObject = {
      order: closed({ id: { type: "string" }, n: { type: "integer" } }, ["id"]),
      status: { enum: ["b", "a"] },
    };
    expect(emitTypeScript(libModel(entries))).toEqual(emitTypeScript(libModel(entries)));
  });
});

/** The example whose fixtures every language round trips. */
const EXAMPLE = join(import.meta.dirname, "..", "examples", "basic");
/**
 * Invalid fixtures only the JSON text shows to be invalid. JSON.parse keeps the last of two
 * equal keys, so the decoders, which read parsed values, can't see them. A strict reader of
 * the text will.
 */
const TEXT_ONLY = new Set(["duplicate-key.json"]);

describe("TypeScript example fixtures", () => {
  const config = loadConfig(join(EXAMPLE, "strictgen.json"));
  const model = buildModel(loadSchemas(config.schemas), config.ids === undefined ? {} : { ids: config.ids });
  const root = join(EXAMPLE, "fixtures");
  const fixtures = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  })(root).map((path) => relative(root, path).split(sep));
  const typeOf = new Map(
    model.decls.flatMap((d) =>
      d.source === undefined
        ? []
        : [[d.source.def === undefined ? d.source.schema : `${d.source.schema}/${d.source.def}`, d.name]],
    ),
  );
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  });

  it("covers every folder, each naming a type", () => {
    const keys = new Set(fixtures.map((parts) => parts.slice(0, -2).join("/")));
    for (const key of keys) expect(typeOf.has(key), key).toBe(true);
  });

  it("accepts every valid fixture and re-encodes it to the same JSON, and rejects every invalid one", () => {
    let count = 0;
    for (const parts of fixtures) {
      const key = parts.slice(0, -2).join("/");
      const name = parts.join("/");
      expect(parts.at(-1)?.endsWith(".json"), name).toBe(true);
      const kind = parts.at(-2);
      const type = typeOf.get(key) ?? "";
      const text = readFileSync(join(root, ...parts), "utf8");
      if (kind === "valid") {
        expect(JSON.parse(roundTrip(m, type, text)), name).toEqual(JSON.parse(text));
      } else if (!TEXT_ONLY.has(parts.at(-1) ?? "")) {
        expect(kind, name).toBe("invalid");
        expect(failure(m, type, JSON.parse(text)), name).toEqual(expect.any(String));
      }
      count++;
    }
    expect(count).toBeGreaterThan(10);
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

describe("reserved names", () => {
  it("keeps a property named like a keyword, which TypeScript allows", async () => {
    const out = lib({ rule: keywordFields });
    expect(out).toContain("  type: string;\n");
    expect(out).toContain("  match?: string;\n");
    expect(out).toContain("  func?: string;\n");
    expect(out).toContain("  default: boolean;\n");
    expect(out).toContain("  self?: string;\n");
    const m = await load(libModel({ rule: keywordFields }));
    const text = '{"type":"t","default":true,"crate":"c"}';
    expect(roundTrip(m, "Rule", text)).toBe(text);
  });

  it("quotes a key that is not an identifier", () => {
    const out = lib({
      rule: {
        type: "object",
        properties: { "content-type": { type: "string" } },
        unevaluatedProperties: false,
      },
    });
    expect(out).toContain('  "content-type"?: string;\n');
    expect(out).toContain(
      '  if (value["content-type"] !== undefined) h.member(out, "content-type", value["content-type"], h.encodeString);\n',
    );
  });

  it("fails on a type named like a global type the output uses", () => {
    expect(() => lib({ record: { type: "string" } })).toThrow(
      "lib.json#/$defs/record: reserved-name: type name Record is reserved in TypeScript. Hint: rename the $defs entry",
    );
    expect(() => lib({ partial: { type: "string" } })).toThrow(
      "type name Partial is reserved in TypeScript",
    );
  });

  it("allows type names other languages reserve", () => {
    expect(lib({ self: { type: "string" }, nonNullJson: { type: "string" } })).toContain(
      "export type Self = string;\n",
    );
  });

  it("fails on a type named like a helper index.ts re-exports", () => {
    for (const name of ["decodeError", "encodeError", "decodeResult"]) {
      expect(() => lib({ [name]: { type: "string" } })).toThrow("is reserved in TypeScript");
    }
  });
});
