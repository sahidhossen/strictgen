import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import type { EmittedFile } from "./common.js";
import { loadConfig } from "./config.js";
import { emitGo } from "./emit-go.js";
import { emitRust } from "./emit-rust.js";
import type { TypeScriptOptions } from "./emit-ts.js";
import { emitTypeScript } from "./emit-ts.js";
import { configModel } from "./examples.js";
import { llmProfiles } from "./llm.js";
import type { LlmMaps } from "./llm-decoders.js";
import { goLlmName, llmMaps, rustLlmName, snake, tsLlmName } from "./llm-decoders.js";
import { builtinProfile } from "./profile-files.js";
import { projectType } from "./llm-project.js";
import type { Model } from "./model.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

function model(files: Readonly<Record<string, JsonObject>>): Model {
  const set = schemaSet(
    Object.fromEntries(Object.entries(files).map(([name, root]) => [name, { $id: `${BASE}${name}.json`, ...root }])),
  );
  return buildModel(set);
}

/** An order with an optional field of every kind the projection changes, from neutral data. */
const ORDER: JsonObject = {
  title: "Order",
  type: "object",
  properties: {
    id: { type: "string", minLength: 2 },
    note: { type: "string", maxLength: 5 },
    labels: {
      type: "object",
      propertyNames: { type: "string", maxLength: 3 },
      additionalProperties: { type: "integer", minimum: 0 },
      maxProperties: 2,
    },
    payment: { $ref: "#/$defs/payment" },
    contact: { $ref: "#/$defs/contact" },
  },
  required: ["id"],
  additionalProperties: false,
  $defs: {
    payment: { oneOf: [{ $ref: "#/$defs/card" }, { $ref: "#/$defs/wire" }] },
    card: {
      type: "object",
      properties: { kind: { const: "card" }, last4: { type: "string" } },
      required: ["kind", "last4"],
      unevaluatedProperties: false,
    },
    wire: {
      type: "object",
      properties: { kind: { const: "wire" }, iban: { type: "string" } },
      required: ["kind"],
      unevaluatedProperties: false,
    },
    contact: { oneOf: [{ type: "string" }, { type: "integer", minimum: 100 }] },
    status: { enum: ["open", "paid"] },
    sizes: { type: "object", additionalProperties: { type: "integer" } },
  },
};

const BOTH: LlmMaps = { entries: true, objects: true };
const ENTRIES: LlmMaps = { entries: true, objects: false };
const OBJECTS: LlmMaps = { entries: false, objects: true };

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

type Decode = (text: string) => unknown;

/** The generated TypeScript, typechecked under {@link STRICT} and loaded, by function name. */
async function load(files: readonly EmittedFile[]): Promise<(name: string) => Decode> {
  const dir = mkdtempSync(join(tmpdir(), "strictgen-llm-"));
  folders.push(dir);
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  for (const f of files) writeFileSync(join(dir, f.name), f.contents);
  const program = ts.createProgram(
    files.map((f) => join(dir, f.name)),
    STRICT,
  );
  const problems = ts.getPreEmitDiagnostics(program).map((d) => {
    const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file === undefined || d.start === undefined) return text;
    return `${relative(dir, d.file.fileName)}:${String(d.file.getLineAndCharacterOfPosition(d.start).line + 1)}: ${text}`;
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
    if (typeof fn !== "function") throw new Error(`no function ${name}`);
    return fn as Decode;
  };
}

/** The compact error of a decode, or the value as JSON when it decodes. */
function outcome(decode: Decode, text: string): string {
  try {
    return `ok ${JSON.stringify(decode(text))}`;
  } catch (error) {
    const compact = (error as { compact?: () => string }).compact;
    if (compact === undefined) throw error;
    return compact.call(error);
  }
}

const COMPILE_TIMEOUT = 60_000;

/** Names only the LLM parts of the output have. */
const LLM_WORDS = /FromLlm|fromLlm|from_llm|decodeLlm|LLM_|llmMaps|llmEntries|in_llm|attemptText|unwrapped/;

describe("LLM decoder names", () => {
  it("follow each language's style", () => {
    expect(tsLlmName("OrderRequest")).toBe("decodeOrderRequestFromLlm");
    expect(goLlmName("OrderRequest")).toBe("DecodeOrderRequestFromLlm");
    expect(rustLlmName("OrderRequest")).toBe("decode_order_request_from_llm");
    expect(snake("HTTPServer")).toBe("http_server");
    expect(snake("Line2Item")).toBe("line2_item");
    expect(snake("A")).toBe("a");
  });

  const clash = model({
    order: { title: "Order", type: "object", properties: {}, additionalProperties: false },
    orderFromLlm: { title: "OrderFromLlm", type: "object", properties: {}, additionalProperties: false },
  });

  it("fail in TypeScript when another type's functions have the name", () => {
    expect(() => emitTypeScript(clash)).not.toThrow();
    expect(() => emitTypeScript(clash, { llm: BOTH })).toThrow(
      "name-clash: the TypeScript LLM decoder decodeOrderFromLlm of type Order has the name of a name generated for type OrderFromLlm",
    );
  });

  it("fail in Go when a type has the name", () => {
    const go = model({
      order: { title: "Order", type: "object", properties: {}, additionalProperties: false },
      other: { title: "DecodeOrderFromLlm", enum: ["a"] },
    });
    expect(() => emitGo(go)).not.toThrow();
    expect(() => emitGo(go, { llm: BOTH })).toThrow("name-clash: Go name DecodeOrderFromLlm is also used by");
  });

  it("fail in Rust when two types have the same snake case name", () => {
    const rust = model({
      a: { title: "OrderId", type: "object", properties: {}, additionalProperties: false },
      b: { title: "OrderID", type: "object", properties: {}, additionalProperties: false },
    });
    expect(() => emitRust(rust)).not.toThrow();
    expect(() => emitRust(rust, { llm: BOTH })).toThrow("name-clash: the Rust LLM decoder decode_order_id_from_llm");
  });
});

describe("LLM decoders are emitted only with llm", () => {
  const m = model({ order: ORDER });
  const text = (files: readonly EmittedFile[]): string => files.map((f) => f.contents).join("\n");

  it("in TypeScript, for every schema root and $defs entry, and never without the decoders", () => {
    expect(text(emitTypeScript(m))).not.toContain("FromLlm");
    expect(text(emitTypeScript(m))).not.toContain("fromLlm");
    const out = text(emitTypeScript(m, { llm: BOTH }));
    for (const type of ["Order", "Payment", "Card", "Wire", "Contact", "Status", "Sizes"]) {
      expect(out).toContain(`export function decode${type}FromLlm(text: string): ${type} {`);
      expect(out).toContain(`export function tryDecode${type}FromLlm(text: string): h.DecodeResult<${type}> {`);
    }
    // A hoisted type has no schema of its own, so no LLM decoder.
    expect(out).not.toContain("decodeOrderLabelsFromLlm");
    expect(text(emitTypeScript(m, { llm: BOTH, decoders: false }))).not.toContain("FromLlm");
  });

  it("in Go and Rust, with untagged variants run through attempt", () => {
    expect(text(emitGo(m))).not.toContain("FromLlm");
    expect(text(emitGo(m))).not.toContain("decodeLlm");
    expect(text(emitGo(m, { llm: ENTRIES }))).toContain("func DecodeOrderFromLlm(data []byte) (Order, error) {");
    expect(text(emitGo(m, { llm: ENTRIES }))).toContain("func DecodeStatusFromLlm(data []byte) (Status, error) {\n\treturn decodeLlm(data, true, decodeType[Status])\n}");
    expect(text(emitRust(m))).not.toContain("from_llm");
    expect(text(emitRust(m))).not.toContain("helpers::attempt(");
    const rust = text(emitRust(m, { llm: ENTRIES, cleanup: true }));
    expect(rust).toContain("pub fn decode_order_from_llm(text: &str) -> Result<Order, helpers::DecodeError> {");
    expect(rust).toContain("helpers::from_llm(&helpers::clean_llm_json(text), false)");
    expect(rust).toContain("helpers::attempt(||");
  });

  it("leave the helpers without llm as they were", () => {
    for (const read of ["strict", "report"] as const) {
      expect(text(emitTypeScript(m, { read }))).not.toMatch(LLM_WORDS);
      expect(text(emitGo(m, { read }))).not.toMatch(LLM_WORDS);
      expect(text(emitRust(m, { read }))).not.toMatch(LLM_WORDS);
    }
  });

  it("change the report mode helpers so an LLM decode notes no unknown key", () => {
    const go = text(emitGo(m, { read: "report", llm: BOTH }));
    expect(go).toContain("if n.doc == nil || n.doc.llm != 0 || slices.Contains(forbidden, key) {");
    expect(go).toContain("n.doc.entries = n.doc.entries[:entries]");
    const rust = text(emitRust(m, { read: "report", llm: BOTH }));
    expect(rust).toContain("offsets.truncate(mark);");
    expect(rust).toContain("state.entries.truncate(entries);");
    expect(rust).toContain("object.finish(&[])?;");
    const ts = text(emitTypeScript(m, { read: "report", llm: BOTH }));
    expect(ts).toContain("if (unknown !== undefined || llm !== 0) return read(json, path);");
  });
});

describe("TypeScript LLM decoders", () => {
  const m = model({ order: ORDER });
  const full = (labels: string): string =>
    `{"id":"ab","note":null,"labels":${labels},"payment":null,"contact":null}`;

  it(
    "read null as absent, maps in the profiles' shapes, and check every constraint",
    async () => {
      const both = await load(emitTypeScript(m, { llm: BOTH }));
      const order = both("decodeOrderFromLlm");
      expect(outcome(order, full("null"))).toBe('ok {"id":"ab"}');
      expect(outcome(order, full('[{"key":"a","value":1}]'))).toBe('ok {"id":"ab","labels":{"a":1}}');
      expect(outcome(order, full('{"a":1}'))).toBe('ok {"id":"ab","labels":{"a":1}}');
      expect(outcome(order, full('"a"'))).toBe('/labels wrong_type, expected an array or an object, found "a"');
      expect(outcome(order, full('[{"key":"a","value":1},{"key":"a","value":2}]'))).toBe('/labels/1/key duplicate_key, found "a"');
      // A key given twice is a structure error, so it comes before the count.
      expect(outcome(order, full('[{"key":"a","value":1},{"key":"b","value":1},{"key":"a","value":2}]'))).toBe(
        '/labels/2/key duplicate_key, found "a"',
      );
      expect(outcome(order, full('[{"key":"a","value":1},{"key":"b","value":1},{"key":"c","value":2}]'))).toBe(
        "/labels too_long, expected at most 2 keys, found 3 keys",
      );
      // Keys are checked in code point order, like the keys of a map, each key before its value.
      expect(outcome(order, full('[{"key":"z","value":-1},{"key":"long","value":1}]'))).toBe(
        "/labels/1/key too_long, expected at most 3 characters, found 4 characters",
      );
      expect(outcome(order, full('[{"key":"z","value":-1},{"key":"y","value":-2}]'))).toBe(
        "/labels/1/value too_small, expected >= 0, found -2",
      );
      expect(outcome(order, full('[{"value":1,"key":"a","x":0}]'))).toBe("/labels/0/x unknown_key");
      expect(outcome(order, full('[{"value":1}]'))).toBe("/labels/0/key missing_key");
      expect(outcome(order, '{"id":null}')).toBe("/id null_not_allowed, expected a string");
      expect(outcome(order, '{"id":"ab","extra":1}')).toBe("/extra unknown_key");
      // A structure error anywhere comes before a constraint, as in the normal decoders.
      expect(outcome(order, '{"id":"a","labels":[{"key":"a"}]}')).toBe("/labels/0/value missing_key");
      expect(outcome(order, '{"id":"a"}')).toBe("/id too_short, expected at least 2 characters, found 1 character");
      expect(outcome(order, '{"id":"ab","payment":{"kind":"wire","iban":null}}')).toBe('ok {"id":"ab","payment":{"kind":"wire"}}');
      expect(outcome(order, '{"id":"ab","contact":99}')).toBe("/contact too_small, expected >= 100, found 99");
      const status = both("decodeStatusFromLlm");
      expect(outcome(status, '{"value":"paid"}')).toBe('ok "paid"');
      expect(outcome(status, '"paid"')).toBe('wrong_type, expected an object, found "paid"');
      expect(outcome(status, "{}")).toBe("/value missing_key");
      expect(outcome(status, '{"value":"paid","x":1}')).toBe("/x unknown_key");
      expect(outcome(status, '{"x":1,"value":"new"}')).toBe('/value not_in_enum, expected one of "open", "paid", found "new"');
      expect(outcome(both("decodeSizesFromLlm"), '{"value":[{"key":"s","value":1}]}')).toBe('ok {"s":1}');
      // The normal decoders still take null for nothing.
      expect(outcome(both("decodeOrderFromJson"), '{"id":"ab","note":null}')).toBe("/note null_not_allowed, expected a string");
      expect(outcome(both("decodeOrderFromJson"), '{"id":"ab","labels":[]}')).toBe("/labels wrong_type, expected an object, found an array");
    },
    COMPILE_TIMEOUT,
  );

  it(
    "read only the map shape the profiles give",
    async () => {
      const entries = await load(emitTypeScript(m, { llm: ENTRIES }));
      expect(outcome(entries("decodeOrderFromLlm"), full('{"a":1}'))).toBe("/labels wrong_type, expected an array, found an object");
      const objects = await load(emitTypeScript(m, { llm: OBJECTS }));
      expect(outcome(objects("decodeOrderFromLlm"), full('[{"key":"a","value":1}]'))).toBe(
        "/labels wrong_type, expected an object, found an array",
      );
      expect(outcome(objects("decodeOrderFromLlm"), full('{"a/b":1,"c":-1}'))).toBe("/labels/c too_small, expected >= 0, found -1");
    },
    COMPILE_TIMEOUT,
  );

  it(
    "are strict in report mode, and run the cleanup step only when it is on",
    async () => {
      const report = await load(emitTypeScript(m, { llm: BOTH, read: "report" }));
      expect(outcome(report("decodeOrderFromLlm"), '{"id":"ab","extra":1}')).toBe("/extra unknown_key");
      expect(outcome(report("decodeOrderFromJson"), '{"id":"ab","extra":1}')).toBe('ok {"id":"ab"}');
      const fenced = '```json\n{"id":"ab",}\n```';
      expect(outcome(report("decodeOrderFromLlm"), fenced)).toMatch(/^invalid_json/);
      const clean = await load(emitTypeScript(m, { llm: BOTH, cleanup: true }));
      expect(outcome(clean("decodeOrderFromLlm"), fenced)).toBe('ok {"id":"ab"}');
      // The cleanup step never runs in the normal decoders.
      expect(outcome(clean("decodeOrderFromJson"), fenced)).toMatch(/^invalid_json/);
    },
    COMPILE_TIMEOUT,
  );
});

describe("the LLM state of the TypeScript helpers", () => {
  const m = model({ order: ORDER });

  it(
    "ends with a decode that throws, so the next normal decode takes null for nothing again",
    async () => {
      const fn = await load(emitTypeScript(m, { llm: BOTH }));
      const llm = fn("decodeOrderFromLlm");
      const normal = fn("decodeOrderFromJson");
      // Each throws while the LLM decode runs: a wrong type deep in the value, a broken entry, a
      // constraint after the structure decoded.
      for (const text of [
        '{"id":"ab","note":null,"labels":null,"payment":{"kind":"card","last4":5},"contact":null}',
        '{"id":"ab","labels":[{"key":"a"}]}',
        '{"id":"a","note":null}',
      ]) {
        expect(() => llm(text)).toThrow();
        expect(outcome(normal, '{"id":"ab","note":null}')).toBe("/note null_not_allowed, expected a string");
        expect(outcome(normal, '{"id":"ab","labels":[]}')).toBe("/labels wrong_type, expected an object, found an array");
        expect(outcome(llm, '{"id":"ab","note":null}')).toBe('ok {"id":"ab"}');
      }
      // A throw that isn't a DecodeError ends it too: a value that isn't text.
      expect(() => llm(undefined as unknown as string)).toThrow();
      expect(outcome(normal, '{"id":"ab","note":null}')).toBe("/note null_not_allowed, expected a string");
    },
    COMPILE_TIMEOUT,
  );
});

describe("the llm option", () => {
  const m = model({ order: ORDER });
  const none: LlmMaps = { entries: false, objects: false };

  it("fails in every emitter when it reads maps in no shape", () => {
    const message = "the llm option needs a map shape: entries, objects or both";
    expect(() => emitTypeScript(m, { llm: none })).toThrow(message);
    expect(() => emitGo(m, { llm: none })).toThrow(message);
    expect(() => emitRust(m, { llm: none })).toThrow(message);
    expect(() => emitTypeScript(m, { llm: none, read: "report", cleanup: true })).toThrow(message);
    for (const maps of [BOTH, ENTRIES, OBJECTS]) {
      expect(() => emitTypeScript(m, { llm: maps })).not.toThrow();
      expect(() => emitGo(m, { llm: maps })).not.toThrow();
      expect(() => emitRust(m, { llm: maps })).not.toThrow();
    }
  });
});

describe("the shared LLM vectors in report mode", () => {
  it(
    "decode the same in TypeScript, since LLM decoders are strict in every read mode",
    async () => {
      const config = loadConfig(fileURLToPath(new URL("../examples/llm/strictgen.json", import.meta.url)));
      if (config.llm === undefined) throw new Error("the example configures llm");
      const { model: example } = configModel(config);
      const options: TypeScriptOptions = { read: "report", cleanup: true, llm: llmMaps(llmProfiles(config, config.llm)) };
      const fn = await load(emitTypeScript(example, options));
      const vectors = JSON.parse(
        readFileSync(new URL("../examples/llm/llm-vectors.json", import.meta.url), "utf8"),
      ) as { name: string; type: string; llm: string; json?: string; error?: string }[];
      expect(vectors.length).toBeGreaterThan(1000);
      for (const v of vectors) {
        const got = outcome(fn(`decode${v.type}FromLlm`), v.llm);
        if (v.error !== undefined) {
          expect(got, v.name).toBe(v.error);
        } else {
          const value = fn(`decode${v.type}FromLlm`)(v.llm);
          const encode = fn(`encode${v.type}ToJson`) as unknown as (value: unknown) => string;
          expect(encode(value), v.name).toBe(encode(fn(`decode${v.type}FromJson`)(v.json ?? "")));
        }
      }
    },
    COMPILE_TIMEOUT,
  );
});

describe("projection of an untagged union with a map beside an array", () => {
  const m = model({
    either: {
      title: "Either",
      oneOf: [
        { type: "array", items: { type: "string" } },
        { type: "object", additionalProperties: { type: "string" } },
      ],
    },
  });

  it("fails for a profile that gives maps as entries, since both are arrays then", () => {
    expect(() => projectType(m, "Either", builtinProfile("openai"))).toThrow(
      "llm-unsupported: profile openai: Either has a map beside an array, and the profile gives a map as an array of entries, so a decoder couldn't tell them apart",
    );
    expect(() => projectType(m, "Either", builtinProfile("gemini"))).not.toThrow();
  });

  it("is fine for a map beside a scalar or an object", () => {
    const fine = model({
      maps: {
        title: "Maps",
        oneOf: [
          { type: "object", additionalProperties: { type: "integer" } },
          { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false },
          { type: "string" },
        ],
      },
    });
    expect(() => projectType(fine, "Maps", builtinProfile("openai"))).not.toThrow();
  });
});
