import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import type { EmittedFile } from "./common.js";
import { loadConfig } from "./config.js";
import type { TypeScriptOptions } from "./emit-ts.js";
import { emitTypeScript, stringFamily } from "./emit-ts.js";
import { ERROR_CODES } from "./errors.js";
import type { Model } from "./model.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";
import { loadSchemas } from "./schema-files.js";

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

/**
 * The time a hook that compiles generated code with tsc may take. A cold start takes longer
 * than vitest's default of 5 seconds.
 */
const COMPILE_TIMEOUT = 60_000;

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

/** The message of the DecodeError that reading `text` as `type` throws. */
function failureFromJson(m: Loaded, type: string, text: string): string {
  try {
    m.fn(`decode${type}FromJson`)(text);
  } catch (error) {
    if (!(error instanceof m.DecodeError)) throw error;
    return error.message;
  }
  throw new Error(`decode${type}FromJson accepted ${text}`);
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
    expect(helpers).toContain("  readonly code: ErrorCode;\n");
    expect(helpers).toContain('  UnknownKey: "unknown_key",\n');
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
  }, COMPILE_TIMEOUT);

  it("return the error from tryDecodeX instead of throwing it", async () => {
    const m = await load(model);
    expect(m.fn("tryDecodeOrder")({ id: "o1" })).toEqual({ ok: true, value: { id: "o1" } });
    const result = m.fn("tryDecodeOrder")({ id: 1 }) as { ok: boolean; error: Error };
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(m.DecodeError);
    expect(result.error).toMatchObject({
      path: "/id",
      code: "wrong_type",
      expected: "a string",
      found: "1",
      message: "/id: wrong type, expected a string, found 1",
    });
    expect((result.error as unknown as { compact: () => string }).compact()).toBe(
      "/id wrong_type, expected a string, found 1",
    );
  }, COMPILE_TIMEOUT);

  it("start error paths under the path given", async () => {
    const m = await load(model);
    expect(failure(m, "Order", { id: null }, "/orders/3")).toBe(
      "/orders/3/id: null not allowed, expected a string",
    );
  }, COMPILE_TIMEOUT);
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
  }, COMPILE_TIMEOUT);

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
    expect(failure(m, "Order", { id: "o1", quantity: 2, coupon: "x" })).toBe("/coupon: unknown key");
    expect(failure(m, "Order", { id: "o1", quantity: 2, shipping: { city: "c", zip: "1" } })).toBe(
      "/shipping/zip: unknown key",
    );
    expect(failure(m, "Empty", { a: 1 })).toBe("/a: unknown key");
  });

  it("fail on a missing required key", () => {
    expect(failure(m, "Order", { id: "o1" })).toBe("/quantity: missing key");
    expect(failure(m, "Order", { id: "o1", quantity: 1, shipping: {} })).toBe(
      "/shipping/city: missing key",
    );
  });

  it("fail on null for an optional key, which only absence leaves out", () => {
    expect(failure(m, "Order", { id: "o1", quantity: 1, note: null })).toBe(
      "/note: null not allowed, expected a string",
    );
    expect(failure(m, "Order", { id: "o1", quantity: 1, note: undefined })).toBe(
      "/note: wrong type, expected a string, found a value that is not JSON",
    );
  });

  it("report the first problem in schema order, as Go does", () => {
    expect(failure(m, "Order", { coupon: 1, quantity: "x" })).toBe("/id: missing key");
    expect(failure(m, "Order", { coupon: 1, id: "o1", quantity: "x" })).toBe(
      '/quantity: wrong type, expected an integer, found "x"',
    );
  });

  it("name the JSON Pointer of nested values, escaping ~ and /", () => {
    expect(failure(m, "Order", { id: "o1", quantity: 1, tags: ["a", 2] })).toBe(
      "/tags/1: wrong type, expected a string, found 2",
    );
    expect(failure(m, "Order", { id: "o1", quantity: 1, "a/b~c": "yes" })).toBe(
      '/a~1b~0c: wrong type, expected a boolean, found "yes"',
    );
    expect(
      failure(m, "Order", { id: "o1", quantity: 1, shipping: { city: "c", "post-code": 1 } }),
    ).toBe("/shipping/post-code: wrong type, expected a string, found 1");
  });

  it("accept only plain objects", () => {
    expect(failure(m, "Order", [])).toBe("wrong type, expected an object, found an array");
    expect(failure(m, "Order", null)).toBe("null not allowed, expected an object");
    expect(failure(m, "Order", "o1")).toBe('wrong type, expected an object, found "o1"');
    expect(failure(m, "Order", new Date(0))).toBe(
      "wrong type, expected an object, found an object that is not plain JSON",
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
  }, COMPILE_TIMEOUT);

  it("read __proto__ and constructor as data keys, never as object internals", () => {
    const text = '{"__proto__":"p","constructor":"c","toString":true}';
    const value = m.fn("decodeOdd")(JSON.parse(text)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe("p");
    expect(roundTrip(m, "Odd", text)).toBe(text);
  });

  it("don't take inherited properties for present keys", () => {
    expect(failure(m, "Odd", {})).toBe("/__proto__: missing key");
    const value = m.fn("decodeOdd")(JSON.parse('{"__proto__":"p"}')) as object;
    expect(Object.hasOwn(value, "constructor")).toBe(false);
    expect(Object.hasOwn(value, "toString")).toBe(false);
  });

  it("reject __proto__ as an unknown key like any other", () => {
    expect(failure(m, "Plain", JSON.parse('{"id":"x","__proto__":{"polluted":true}}'))).toBe(
      "/__proto__: unknown key",
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
  }, COMPILE_TIMEOUT);

  it("decode the named keys first, then every other key into the map", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      '    ...h.rest(o, path, ["default", "note"], decodeCurrency, h.decodeInteger),\n  };\n  return value;\n',
    );
    expect(m.fn("decodePrices")({ eur: 2, default: 1, usd: 3 })).toEqual({
      default: 1,
      eur: 2,
      usd: 3,
    });
    expect(failure(m, "Prices", { eur: 2 })).toBe("/default: missing key");
    expect(failure(m, "Prices", { default: 1, note: 5, eur: "x" })).toBe(
      "/note: wrong type, expected a string, found 5",
    );
  });

  it("check the key type and the value type of the other keys", () => {
    expect(failure(m, "Prices", { default: 1, yen: 2 })).toBe(
      '/yen: not in enum, expected one of "usd", "eur", "gbp", found "yen"',
    );
    expect(failure(m, "Prices", { default: 1, eur: "2" })).toBe(
      '/eur: wrong type, expected an integer, found "2"',
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
  }, COMPILE_TIMEOUT);

  it("decode strings and booleans strictly", () => {
    expect(m.fn("decodeStamp")("2030-01-01T00:00:00Z")).toBe("2030-01-01T00:00:00Z");
    expect(failure(m, "Stamp", 1)).toBe("wrong type, expected a string, found 1");
    expect(failure(m, "Grid", [[true], ["true"]])).toBe('/1/0: wrong type, expected a boolean, found "true"');
    expect(m.fn("decodeGrid")([[true, false], []])).toEqual([[true, false], []]);
  });

  it("decode arrays strictly, naming the index", () => {
    expect(m.fn("decodeNames")(["a", "b"])).toEqual(["a", "b"]);
    expect(failure(m, "Names", ["a", null])).toBe("/1: null not allowed, expected a string");
    expect(failure(m, "Names", { 0: "a" })).toBe("wrong type, expected an array, found an object");
    expect(failure(m, "Names", "a")).toBe('wrong type, expected an array, found "a"');
  });

  it("accept only the listed values of an enum or a string const, naming them", () => {
    expect(m.fn("decodeStatus")("open")).toBe("open");
    expect(failure(m, "Status", "Open")).toBe('not in enum, expected one of "open", "closed", found "Open"');
    expect(failure(m, "Status", 1)).toBe("wrong type, expected a string, found 1");
    expect(m.fn("decodeKind")("refund")).toBe("refund");
    expect(failure(m, "Kind", "sale")).toBe('not const, expected "refund", found "sale"');
  });

  it("accept only the value of an integer or boolean const", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain("export type Version = 1;\n");
    expect(m.fn("decodeVersion")(1)).toBe(1);
    expect(failure(m, "Version", 2)).toBe("not const, expected 1, found 2");
    expect(failure(m, "Version", 1.5)).toBe("wrong type, expected an integer, found 1.5");
    expect(failure(m, "Version", "1")).toBe('wrong type, expected an integer, found "1"');
    expect(m.fn("decodeBelow")(-2)).toBe(-2);
    expect(failure(m, "Below", 2)).toBe("not const, expected -2, found 2");
    expect(m.fn("decodeFlag")(true)).toBe(true);
    expect(failure(m, "Flag", false)).toBe("not const, expected true, found false");
    expect(failure(m, "Flag", 1)).toBe("wrong type, expected a boolean, found 1");
    expect(failure(m, "Line", { order: "o", status: "open", version: 2 })).toBe(
      "/version: not const, expected 1, found 2",
    );
  });

  it("decode integers only when whole and within Number.MAX_SAFE_INTEGER, and never -0", () => {
    const max = Number.MAX_SAFE_INTEGER;
    for (const ok of [0, 1, -1, max, -max]) expect(m.fn("decodeCount")(ok)).toBe(ok);
    expect(failure(m, "Count", 1.5)).toBe("wrong type, expected an integer, found 1.5");
    expect(failure(m, "Count", -0)).toBe("wrong type, expected an integer, found -0");
    expect(failure(m, "Count", JSON.parse("-0.0"))).toBe("wrong type, expected an integer, found -0");
    const range = "out of range integer, expected an integer from -9007199254740991 to 9007199254740991, found";
    expect(failure(m, "Count", max + 1)).toBe(`${range} 9007199254740992`);
    expect(failure(m, "Count", -max - 1)).toBe(`${range} -9007199254740992`);
    // JSON.parse rounds 9007199254740993 to 2^53, which fails instead of decoding as 2^53.
    expect(failure(m, "Count", JSON.parse("9007199254740993"))).toBe(`${range} 9007199254740992`);
    expect(failure(m, "Count", 1e21)).toBe(`${range} 1e+21`);
    expect(failure(m, "Count", Number.NaN)).toBe(
      "wrong type, expected an integer, found a number that is not finite",
    );
    expect(failure(m, "Count", "1")).toBe('wrong type, expected an integer, found "1"');
    expect(failure(m, "Count", 1n)).toBe("wrong type, expected an integer, found a value that is not JSON");
  });

  it("decode any finite number, which re-encodes as JavaScript spells it", () => {
    for (const ok of [0, -0, 1.5, -2e-7, 1e300, Number.MAX_VALUE]) {
      expect(m.fn("decodeRatio")(ok)).toBe(ok);
    }
    expect(failure(m, "Ratio", Number.POSITIVE_INFINITY)).toBe(
      "wrong type, expected a number, found a number that is not finite",
    );
    expect(failure(m, "Ratio", JSON.parse("1e400"))).toBe(
      "wrong type, expected a number, found a number that is not finite",
    );
    expect(failure(m, "Ratio", Number.NaN)).toBe("wrong type, expected a number, found a number that is not finite");
    expect(roundTrip(m, "Ratio", "12.0")).toBe("12");
    expect(roundTrip(m, "Ratio", "-0")).toBe("0");
  });

  it("document the number limits in the generated helpers", () => {
    const helpers = emitTypeScript(model).find((f) => f.name === "helpers.ts")?.contents ?? "";
    expect(helpers).toContain("12.0 and 1e2 decode as the integers 12 and 100");
    expect(helpers).toContain("the FromJson decoders reject them");
    expect(helpers).toContain("A number re-encodes as\n * JavaScript spells it");
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
    expect(failure(m, "OrderId", 1)).toBe("wrong type, expected a string, found 1");
  });

  it("fail when an id type mixes, which the @ts-expect-error checks rely on", () => {
    const loose = ids.replaceAll("// @ts-expect-error", "//");
    expect(() => compile(emitTypeScript(model), { "ids.ts": loose })).toThrow(
      "Type 'UserId' is not assignable to type 'OrderId'",
    );
  }, COMPILE_TIMEOUT);

  it("decode aliases as their target, and fields through their types' decoders", () => {
    const value = {
      order: "o1",
      status: "closed",
      version: 1,
      at: "2024-01-02T03:04:05Z",
      orders: ["a", "b"],
    };
    expect(m.fn("decodeLine")(value)).toEqual(value);
    expect(failure(m, "Line", { ...value, orders: ["a", 1] })).toBe(
      "/orders/1: wrong type, expected a string, found 1",
    );
    expect(failure(m, "Line", { ...value, status: "gone" })).toBe(
      '/status: not in enum, expected one of "open", "closed", found "gone"',
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
  }, COMPILE_TIMEOUT);

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
    expect(failure(m, "Payment", { iban: "x" })).toBe("/type: missing key");
    expect(failure(m, "Payment", { type: 1 })).toBe("/type: wrong type, expected a string, found 1");
    expect(failure(m, "Payment", { type: null })).toBe("/type: null not allowed, expected a string");
    expect(failure(m, "Payment", { type: "cash" })).toBe(
      '/type: bad tag, expected one of "card", "wire", found "cash"',
    );
    expect(failure(m, "Payment", [])).toBe("wrong type, expected an object, found an array");
  });

  it("name the branch in errors inside it, keeping the path", () => {
    expect(failure(m, "Payment", { type: "card" })).toBe("/installments: missing key");
    expect(failure(m, "Payment", { type: "wire", installments: 1 })).toBe(
      "/installments: unknown key",
    );
    expect(failure(m, "Checkout", { root: { type: "card", installments: "2" } })).toBe(
      '/root/installments: wrong type, expected an integer, found "2"',
    );
    expect(failure(m, "Checkout", { root: { type: "wire" }, payments: [{ type: "x" }] })).toBe(
      '/payments/0/type: bad tag, expected one of "card", "wire", found "x"',
    );
  });

  it("decode nested tagged unions spread into one, as Rust and Go do", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      "export type Transfer = CashTransfer | CardPayment | WirePayment;\n",
    );
    expect(m.fn("decodeTransfer")({ type: "cash" })).toEqual({ type: "cash" });
    expect(m.fn("decodeTransfer")({ type: "wire" })).toEqual({ type: "wire" });
    expect(failure(m, "Transfer", { type: "gift" })).toBe(
      '/type: bad tag, expected one of "cash", "card", "wire", found "gift"',
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
      'unknown type "cash", expected one of "card", "wire"',
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
  }, COMPILE_TIMEOUT);

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
    expect(failure(m, "AmountsOrRef", { usd: 1 })).toBe("wrong type, expected AmountsOrRef, found an object");
    expect(failure(m, "Scalar", null)).toBe("null not allowed, expected Scalar");
    expect(failure(m, "Scalar", [1.5], "/x")).toBe("/x: wrong type, expected Scalar, found an array");
  });

  it("map an exactly-one oneOf of required keys to one struct per choice, as Rust and Go", () => {
    const out = emitTypeScript(model)[0]?.contents ?? "";
    expect(out).toContain("export type Contact = ContactEmail | ContactPhone;\n");
    expect(out).toContain("  phone?: never;\n");
    expect(m.fn("decodeContact")({ name: "n", email: "e" })).toEqual({ name: "n", email: "e" });
    expect(m.fn("decodeContact")({ name: "n", phone: "p" })).toEqual({ name: "n", phone: "p" });
    expect(failure(m, "Contact", { name: "n", email: "e", phone: "p" })).toBe(
      "wrong type, expected Contact, found an object",
    );
    expect(failure(m, "Contact", { name: "n" })).toBe("wrong type, expected Contact, found an object");
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
  }, COMPILE_TIMEOUT);

  it("type an enum-keyed map as a partial record", () => {
    expect(emitTypeScript(model)[0]?.contents).toContain(
      "export type ByCurrency = Partial<Record<Currency, number>>;\n",
    );
  });

  it("check the key type, enum keys included, and the value type", () => {
    expect(m.fn("decodeByCurrency")({ eur: 1 })).toEqual({ eur: 1 });
    expect(failure(m, "ByCurrency", { yen: 1 })).toBe(
      '/yen: not in enum, expected one of "usd", "eur", found "yen"',
    );
    expect(failure(m, "ByCurrency", { usd: 1.5 })).toBe("/usd: wrong type, expected an integer, found 1.5");
    expect(failure(m, "Labels", { a: ["x", 1] })).toBe("/a/1: wrong type, expected a string, found 1");
    expect(failure(m, "Labels", [])).toBe("wrong type, expected an object, found an array");
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

describe("TypeScript constraints", () => {
  const model = build({
    common: schema("common", { $defs: { orderId: { type: "string", minLength: 4 } } }),
    lib: schema("lib", {
      $defs: {
        item: closed(
          {
            name: { type: "string", minLength: 2, maxLength: 3 },
            count: { type: "integer", minimum: 1, exclusiveMaximum: 10, multipleOf: 2 },
            price: { type: "number", exclusiveMinimum: 0, maximum: 0.75 },
            tags: { type: "array", items: { type: "string", maxLength: 1 }, minItems: 1, maxItems: 2 },
            byId: {
              type: "object",
              propertyNames: { $ref: `${BASE}common.json#/$defs/orderId` },
              additionalProperties: { type: "integer", maximum: 9 },
              maxProperties: 2,
            },
            size: { oneOf: [{ type: "integer", minimum: 1 }, { type: "string", maxLength: 1 }] },
          },
          ["name"],
        ),
        codes: { type: "array", items: { type: "string", minLength: 3 }, maxItems: 1 },
        moreCodes: { $ref: "#/$defs/codes" },
      },
    }),
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  }, COMPILE_TIMEOUT);

  it("count lengths in code points, not UTF-16 units", () => {
    expect(m.fn("decodeItem")({ name: "😀😀😀" })).toEqual({ name: "😀😀😀" });
    expect(m.fn("decodeItem")({ name: "é" })).toEqual({ name: "é" });
    expect(failure(m, "Item", { name: "😀" })).toBe(
      "/name: too short, expected at least 2 characters, found 1 character",
    );
    expect(failure(m, "Item", { name: "😀😀😀😀" })).toBe(
      "/name: too long, expected at most 3 characters, found 4 characters",
    );
    expect(failure(m, "Item", { name: "́" })).toBe(
      "/name: too short, expected at least 2 characters, found 1 character",
    );
  });

  it("check bounds and multipleOf in a fixed order, showing numbers as Rust and Go do", () => {
    expect(failure(m, "Item", { name: "ab", count: 0 })).toBe("/count: too small, expected >= 1, found 0");
    expect(failure(m, "Item", { name: "ab", count: 10 })).toBe("/count: too large, expected < 10, found 10");
    expect(failure(m, "Item", { name: "ab", count: 3 })).toBe(
      "/count: not a multiple, expected a multiple of 2, found 3",
    );
    expect(failure(m, "Item", { name: "ab", price: 0 })).toBe("/price: too small, expected > 0, found 0");
    expect(failure(m, "Item", { name: "ab", price: -0 })).toBe("/price: too small, expected > 0, found -0");
    expect(failure(m, "Item", { name: "ab", price: 1e21 })).toBe(
      "/price: too large, expected <= 0.75, found 1e+21",
    );
    expect(m.fn("decodeItemFromJson")('{"name":"ab","price":75E-2}')).toEqual({ name: "ab", price: 0.75 });
    // The value, not its spelling, as Rust and Go show it.
    expect(failureFromJson(m, "Item", '{"name":"ab","price":1E0}')).toBe(
      "/price: too large, expected <= 0.75, found 1",
    );
  });

  it("check counts of items and keys, then each item and key", () => {
    expect(failure(m, "Item", { name: "ab", tags: [] })).toBe(
      "/tags: too short, expected at least 1 item, found 0 items",
    );
    expect(failure(m, "Item", { name: "ab", tags: ["ab", "a", "b"] })).toBe(
      "/tags: too long, expected at most 2 items, found 3 items",
    );
    expect(failure(m, "Item", { name: "ab", tags: ["a", "bc"] })).toBe(
      "/tags/1: too long, expected at most 1 character, found 2 characters",
    );
    expect(failure(m, "Item", { name: "ab", byId: { a: 1, b: 2, c: 3 } })).toBe(
      "/byId: too long, expected at most 2 keys, found 3 keys",
    );
  });

  it("check map keys in code point order, each key before its value", () => {
    expect(failure(m, "Item", { name: "ab", byId: { ord_b: 10, ord_a: 10 } })).toBe(
      "/byId/ord_a: too large, expected <= 9, found 10",
    );
    expect(failure(m, "Item", { name: "ab", byId: { ord_b: 10, ord: 1 } })).toBe(
      "/byId/ord: too short, expected at least 4 characters, found 3 characters",
    );
    // UTF-16 order puts U+FFFD after the surrogates of U+1F600, code point order before.
    expect(failure(m, "Item", { name: "ab", byId: { "ord😀": 10, "ord�": 10 } })).toBe(
      "/byId/ord�: too large, expected <= 9, found 10",
    );
    expect(Object.keys(m.fn("decodeItem")({ name: "ab", byId: { ord_b: 1, ord_a: 2 } }) as object)).toEqual([
      "name",
      "byId",
    ]);
    const byId = (m.fn("decodeItem")({ name: "ab", byId: { ord_b: 1, ord_a: 2 } }) as { byId: object }).byId;
    expect(Object.keys(byId)).toEqual(["ord_b", "ord_a"]);
  });

  it("report a structure error anywhere before any constraint", () => {
    expect(failure(m, "Item", { name: "a", count: "1" })).toBe(
      "/count: wrong type, expected an integer, found \"1\"",
    );
    expect(failure(m, "Item", { name: "a", extra: 1 })).toBe("/extra: unknown key");
    expect(failure(m, "Item", { name: "a", byId: { ord_a: 1, x: "y" } })).toBe(
      "/byId/x: wrong type, expected an integer, found \"y\"",
    );
    expect(failure(m, "Item", { name: "a", count: 0 })).toBe(
      "/name: too short, expected at least 2 characters, found 1 character",
    );
  });

  it("pick a union's variant by structure only, then check it", () => {
    expect(failure(m, "Item", { name: "ab", size: 0 })).toBe("/size: too small, expected >= 1, found 0");
    expect(failure(m, "Item", { name: "ab", size: "xy" })).toBe(
      "/size: too long, expected at most 1 character, found 2 characters",
    );
    expect(failure(m, "Item", { name: "ab", size: true })).toBe(
      "/size: wrong type, expected ItemSize, found true",
    );
  });

  it("check ids and aliases decoded on their own, and nested ones", () => {
    expect(failure(m, "OrderId", "ord")).toBe("too short, expected at least 4 characters, found 3 characters");
    expect(failure(m, "Codes", ["abc", "abd"])).toBe("too long, expected at most 1 item, found 2 items");
    expect(failure(m, "Codes", ["ab"])).toBe("/0: too short, expected at least 3 characters, found 2 characters");
    expect(failure(m, "Codes", ["ab"], "/codes")).toBe(
      "/codes/0: too short, expected at least 3 characters, found 2 characters",
    );
    expect(m.fn("tryDecodeCodesFromJson")('["abc"]')).toEqual({ ok: true, value: ["abc"] });
  });

  it("check a constrained alias, and an alias of it, through every entry point in both read modes", async () => {
    const report = await load(model, { read: "report" });
    const bad = ["abc", "abd"];
    const text = JSON.stringify(bad);
    const message = "too long, expected at most 1 item, found 2 items";
    const code = { path: "", code: "too_long" };
    for (const [mode, loaded] of [["strict", m], ["report", report]] as const) {
      for (const name of ["Codes", "MoreCodes"]) {
        const at = `${mode} ${name}`;
        expect(failure(loaded, name, bad), at).toBe(message);
        expect(failureFromJson(loaded, name, text), at).toBe(message);
        expect(loaded.fn(`tryDecode${name}`)(bad), at).toMatchObject({ ok: false, error: code });
        expect(loaded.fn(`tryDecode${name}FromJson`)(text), at).toMatchObject({ ok: false, error: code });
        if (mode === "report") {
          expect(() => loaded.fn(`report${name}`)(bad), at).toThrow(message);
          expect(() => loaded.fn(`report${name}FromJson`)(text), at).toThrow(message);
          expect(loaded.fn(`report${name}FromJson`)('["abc"]'), at).toEqual({ value: ["abc"], unknown: [] });
        }
      }
    }
  }, COMPILE_TIMEOUT);

  it("leave constraints out with validation off", async () => {
    const off = await load(
      buildModel(schemaSet({ lib: schema("lib", { $defs: { short: { type: "string", maxLength: 1 } } }) }), {
        validation: false,
      }),
    );
    expect(off.fn("decodeShort")("long")).toBe("long");
  }, COMPILE_TIMEOUT);
});

describe("TypeScript patterns, formats and unique items", () => {
  const entries: JsonObject = {
    item: closed(
      {
        code: { type: "string", maxLength: 4, pattern: "^[A-Z]+$" },
        day: { type: "string", pattern: "^20", format: "date" },
        at: { type: "string", format: "date-time" },
        id: { type: "string", format: "uuid" },
        dot: { type: "string", pattern: "^a.c$" },
        space: { type: "string", pattern: "^\\s$" },
        digits: { type: "string", pattern: "\\d" },
        tags: {
          type: "array",
          items: { type: "string", maxLength: 1 },
          maxItems: 3,
          uniqueItems: true,
        },
        values: { type: "array", items: {}, uniqueItems: true },
        byCode: {
          type: "object",
          propertyNames: { type: "string", pattern: "^[a-z]+$" },
          additionalProperties: { type: "integer" },
        },
      },
      [],
    ),
    lines: { type: "array", items: closed({ sku: { type: "string" } }, ["sku"]), uniqueItems: true },
  };
  let m: Loaded;
  let r: Loaded;
  beforeAll(async () => {
    m = await load(libModel(entries));
    r = await load(libModel(entries), { read: "report" });
  }, COMPILE_TIMEOUT);

  it("compile each pattern once, in its portable form, in the helpers", () => {
    const helpers = emitTypeScript(libModel(entries)).find((f) => f.name === "helpers.ts")?.contents ?? "";
    expect(helpers).toContain('  [new RegExp("[0-9]", "u"), "\\\\d"],\n');
    expect(helpers).toContain('  [new RegExp("^a[^\\u000a\\u000d\\u2028\\u2029]c$", "u"), "^a.c$"],\n');
    const out = lib(entries);
    expect(out).toContain("h.matches(h.length(h.decodeString, undefined, 4), 2)");
    expect(out).toContain('h.format(h.matches(h.family<`20${string}`>(), 1), "date")');
    expect(out).toContain("h.array(h.length(h.decodeString, undefined, 1), undefined, 3, true)");
    expect(lib({ plain: { type: "string" } })).not.toContain("PATTERNS");
  });

  it("match a pattern anywhere unless it anchors itself, reading it as ECMAScript does", () => {
    expect(m.fn("decodeItem")({ digits: "a1b" })).toEqual({ digits: "a1b" });
    expect(failure(m, "Item", { digits: "a١b" })).toBe(
      '/digits: pattern mismatch, expected matching \\d, found "a١b"',
    );
    expect(failure(m, "Item", { dot: "a\rc" })).toContain("/dot: pattern mismatch");
    expect(failure(m, "Item", { dot: "a\u2028c" })).toContain("/dot: pattern mismatch");
    expect(m.fn("decodeItem")({ dot: "a\u{1f600}c" })).toEqual({ dot: "a\u{1f600}c" });
    expect(m.fn("decodeItem")({ space: "\u00a0" })).toEqual({ space: "\u00a0" });
    expect(failure(m, "Item", { space: "\u0085" })).toContain("/space: pattern mismatch");
  });

  it("check the length, then the pattern, then the format", () => {
    expect(failure(m, "Item", { code: "ABCDE" })).toContain("/code: too long");
    expect(failure(m, "Item", { code: "abc" })).toBe(
      '/code: pattern mismatch, expected matching ^[A-Z]+$, found "abc"',
    );
    expect(failure(m, "Item", { day: "1999-13-01" })).toContain("/day: pattern mismatch");
    expect(failure(m, "Item", { day: "2023-02-29" })).toBe(
      '/day: bad format, expected a date, found "2023-02-29"',
    );
  });

  it("check date-time, date and uuid by their grammars", () => {
    for (const at of ["1998-12-31T23:59:60Z", "1998-12-31T15:59:60.5-08:00", "2024-01-02t03:04:05z"]) {
      expect(m.fn("decodeItem")({ at })).toEqual({ at });
    }
    for (const at of ["1998-12-31T22:59:60Z", "2024-01-02 03:04:05Z", "2024-01-02T03:04:05", "2024-01-02T03:04:05.Z"]) {
      expect(failure(m, "Item", { at })).toBe(`/at: bad format, expected a date-time, found "${at}"`);
    }
    expect(m.fn("decodeItem")({ id: "123E4567-e89b-12d3-a456-426614174000" })).toBeDefined();
    expect(failure(m, "Item", { id: "123e4567e89b12d3a456426614174000" })).toBe(
      '/id: bad format, expected a UUID, found "123e4567e89b12d3a456426614174000"',
    );
  });

  it("check a map key's pattern, in code point order", () => {
    expect(failure(m, "Item", { byCode: { b: 1, Z: 2, A: 3 } })).toContain("/byCode/A: pattern mismatch");
  });

  it("compare items by canonical JSON, after the count and before the items, at the repeat", () => {
    expect(failure(m, "Item", { tags: ["a", "b", "a"] })).toBe(
      "/tags/2: not unique, expected unique items, found a repeat of item 0",
    );
    expect(failure(m, "Item", { tags: ["a", "a", "b", "c"] })).toContain("/tags: too long");
    expect(failure(m, "Item", { tags: ["long", "b", "b"] })).toContain("/tags/2: not unique");
    expect(failure(m, "Item", { values: [{ a: 1, b: [2] }, { b: [2.0], a: 1 }] })).toContain(
      "/values/1: not unique",
    );
    expect(failure(m, "Item", { values: [0, -0] })).toContain("/values/1: not unique");
    expect(failureFromJson(m, "Item", '{"values":[1,1.0]}')).toContain("/values/1: not unique");
    expect(m.fn("decodeItem")({ values: [1, "1", [1], { a: 1 }, null] })).toBeDefined();
  });

  it("compare decoded items in report mode, so unknown keys don't count, and note them once", () => {
    expect(() => r.fn("reportLinesFromJson")('[{"sku":"a","x":1},{"sku":"a","y":2}]')).toThrow(
      "/1: not unique, expected unique items, found a repeat of item 0",
    );
    expect(r.fn("reportLinesFromJson")('[{"sku":"a","x":1},{"sku":"b","x":1}]')).toEqual({
      value: [{ sku: "a" }, { sku: "b" }],
      unknown: ["/0/x", "/1/x"],
    });
  });

  it("check an id's pattern, which types nothing", async () => {
    const ids = build({ common: schema("common", { $defs: { orderId: { type: "string", pattern: "^ord_" } } }) });
    expect(emitTypeScript(ids)[0]?.contents).toContain("  return h.matches(h.decodeString, 0)(json, path) as OrderId;\n");
    const loaded = await load(ids);
    expect(loaded.fn("decodeOrderId")("ord_1")).toBe("ord_1");
    expect(failure(loaded, "OrderId", "x")).toBe('pattern mismatch, expected matching ^ord_, found "x"');
  }, COMPILE_TIMEOUT);

  it("leave patterns, formats and unique items unchecked with validation off", async () => {
    const off = await load(buildModel(schemaSet({ lib: schema("lib", { $defs: entries }) }), { validation: false }));
    expect(off.fn("decodeItem")({ code: "abc", at: "x", tags: ["a", "a"] })).toEqual({
      code: "abc",
      at: "x",
      tags: ["a", "a"],
    });
  }, COMPILE_TIMEOUT);
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
  }, COMPILE_TIMEOUT);

  it("decode {} as any JSON value, null included, and keep it as it is", () => {
    for (const any of [null, 1, "x", true, [], { a: [null, { b: 2 }] }]) {
      expect(m.fn("decodeHolder")({ any })).toEqual({ any });
    }
    expect(failure(m, "Holder", { any: { a: [1, undefined] } })).toBe(
      "/any/a/1: wrong type, expected a JSON value, found a value that is not JSON",
    );
    expect(failure(m, "Holder", { list: [Number.NaN] })).toBe(
      "/list/0: wrong type, expected a JSON value, found a number that is not finite",
    );
    expect(failure(m, "Holder", { any: new Map() })).toBe(
      "/any: wrong type, expected a JSON value, found an object that is not plain JSON",
    );
  });

  it("decode a non-null value as any JSON value but null", () => {
    expect(m.fn("decodeHolder")({ nonNull: { a: null } })).toEqual({ nonNull: { a: null } });
    expect(failure(m, "Holder", { nonNull: null })).toBe("/nonNull: null not allowed, expected a JSON value other than null");
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

  it("fail with a DecodeError or EncodeError on a value whose reading throws", () => {
    const getter = Object.defineProperty({}, "a", {
      enumerable: true,
      get: () => {
        throw new Error("no");
      },
    });
    const thrown = "expected a JSON value, found a value that throws when read";
    expect(failure(m, "Holder", { any: { b: [getter] } })).toBe(`/any/b/0/a: wrong type, ${thrown}`);
    expect(refusal(m, "Holder", { any: { b: [getter] } })).toBe(`/any/b/0/a: ${thrown}`);
    const item = Object.defineProperty([1, 2], 1, {
      get: () => {
        throw new Error("no");
      },
    });
    expect(failure(m, "Holder", { any: item })).toBe(`/any/1: wrong type, ${thrown}`);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(failure(m, "Holder", { any: proxy })).toBe(`/any: wrong type, ${thrown}`);
    expect(refusal(m, "Holder", { nonNull: [proxy] })).toBe(`/nonNull/0: ${thrown}`);
  });

  it("decode and encode recursive types as deep as the input", () => {
    const text = '{"name":"a","children":[{"name":"b","next":{"name":"c"}}]}';
    expect(roundTrip(m, "Tree", text)).toBe(text);
    expect(failure(m, "Tree", { name: "a", children: [{ name: "b", next: { name: 1 } }] })).toBe(
      "/children/0/next/name: wrong type, expected a string, found 1",
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
  }, COMPILE_TIMEOUT);
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

describe("TypeScript string families", () => {
  it("detect a literal prefix or suffix around a part that allows anything", () => {
    const cases: [string, string, string][] = [
      ["^order\\..+$", "order.", ""],
      ["^order\\..*$", "order.", ""],
      ["^evt_", "evt_", ""],
      ["^evt_.+", "evt_", ""],
      ["\\.json$", "", ".json"],
      [".+\\.json$", "", ".json"],
      ["^v.+-beta$", "v", "-beta"],
      ["^a\\$b\\/c.*$", "a$b/c", ""],
      ["^é_.+$", "é_", ""],
    ];
    for (const [pattern, prefix, suffix] of cases) {
      expect(stringFamily(pattern), pattern).toEqual({ prefix, suffix });
    }
  });

  it("leave every other pattern a plain string", () => {
    const plain = [
      "order\\..+",
      "^order\\.$",
      "^.+$",
      "^$",
      "",
      "^[a-z]+\\..+$",
      "^a|b$",
      "^\\d+$",
      "^a.+b.+$",
      "^a.*?$",
      "^a+.*$",
      "^a.*b",
      "a.*b$",
      "^a\\nb",
      "^a\\-b",
      "^a$b",
      "^a(b).+$",
      "^a{2}.+$",
      "^a\tb",
    ];
    for (const pattern of plain) expect(stringFamily(pattern), pattern).toBeUndefined();
  });

  const model = libModel({
    orderRef: { type: "string", pattern: "^order\\..+$" },
    fileName: { type: "string", pattern: "\\.json$" },
    quoted: { type: "string", pattern: "^a`\\$\\\\.+$" },
    plain: { type: "string", pattern: "^[a-z]+$" },
    note: closed(
      {
        ref: { type: "string", pattern: "^order\\..+$" },
        refs: { type: "array", items: { type: "string", pattern: "^order\\..+$" } },
        byRef: {
          type: "object",
          propertyNames: { type: "string", pattern: "^order\\." },
          additionalProperties: { type: "integer" },
        },
      },
      ["ref"],
    ),
  });
  const checks = [
    'import type { FileName, Note, OrderRef, Quoted } from "./index.js";',
    'export const ref: OrderRef = "order.1";',
    "// @ts-expect-error a string without the prefix is not an OrderRef",
    'export const other: OrderRef = "user.1";',
    'export const file: FileName = "a.json";',
    "// @ts-expect-error a string without the suffix is not a FileName",
    'export const notFile: FileName = "a.txt";',
    'export const quoted: Quoted = "a`$\\\\x";',
    'export const note: Note = { ref: "order.2", refs: ["order.3"], byRef: { "order.4": 1 } };',
    "// @ts-expect-error a map key without the prefix",
    'export const badKey: Note = { ref: "order.2", byRef: { "user.4": 1 } };',
    "",
  ].join("\n");
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model, {}, { "checks.ts": checks });
  }, COMPILE_TIMEOUT);

  it("type a family as a template literal type, and other patterns as string", () => {
    const text = emitTypeScript(model)[0]?.contents ?? "";
    expect(text).toContain("export type OrderRef = `order.${string}`;\n");
    expect(text).toContain("export type FileName = `${string}.json`;\n");
    expect(text).toContain("export type Quoted = `a\\`\\$\\\\${string}`;\n");
    expect(text).toContain("export type Plain = string;\n");
    expect(text).toContain("  ref: `order.${string}`;\n");
    expect(text).toContain("  refs?: (`order.${string}`)[];\n");
    expect(text).toContain("  byRef?: Record<`order.${string}`, number>;\n");
  });

  it("decode a family as a string and check its pattern, as in Rust and Go", () => {
    expect(m.fn("decodeOrderRef")("order.1")).toBe("order.1");
    expect(failure(m, "OrderRef", "user.1")).toBe(
      'pattern mismatch, expected matching ^order\\..+$, found "user.1"',
    );
    expect(failure(m, "OrderRef", 1)).toBe("wrong type, expected a string, found 1");
    const note = { ref: "order.1", refs: ["order.2"], byRef: { "order.3": 1 } };
    expect(m.fn("decodeNote")(note)).toEqual(note);
    expect(JSON.stringify(m.fn("encodeNote")(note))).toBe(JSON.stringify(note));
  });

  it("fail to compile a value outside the family, which the @ts-expect-error checks rely on", () => {
    const loose = checks.replaceAll("// @ts-expect-error", "//");
    expect(() => compile(emitTypeScript(model), { "checks.ts": loose })).toThrow(
      "is not assignable to type '`order.${string}`'",
    );
  }, COMPILE_TIMEOUT);
});

describe("TypeScript strict JSON reader", () => {
  const model = libModel({
    anything: {},
    count: { type: "integer" },
    ratio: { type: "number" },
    one: { const: 1 },
    order: closed(
      {
        id: { type: "string" },
        qty: { type: "integer" },
        tags: { type: "array", items: { type: "integer" } },
        counts: { type: "object", additionalProperties: { type: "integer" } },
        extra: {},
      },
      ["id"],
    ),
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  }, COMPILE_TIMEOUT);
  const read = (type: string, text: string): unknown => m.fn(`decode${type}FromJson`)(text);

  it("read JSON text as JSON.parse does", () => {
    const texts = [
      "null",
      " true ",
      "false",
      "0",
      "-1.5e-3",
      "1E+2",
      "123456789012345678901234567890",
      '""',
      '"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t"',
      '"\\u0041\\u00e9\\uD83D\\ude00"',
      '"é😀～"',
      "[]",
      "{}",
      ' \t\n\r[ 1 , [ ] , { "a" : { } } ] ',
      '{"a":[1,{"b":null}],"":"empty","c":"\\u0000"}',
    ];
    for (const text of texts) expect(read("Anything", text), text).toEqual(JSON.parse(text));
  });

  it("keep __proto__ as a data key", () => {
    const value = read("Anything", '{"__proto__":{"x":1}}') as object;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
  });

  it("reject invalid syntax with Go's reason and the offset in UTF-8 bytes", () => {
    const cases: [string, string][] = [
      ["", "an unexpected end of input"],
      ["   ", "an unexpected end of input"],
      ["[1,", "an unexpected end of input"],
      ["[1,]", "an invalid value"],
      ["{,}", "a missing key"],
      ['{"a":1,}', "a missing key"],
      ['{"a" 1}', "a missing colon"],
      ['{"a":1 "b":2}', "a missing comma or closing brace"],
      ["[1 2]", "a missing comma or closing bracket"],
      ["tru", "an invalid literal"],
      ["nul1", "an invalid literal"],
      ["01", "a leading zero"],
      ["-", "an invalid value"],
      ["+1", "an invalid value"],
      ["1.", "an invalid number"],
      ["1e", "an invalid number"],
      [".5", "an invalid value"],
      ["NaN", "an invalid value"],
      ["1e400", "a number out of range"],
      ['"abc', "an unterminated string"],
      ['"a\nb"', "a control character in a string"],
      ['"\\x"', "an invalid escape"],
      ['"\\u12G4"', "an invalid escape"],
      ["\ufeff{}", "an invalid value"],
      ["{} {}", "trailing characters"],
      ['"a" x', "trailing characters"],
    ];
    for (const [text, reason] of cases) {
      expect(failureFromJson(m, "Anything", text), JSON.stringify(text)).toMatch(
        new RegExp(`^(/\\S*: )?invalid JSON, found ${reason} at offset \\d+$`),
      );
    }
    expect(failureFromJson(m, "Anything", '{"a":1 "b":2}')).toBe(
      "invalid JSON, found a missing comma or closing brace at offset 7",
    );
    // é is two bytes and 😀 four in UTF-8, one and two units in UTF-16.
    expect(failureFromJson(m, "Anything", '["é😀", x]')).toBe(
      "/1: invalid JSON, found an invalid value at offset 11",
    );
  });

  it("reject a key given twice, at the key's path", () => {
    expect(failureFromJson(m, "Anything", '{"id":"a","id":"b"}')).toBe(
      '/id: duplicate key, found "id" at offset 10',
    );
    expect(failureFromJson(m, "Order", '{"id":"a","extra":[{"k":1,"k":1}]}')).toBe(
      '/extra/0/k: duplicate key, found "k" at offset 26',
    );
    // Keys compare after unescaping, as Rust and Go compare them.
    expect(failureFromJson(m, "Anything", '{"a":1,"\\u0061":2}')).toBe(
      '/a: duplicate key, found "a" at offset 7',
    );
  });

  it("reject lone surrogates, escaped or in the text", () => {
    for (const text of ['"\\ud800"', '"\\udc00"', '"\\ud800\\u0041"', '"\\ud800x"', '"x\\uDBFF"']) {
      expect(failureFromJson(m, "Anything", text), text).toMatch(/^invalid JSON, found a lone surrogate at offset \d+$/);
    }
    expect(failureFromJson(m, "Anything", '["a", "\\udc00"]')).toBe(
      "/1: invalid JSON, found a lone surrogate at offset 7",
    );
    expect(failureFromJson(m, "Anything", '"a\uD800"')).toBe("invalid JSON, found invalid UTF-8 at offset 2");
    expect(failureFromJson(m, "Anything", '"\uDC00\uD800"')).toBe("invalid JSON, found invalid UTF-8 at offset 1");
  });

  it("read up to 127 nested arrays and objects and reject more, as Rust and Go do", () => {
    const nested = (depth: number): string => "[".repeat(depth) + "]".repeat(depth);
    expect(read("Anything", nested(127))).toEqual(JSON.parse(nested(127)));
    const deep = "too deep, expected at most 127 nested arrays and objects, found more at offset 127";
    expect(failureFromJson(m, "Anything", nested(128))).toBe(`${"/0".repeat(127)}: ${deep}`);
    const objects = '{"a":'.repeat(128) + "1" + "}".repeat(128);
    expect(failureFromJson(m, "Anything", objects)).toMatch(/too deep/);
    // Far deeper input fails at the limit, without running out of stack.
    expect(failureFromJson(m, "Anything", nested(1_000_000))).toMatch(/too deep/);
  });

  it("reject an integer spelled with a fraction or an exponent, deciding on the text", () => {
    for (const text of ["12.0", "1e2", "1E2", "1.0e1", "12.5", "-0.0"]) {
      expect(failureFromJson(m, "Count", text), text).toBe(`wrong type, expected an integer, found ${text}`);
    }
    expect(failureFromJson(m, "Count", "-0")).toBe("wrong type, expected an integer, found -0");
    expect(failureFromJson(m, "One", "1.0")).toBe("wrong type, expected an integer, found 1.0");
    expect(failureFromJson(m, "One", "2")).toBe("not const, expected 1, found 2");
    for (const text of ["12", "-12", " 7 ", "0", "9007199254740991"]) {
      expect(read("Count", text), text).toBe(JSON.parse(text));
    }
    expect(failureFromJson(m, "Count", "9007199254740993")).toBe(
      "out of range integer, expected an integer from -9007199254740991 to 9007199254740991, found 9007199254740993",
    );
    expect(failureFromJson(m, "Order", '{"id":"a","tags":[1,2.0]}')).toBe(
      "/tags/1: wrong type, expected an integer, found 2.0",
    );
    expect(failureFromJson(m, "Order", '{"id":"a","counts":{"x":1,"y/z":1e0}}')).toBe(
      "/counts/y~1z: wrong type, expected an integer, found 1e0",
    );
  });

  it("read a number or any value spelled with a fraction or an exponent", () => {
    expect(read("Ratio", "12.0")).toBe(12);
    expect(read("Ratio", "1e2")).toBe(100);
    expect(read("Order", '{"id":"a","extra":{"n":12.0}}')).toEqual({ id: "a", extra: { n: 12 } });
  });

  it("forget the spellings of one document before the next", () => {
    expect(failureFromJson(m, "Order", '{"id":"a","qty":1.0}')).toBe("/qty: wrong type, expected an integer, found 1.0");
    expect(read("Order", '{"id":"a","qty":1}')).toEqual({ id: "a", qty: 1 });
    expect(m.fn("decodeOrder")({ id: "a", qty: 1 })).toEqual({ id: "a", qty: 1 });
  });

  it("return the error from tryDecodeXFromJson instead of throwing it", () => {
    expect(m.fn("tryDecodeCountFromJson")("3")).toEqual({ ok: true, value: 3 });
    const result = m.fn("tryDecodeCountFromJson")("3.0") as { ok: boolean; error: Error };
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(m.DecodeError);
    expect(result.error).toMatchObject({ path: "", code: "wrong_type", expected: "an integer", found: "3.0" });
    expect(m.fn("tryDecodeCountFromJson")("[")).toMatchObject({ ok: false });
  });

  it("reject a leading byte order mark kept by the documented TextDecoder, as Rust and Go do", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x37]);
    const kept = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    expect(failureFromJson(m, "Count", kept)).toBe("invalid JSON, found an invalid value at offset 0");
    // Without ignoreBOM the decoder drops the mark, and the text reads as 7.
    expect(read("Count", new TextDecoder("utf-8", { fatal: true }).decode(bytes))).toBe(7);
  });

  it("fail on input that is not text", () => {
    expect(failureFromJson(m, "Count", 12 as unknown as string)).toBe("wrong type, expected JSON text, found 12");
  });
});

describe("TypeScript error shape", () => {
  const model = libModel({
    status: { enum: ["open", "closed"] },
    pick: { const: "x" },
    empty: closed({}),
    pair: closed({ b: { type: "string" }, 1: { type: "string" } }, ["b"]),
    counts: { type: "object", additionalProperties: { type: "integer" } },
    list: { type: "array", items: { type: "string" } },
  });
  let m: Loaded;
  beforeAll(async () => {
    m = await load(model);
  }, COMPILE_TIMEOUT);
  const caught = (run: () => unknown): Record<string, unknown> => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof m.DecodeError)) throw error;
      const e = error as unknown as Record<string, unknown> & { compact: () => string };
      return { path: e.path, code: e.code, expected: e.expected, found: e.found, message: e.message, compact: e.compact() };
    }
    throw new Error("decoded");
  };

  it("export every shared code as a constant", async () => {
    const helpers = (await import(pathToFileURL(join(compile(emitTypeScript(model)), "helpers.js")).href)) as {
      ErrorCode: Record<string, string>;
    };
    expect(Object.values(helpers.ErrorCode)).toEqual(ERROR_CODES.map((c) => c.code));
    expect(helpers.ErrorCode.InvalidJson).toBe("invalid_json");
    expect(helpers.ErrorCode.OutOfRangeInteger).toBe("out_of_range_integer");
  }, COMPILE_TIMEOUT);

  it("give the path, code, expected and found, the message and the compact form", () => {
    expect(caught(() => m.fn("decodeStatusFromJson")('"gone"'))).toEqual({
      path: "",
      code: "not_in_enum",
      expected: 'one of "open", "closed"',
      found: '"gone"',
      message: 'not in enum, expected one of "open", "closed", found "gone"',
      compact: 'not_in_enum, expected one of "open", "closed", found "gone"',
    });
    expect(caught(() => m.fn("decodePairFromJson")("{}"))).toEqual({
      path: "/b",
      code: "missing_key",
      expected: undefined,
      found: undefined,
      message: "/b: missing key",
      compact: "/b missing_key",
    });
    expect(caught(() => m.fn("decodeListFromJson")('["a",null]'))).toMatchObject({
      path: "/1",
      code: "null_not_allowed",
      compact: "/1 null_not_allowed, expected a string",
    });
    expect(caught(() => m.fn("decodePickFromJson")('"y"'))).toMatchObject({
      code: "not_const",
      expected: '"x"',
      found: '"y"',
    });
  });

  it("show strings in found escaped and cut to 64 code points", () => {
    const found = (text: string): unknown => caught(() => m.fn("decodeStatus")(text)).found;
    expect(found('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(found("\u0000\u001f\u007f\u0085\u2028\u2029é😀")).toBe('"\\u0000\\u001f\\u007f\\u0085\\u2028\\u2029é😀"');
    expect(found("\uD800")).toBe('"\\ud800"');
    expect(found("😀".repeat(64))).toBe(`"${"😀".repeat(64)}"`);
    expect(found("😀".repeat(65))).toBe(`"${"😀".repeat(64)}"...`);
  });

  it("report the first unknown key in input order from text, keys like 1 included, as Go does", () => {
    expect(caught(() => m.fn("decodeEmptyFromJson")('{"z":1,"1":2}')).path).toBe("/z");
    // A JavaScript object lists keys like "1" first, so a parsed value can't keep the order.
    expect(caught(() => m.fn("decodeEmpty")({ z: 1, 1: 2 })).path).toBe("/1");
    expect(caught(() => m.fn("decodeCountsFromJson")('{"b":"x","1":"y"}')).path).toBe("/b");
  });

  it("write keys in the order Rust and Go write them with encodeXToJson", () => {
    expect(JSON.stringify(m.fn("encodeCounts")({ a: 1, 9: 2, 10: 3 }))).toBe('{"9":2,"10":3,"a":1}');
    expect(m.fn("encodeCountsToJson")({ a: 1, 9: 2, 10: 3 })).toBe('{"10":3,"9":2,"a":1}');
  });

  it("turn a throwing getter or Proxy anywhere into a DecodeError or EncodeError", () => {
    const throwing = (key: string): object =>
      Object.defineProperty({}, key, {
        enumerable: true,
        get: () => {
          throw new Error("no");
        },
      });
    const thrown = "wrong type, expected a JSON value, found a value that throws when read";
    expect(caught(() => m.fn("decodePair")(throwing("b"))).message).toBe(`/b: ${thrown}`);
    expect(caught(() => m.fn("decodeCounts")(throwing("n"))).message).toBe(`/n: ${thrown}`);
    const items = Object.defineProperty(["a", "b"], 1, {
      get: () => {
        throw new Error("no");
      },
    });
    expect(caught(() => m.fn("decodeList")(items)).message).toBe(`/1: ${thrown}`);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(caught(() => m.fn("decodePair")(proxy)).message).toBe(thrown);
    expect(refusal(m, "Pair", throwing("b"))).toBe("/b: expected a JSON value, found a value that throws when read");
    expect(refusal(m, "List", items)).toBe("/1: expected a JSON value, found a value that throws when read");
    expect(refusal(m, "Pair", proxy)).toBe("expected a JSON value, found a value that throws when read");
  });
});

/** The example whose fixtures every language round trips. */
const EXAMPLE = join(import.meta.dirname, "..", "examples", "basic");
/** Ends the file next to an invalid case that holds the error it expects. */
const EXPECT = ".expect.json";

/** The path and code an invalid case expects. Both are required and no other key is allowed. */
function expectation(path: string): { path: string; code: string } {
  expect(existsSync(path), `every invalid case needs ${path}`).toBe(true);
  const want = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  expect(Object.keys(want).sort(), path).toEqual(["code", "path"]);
  expect(typeof want.path === "string" && typeof want.code === "string", path).toBe(true);
  return { path: String(want.path), code: String(want.code) };
}

/** The path and code of the DecodeError that reading `text` as `type` throws. */
function errorFromJson(m: Loaded, type: string, text: string): { path: string; code: string } {
  try {
    m.fn(`decode${type}FromJson`)(text);
  } catch (error) {
    if (!(error instanceof m.DecodeError)) throw error;
    const { path, code } = error as unknown as { path: string; code: string };
    return { path, code };
  }
  throw new Error(`decode${type}FromJson accepted ${text}`);
}
describe("TypeScript example fixtures", () => {
  const config = loadConfig(join(EXAMPLE, "strictgen.json"));
  const model = buildModel(loadSchemas(config.schemas), config.ids === undefined ? {} : { ids: config.ids });
  const root = join(EXAMPLE, "fixtures");
  const fixtures = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      // Only .json files are fixtures, as in the Rust and Go harnesses.
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".json") ? [path] : [];
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
  }, COMPILE_TIMEOUT);

  it("covers every folder, each naming a type", () => {
    const keys = new Set(fixtures.map((parts) => parts.slice(0, -2).join("/")));
    for (const key of keys) expect(typeOf.has(key), key).toBe(true);
  });

  it("accepts every valid fixture and re-encodes it to the same JSON, and rejects every invalid one", () => {
    let count = 0;
    for (const parts of fixtures) {
      const key = parts.slice(0, -2).join("/");
      const name = parts.join("/");
      const kind = parts.at(-2);
      // A file outside a valid or invalid folder fails, so a misspelled folder never skips one.
      expect(parts.length >= 3 && (kind === "valid" || kind === "invalid"), name).toBe(true);
      if (name.endsWith(EXPECT)) {
        // An expectation belongs to an invalid case next to it, and is not a case itself.
        const fixture = join(root, ...parts).slice(0, -EXPECT.length) + ".json";
        expect(kind === "invalid" && existsSync(fixture), `${name}: no invalid case next to it`).toBe(true);
        continue;
      }
      const type = typeOf.get(key) ?? "";
      const bytes = readFileSync(join(root, ...parts));
      count++;
      if (kind === "valid") {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        const value = m.fn(`decode${type}FromJson`)(text);
        const encoded = m.fn(`encode${type}ToJson`)(value) as string;
        expect(JSON.parse(encoded), name).toEqual(JSON.parse(text));
        continue;
      }
      const want = expectation(join(root, ...parts).slice(0, -".json".length) + EXPECT);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        // Not UTF-8, which Rust and Go reject as invalid JSON at the root.
        expect(want, name).toEqual({ path: "", code: "invalid_json" });
        continue;
      }
      expect(errorFromJson(m, type, text), name).toEqual(want);
    }
    expect(count).toBeGreaterThan(5);
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

/** A model with nested objects, arrays and maps of objects, a tagged and an untagged union, and an exactly-one choice. */
const reportModel = (): Model =>
  libModel({
    note: closed({ text: { type: "string" } }, ["text"]),
    carrier: closed({ name: { type: "string" } }, ["name"]),
    courier: closed({ carrier: { $ref: "#/$defs/carrier" }, code: { type: "string" } }, ["carrier", "code"]),
    pickup: closed({ carrier: { $ref: "#/$defs/carrier" }, place: { type: "string" } }, ["carrier", "place"]),
    delivery: { oneOf: [{ $ref: "#/$defs/courier" }, { $ref: "#/$defs/pickup" }] },
    payment: {
      oneOf: [
        closed({ type: { const: "card" }, last4: { type: "string" } }, ["type", "last4"]),
        closed({ type: { const: "invoice" }, days: { type: "integer" } }, ["type", "days"]),
      ],
    },
    contact: {
      type: "object",
      properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
      required: ["name"],
      oneOf: [{ required: ["email"] }, { required: ["phone"] }],
      unevaluatedProperties: false,
    },
    order: closed(
      {
        id: { type: "string" },
        contact: { $ref: "#/$defs/contact" },
        notes: { type: "array", items: { $ref: "#/$defs/note" } },
        byTeam: { type: "object", additionalProperties: { $ref: "#/$defs/note" } },
        payment: { $ref: "#/$defs/payment" },
        delivery: { $ref: "#/$defs/delivery" },
      },
      ["id"],
    ),
  });

describe("TypeScript report mode", () => {
  const model = reportModel();
  let m: Loaded;
  let hooked: (readonly string[])[] = [];
  beforeAll(async () => {
    m = await load(model, { read: "report" });
  }, COMPILE_TIMEOUT);
  const report = (type: string, json: unknown, path?: string): unknown =>
    m.fn(`report${type}`)(json, ...(path === undefined ? [] : [path]));
  const reportText = (type: string, text: string): unknown => m.fn(`report${type}FromJson`)(text);

  it("leave strict output as it was when read is left out or strict", () => {
    expect(emitTypeScript(model, { read: "strict" })).toEqual(emitTypeScript(model));
    const out = emitTypeScript(model).map((f) => f.contents).join("\n");
    expect(out).not.toContain("h.report");
    expect(out).not.toContain("UnknownKeyHook");
  });

  it("export the hook, Reported and a report function per type", () => {
    const files = emitTypeScript(model, { read: "report" });
    const index = files.find((f) => f.name === "index.ts")?.contents ?? "";
    expect(index).toContain(
      "export { DecodeError, EncodeError, type DecodeResult, ErrorCode, type Reported, type UnknownKeyHook, setUnknownKeyHook } from \"./helpers.js\";\n",
    );
    const out = files[0]?.contents ?? "";
    expect(out).toContain('export function reportOrder(json: unknown, path = ""): h.Reported<Order> {\n');
    expect(out).toContain("export function reportOrderFromJson(text: string): h.Reported<Order> {\n");
  });

  it("accept unknown keys and return their paths, nested ones in input order", () => {
    const text =
      '{"z":1,"notes":[{"text":"a","pin":true},{"text":"b"}],"id":"o","contact":{"name":"n","nick":"x","email":"e"},' +
      '"byTeam":{"ops":{"text":"c","by":"me"}},"payment":{"type":"card","last4":"4242","net":"visa"},"a":2}';
    expect(reportText("Order", text)).toEqual({
      value: {
        id: "o",
        contact: { name: "n", email: "e" },
        notes: [{ text: "a" }, { text: "b" }],
        byTeam: { ops: { text: "c" } },
        payment: { type: "card", last4: "4242" },
      },
      unknown: ["/z", "/notes/0/pin", "/contact/nick", "/byTeam/ops/by", "/payment/net", "/a"],
    });
  });

  it("report only the keys of the untagged branch that decoded", () => {
    // The courier branch reads the carrier, noting its unknown key, then fails on the missing code.
    const delivery = { carrier: { name: "c", tel: "1" }, place: "p" };
    expect(report("Delivery", delivery)).toEqual({ value: { carrier: { name: "c" }, place: "p" }, unknown: ["/carrier/tel"] });
    expect(report("Order", { id: "o", delivery })).toMatchObject({ unknown: ["/delivery/carrier/tel"] });
  });

  it("treat the keys of another tagged branch as unknown", () => {
    expect(report("Payment", { type: "invoice", days: 3, last4: "1" })).toEqual({
      value: { type: "invoice", days: 3 },
      unknown: ["/last4"],
    });
  });

  it("still fail on a key a sibling branch of an exactly-one choice names", () => {
    expect(failure(m, "Contact", { name: "n", email: "e", phone: "p" })).toBe(
      "wrong type, expected Contact, found an object",
    );
    expect(report("Contact", { name: "n", phone: "p", fax: "f" })).toEqual({
      value: { name: "n", phone: "p" },
      unknown: ["/fax"],
    });
  });

  it("keep everything else strict", () => {
    expect(failure(m, "Order", { x: 1 })).toBe("/id: missing key");
    expect(failure(m, "Order", { id: 1, x: 1 })).toBe("/id: wrong type, expected a string, found 1");
    expect(failureFromJson(m, "Order", '{"id":"o","x":1,"x":2}')).toBe('/x: duplicate key, found "x" at offset 16');
    expect(failureFromJson(m, "Order", '{"id":"o","x":[1,]}')).toBe("/x/1: invalid JSON, found an invalid value at offset 17");
    expect(failure(m, "Payment", { type: "cash", x: 1 })).toBe(
      '/type: bad tag, expected one of "card", "invoice", found "cash"',
    );
  });

  it("put the paths under the path given, and escape them", () => {
    expect(report("Order", { id: "o", "a/b~c": 1 }, "/orders/0")).toMatchObject({ unknown: ["/orders/0/a~1b~0c"] });
  });

  it("give every decode's unknown keys to the hook, and only when there are some", () => {
    m.fn("setUnknownKeyHook")((paths: readonly string[]) => hooked.push(paths));
    try {
      hooked = [];
      expect(m.fn("decodeOrder")({ id: "o", x: 1, notes: [{ text: "t", y: 2 }] })).toEqual({ id: "o", notes: [{ text: "t" }] });
      expect(m.fn("decodeOrderFromJson")('{"id":"o","w":1}')).toEqual({ id: "o" });
      expect(m.fn("tryDecodeOrder")({ id: "o", v: 1 })).toEqual({ ok: true, value: { id: "o" } });
      expect(report("Order", { id: "o", u: 1 })).toMatchObject({ unknown: ["/u"] });
      m.fn("decodeOrder")({ id: "o" });
      expect(() => m.fn("decodeOrder")({ x: 1 })).toThrow(m.DecodeError);
      expect(hooked).toEqual([["/x", "/notes/0/y"], ["/w"], ["/v"], ["/u"]]);
    } finally {
      m.fn("setUnknownKeyHook")(undefined);
    }
    hooked = [];
    m.fn("decodeOrder")({ id: "o", x: 1 });
    expect(hooked).toEqual([]);
  });

  it("keep encoders strict", () => {
    expect(() => m.fn("encodeOrder")({ id: "o", x: 1 })).toThrow('unknown key "x"');
  });
});

/** The example generated in report mode, whose fixtures every language checks. */
const REPORT_EXAMPLE = join(import.meta.dirname, "..", "examples", "report");

/** Removes the key a JSON Pointer names from a parsed JSON value. */
function without(json: unknown, path: string): void {
  const segments = path
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  const key = segments.pop() ?? "";
  let holder = json as Record<string, unknown>;
  for (const segment of segments) holder = holder[segment] as Record<string, unknown>;
  expect(Object.hasOwn(holder, key), path).toBe(true);
  delete holder[key];
}

describe("TypeScript report example fixtures", () => {
  const config = loadConfig(join(REPORT_EXAMPLE, "strictgen.json"));
  const model = buildModel(loadSchemas(config.schemas), config.ids === undefined ? {} : { ids: config.ids });
  const root = join(REPORT_EXAMPLE, "fixtures");
  const fixtures = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".json") ? [path] : [];
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
    expect(config.targets.typescript?.read).toBe("report");
    m = await load(model, { read: "report" });
  }, COMPILE_TIMEOUT);

  it("decode every valid fixture with the unknown paths it expects, and reject every invalid one", () => {
    const hooked: (readonly string[])[] = [];
    m.fn("setUnknownKeyHook")((paths: readonly string[]) => hooked.push(paths));
    let count = 0;
    try {
      for (const parts of fixtures) {
        const key = parts.slice(0, -2).join("/");
        const name = parts.join("/");
        const kind = parts.at(-2);
        expect(parts.length >= 3 && (kind === "valid" || kind === "invalid"), name).toBe(true);
        expect(typeOf.has(key), `${name}: no generated type for ${key}`).toBe(true);
        if (name.endsWith(EXPECT)) {
          const fixture = join(root, ...parts).slice(0, -EXPECT.length) + ".json";
          expect(existsSync(fixture), `${name}: no case next to it`).toBe(true);
          continue;
        }
        count++;
        const type = typeOf.get(key) ?? "";
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(join(root, ...parts)));
        const file = join(root, ...parts).slice(0, -".json".length) + EXPECT;
        expect(existsSync(file), `every case needs ${file}`).toBe(true);
        const want = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        hooked.length = 0;
        if (kind === "invalid") {
          expect(Object.keys(want).sort(), name).toEqual(["code", "path"]);
          expect(errorFromJson(m, type, text), name).toEqual(want);
          expect(hooked, name).toEqual([]);
          continue;
        }
        expect(Object.keys(want), name).toEqual(["unknown"]);
        const { value, unknown } = m.fn(`report${type}FromJson`)(text) as { value: unknown; unknown: string[] };
        expect(unknown, name).toEqual(want.unknown);
        expect(hooked, name).toEqual(unknown.length === 0 ? [] : [unknown]);
        // The value holds everything but the unknown keys.
        const expected: unknown = JSON.parse(text);
        for (const path of unknown) without(expected, path);
        expect(JSON.parse(m.fn(`encode${type}ToJson`)(value) as string), name).toEqual(expected);
      }
    } finally {
      m.fn("setUnknownKeyHook")(undefined);
    }
    expect(count).toBeGreaterThan(5);
  });
});

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
  }, COMPILE_TIMEOUT);

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
      '  h.member(out, value, "content-type", h.encodeString, true);\n',
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
    for (const name of ["decodeError", "encodeError", "decodeResult", "reported", "unknownKeyHook"]) {
      expect(() => lib({ [name]: { type: "string" } })).toThrow("is reserved in TypeScript");
    }
  });
});
