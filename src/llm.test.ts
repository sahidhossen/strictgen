import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { ConfigError } from "./config.js";
import { emitGo } from "./emit-go.js";
import { emitRust } from "./emit-rust.js";
import { emitTypeScript } from "./emit-ts.js";
import { emitLlm } from "./llm.js";
import type { Profile } from "./llm-profile.js";
import { BUILTIN_PROFILES, parseProfile } from "./llm-profile.js";
import { builtinProfile, builtinProfileFile, configProfiles } from "./profile-files.js";
import { changeLines, describe as describeText, projectedTypes, projectType, schemaText } from "./llm-project.js";
import type { Model } from "./model.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from "./run.js";
import type { JsonObject } from "./schema.js";
import { CodegenError, schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

const PROFILE_SCHEMA = JSON.parse(
  readFileSync(new URL("../profiles/profile.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const validProfile = new Ajv2020({ strict: true, allErrors: true }).compile(PROFILE_SCHEMA);

function model(files: Readonly<Record<string, JsonObject>>): Model {
  const set = schemaSet(
    Object.fromEntries(Object.entries(files).map(([name, root]) => [name, { $id: `${BASE}${name}.json`, ...root }])),
  );
  return buildModel(set);
}

/** A schema set with every construct a projection handles, from neutral order data. */
const SHOP: Readonly<Record<string, JsonObject>> = {
  order: {
    title: "Order",
    description: "An order",
    type: "object",
    properties: {
      id: { description: "The order ID.", type: "string", minLength: 4, maxLength: 12 },
      version: { description: "The format version.", type: "integer", const: 2 },
      status: { $ref: `${BASE}status.json` },
      total: { description: "The total.", type: "number", minimum: 0, exclusiveMaximum: 100000 },
      count: { type: "integer", exclusiveMinimum: 0, maximum: 50, multipleOf: 5 },
      note: { description: "A note.", type: "string", maxLength: 80 },
      code: { type: "string", pattern: "^[A-Z]{3}$" },
      placedAt: { type: "string", format: "date-time" },
      placedOn: { type: "string", format: "date" },
      reference: { type: "string", format: "uuid" },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, uniqueItems: true },
      lines: { type: "array", items: { $ref: "#/$defs/line" }, minItems: 2 },
      payment: { $ref: "#/$defs/payment" },
      contact: { $ref: "#/$defs/contact" },
      labels: {
        type: "object",
        propertyNames: { type: "string", maxLength: 8 },
        additionalProperties: { type: "string" },
        minProperties: 1,
        maxProperties: 3,
      },
      sizes: {
        type: "object",
        propertyNames: { enum: ["s", "m", "l"] },
        additionalProperties: { type: "integer" },
      },
      gift: { type: "boolean" },
    },
    required: ["id", "version", "status", "total", "lines", "payment"],
    additionalProperties: false,
    $defs: {
      line: {
        description: "One line",
        type: "object",
        properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1 } },
        required: ["sku", "quantity"],
        additionalProperties: false,
      },
      payment: {
        description: "How it is paid.",
        oneOf: [{ $ref: "#/$defs/card" }, { $ref: "#/$defs/wire" }],
      },
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
      contact: {
        description: "An email address or a phone extension.",
        oneOf: [{ type: "string" }, { type: "integer", minimum: 100 }],
      },
    },
  },
  status: { title: "Status", description: "Where the order is.", enum: ["open", "paid", "shipped"] },
  category: {
    title: "Category",
    description: "A category with sub categories.",
    type: "object",
    properties: {
      name: { type: "string" },
      children: { type: "array", items: { $ref: "#" } },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const PROFILES = BUILTIN_PROFILES.map((name) => builtinProfile(name));

/** What a profile gives for one type: the schema and its changes, or the error. */
function outcome(m: Model, type: string, profile: Profile): { file: string; text: string } {
  try {
    const projection = projectType(m, type, profile);
    return { file: `${type}.json`, text: `${schemaText(projection.schema)}\n${changeLines(projection).join("\n")}\n` };
  } catch (error) {
    if (!(error instanceof CodegenError)) throw error;
    return { file: `${type}.error.txt`, text: `${error.message}\n` };
  }
}

describe("LLM profiles", () => {
  it.each(BUILTIN_PROFILES)("ships %s, valid against profiles/profile.schema.json", (name) => {
    const raw = JSON.parse(readFileSync(builtinProfileFile(name), "utf8")) as unknown;
    expect(validProfile(raw), JSON.stringify(validProfile.errors)).toBe(true);
    const profile = builtinProfile(name);
    expect(profile.name).toBe(name);
    expect(profile.sources.length).toBeGreaterThan(0);
    for (const source of profile.sources) expect(source.url).toMatch(/^https:\/\//);
  });

  const good = JSON.parse(readFileSync(builtinProfileFile("openai"), "utf8")) as Record<string, unknown>;
  const INVALID: readonly (readonly [string, unknown, string, string])[] = [
    ["not an object", [], "", "must be a JSON object"],
    ["an unknown option", { ...good, extra: 1 }, "extra", "unknown option"],
    ["no name", { ...good, name: undefined }, "name", "is required"],
    ["a bad name", { ...good, name: "Open AI" }, "name", "is not a profile name"],
    ["a version of 0", { ...good, version: 0 }, "version", "at least 1"],
    ["a fractional version", { ...good, version: 1.5 }, "version", "must be an integer"],
    ["a bad date", { ...good, date: "06.11.2026" }, "date", "is not a date"],
    ["no source", { ...good, sources: [] }, "sources", "at least one"],
    ["a source over http", { ...good, sources: [{ url: "http://example.com", checked: "2026-01-01" }] }, "sources[0].url", "an https URL"],
    ["a source without a date", { ...good, sources: [{ url: "https://example.com" }] }, "sources[0].checked", "is required"],
    ["an unknown keyword", { ...good, keywords: ["minLength", "contains"] }, "keywords[1]", "must be one of"],
    ["a keyword twice", { ...good, keywords: ["const", "const"] }, "keywords[1]", "listed twice"],
    ["an unknown format", { ...good, formats: ["email"] }, "formats[0]", "must be one of"],
    ["a maximum on an unbounded keyword", { ...good, keywordMaximums: { pattern: 1 } }, "keywordMaximums.pattern", "unknown option"],
    ["a negative maximum", { ...good, keywordMaximums: { minItems: -1 } }, "keywordMaximums.minItems", "at least 0"],
    ["an unknown map form", { ...good, maps: "pairs" }, "maps", "must be"],
    ["recursion as a string", { ...good, recursion: "yes" }, "recursion", "true or false"],
    ["an unknown limit", { ...good, limits: { maxWidth: 3 } }, "limits.maxWidth", "unknown option"],
    ["a depth of 0", { ...good, limits: { maxDepth: 0 } }, "limits.maxDepth", "at least 1"],
    ["a large enum without its size", { ...good, limits: { largeEnum: { values: 3 } } }, "limits.largeEnum.maxSize", "is required"],
  ];

  it.each(INVALID)("rejects %s, as the profile schema does", (_, value, option, problem) => {
    const raw = JSON.parse(JSON.stringify(value)) as unknown;
    let error: unknown;
    try {
      parseProfile(raw, "local.json");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).option).toBe(option);
    expect((error as ConfigError).problem).toContain(problem);
    expect(validProfile(raw)).toBe(false);
  });

  it("fails cleanly on a missing, unreadable or broken profile file, and on two of one name", () => {
    const dir = mkdtempSync(join(tmpdir(), "strictgen-profile-"));
    try {
      writeFileSync(join(dir, "broken.json"), "{");
      writeFileSync(join(dir, "openai.json"), JSON.stringify(good));
      mkdirSync(join(dir, "folder.json"));
      const message = (refs: Parameters<typeof configProfiles>[0]): string => {
        try {
          configProfiles(refs, "strictgen.json");
        } catch (error) {
          if (error instanceof ConfigError) return error.message;
          throw error;
        }
        return "no error";
      };
      expect(message([{ file: join(dir, "none.json"), shown: "none.json" }])).toBe("none.json: profile file not found");
      expect(message([{ file: join(dir, "broken.json"), shown: "broken.json" }])).toMatch(/^broken\.json: not valid JSON/);
      expect(message([{ file: join(dir, "folder.json"), shown: "folder.json" }])).toMatch(/^folder\.json: can't read it/);
      expect(message([{ name: "nope" }])).toMatch(/no built in profile "nope"/);
      expect(message([{ name: "openai" }, { file: join(dir, "openai.json"), shown: "openai.json" }])).toBe(
        "strictgen.json: llm.profiles[1]: names the profile openai, which llm.profiles[0] names too",
      );
      // A profile file replaces the built in one of its name when only it is listed.
      const [local] = configProfiles([{ file: join(dir, "openai.json"), shown: "openai.json" }], "strictgen.json");
      expect(local?.name).toBe("openai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("projection snapshots, per profile", () => {
  const m = model(SHOP);
  const types = projectedTypes(m).map((d) => d.name);

  it("covers the types of the snapshot set", () => {
    expect(types).toEqual(["Card", "Category", "Contact", "Line", "Order", "Payment", "Status", "Wire"]);
  });

  for (const profile of PROFILES) {
    it(`matches the committed ${profile.name} snapshots`, async () => {
      for (const type of types) {
        const { file, text } = outcome(m, type, profile);
        await expect(text).toMatchFileSnapshot(`__snapshots__/llm/${profile.name}/${file}`);
      }
      // No stale snapshot of a type that now projects differently, or no longer exists.
      const dir = join(import.meta.dirname, "__snapshots__", "llm", profile.name);
      mkdirSync(dir, { recursive: true });
      const expected = types.map((t) => outcome(m, t, profile).file).sort();
      expect(readdirSync(dir).sort()).toEqual(expected);
    });
  }

  it("is deterministic: the same model projects to the same bytes", () => {
    for (const profile of PROFILES) {
      for (const type of types) expect(outcome(model(SHOP), type, profile)).toEqual(outcome(m, type, profile));
    }
  });
});

describe("projection rules", () => {
  const m = model(SHOP);
  const openai = builtinProfile("openai");
  const anthropic = builtinProfile("anthropic");
  const gemini = builtinProfile("gemini");
  const props = (schema: JsonObject): Record<string, JsonObject> => schema.properties as Record<string, JsonObject>;

  it("makes every field required, and optional ones nullable", () => {
    const { schema, changes } = projectType(m, "Order", openai);
    expect(schema.required).toEqual(Object.keys(props(schema)));
    expect(schema.additionalProperties).toBe(false);
    expect(props(schema).note).toEqual({
      description: "A note. At most 80 characters.",
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    const nullable = changes.filter((c) => c.kind === "nullable").map((c) => c.field);
    expect(nullable).toEqual(["code", "contact", "count", "gift", "labels", "note", "iban", "placedAt", "placedOn", "reference", "sizes", "tags"]);
  });

  it("turns a tagged union into anyOf of its branches, each with a const tag, and records the tags", () => {
    const { schema, changes } = projectType(m, "Order", openai);
    const payment = props(schema).payment as { anyOf: JsonObject[] };
    expect(payment.anyOf.map((b) => props(b).kind)).toEqual([
      { type: "string", const: "card" },
      { type: "string", const: "wire" },
    ]);
    expect(changes.find((c) => c.kind === "union")).toMatchObject({
      pointer: "/properties/payment",
      type: "Payment",
      tag: "kind",
      branches: { card: "Card", wire: "Wire" },
    });
    // Without const, a one value enum.
    const geminiPayment = props(projectType(m, "Order", gemini).schema).payment as { anyOf: JsonObject[] };
    expect(props(geminiPayment.anyOf[0] ?? {}).kind).toEqual({ type: "string", enum: ["card"] });
  });

  it("adds null as one more branch of a nullable union, never a nested anyOf", () => {
    const contact = props(projectType(m, "Order", openai).schema).contact as { anyOf: JsonObject[] };
    expect(contact.anyOf.map((b) => b.type)).toEqual(["string", "integer", "null"]);
  });

  it("drops what the profile can't take, with a hint and a change for each", () => {
    const { schema, changes } = projectType(m, "Order", anthropic);
    expect(props(schema).id).toEqual({
      description: "The order ID. At least 4 characters, at most 12 characters.",
      type: "string",
    });
    expect(changes.filter((c) => c.pointer === "/properties/id")).toEqual([
      { kind: "dropped", pointer: "/properties/id", type: "Order", field: "id", keyword: "minLength", value: 4, text: "minLength 4: at least 4 characters" },
      { kind: "dropped", pointer: "/properties/id", type: "Order", field: "id", keyword: "maxLength", value: 12, text: "maxLength 12: at most 12 characters" },
    ]);
    // openai keeps the bounds and the format, but not the lengths.
    const total = props(projectType(m, "Order", openai).schema).total;
    expect(total).toEqual({ description: "The total.", type: "number", minimum: 0, exclusiveMaximum: 100000 });
  });

  it("keeps a bounded keyword only up to the profile's maximum", () => {
    const { schema } = projectType(m, "Order", anthropic);
    const lines = props(schema).lines as JsonObject;
    expect(lines.minItems).toBeUndefined();
    expect(lines.description).toBe("At least 2 items.");
    const tags = (props(schema).tags as { anyOf: JsonObject[] }).anyOf[0] ?? {};
    expect(tags.minItems).toBe(1);
  });

  it("writes a map as entries, or as an object for a profile that takes one", () => {
    const entries = props(projectType(m, "Order", openai).schema).labels as { anyOf: JsonObject[] };
    expect(entries.anyOf[0]).toMatchObject({
      type: "array",
      items: { type: "object", required: ["key", "value"], additionalProperties: false },
      minItems: 1,
      maxItems: 3,
    });
    const object = props(projectType(m, "Order", gemini).schema).sizes as JsonObject;
    expect(object).toEqual({
      description: 'Each key one of "s", "m", "l".',
      anyOf: [{ type: "object", additionalProperties: { type: "integer" } }, { type: "null" }],
    });
  });

  it("wraps a root that isn't an object as { value }", () => {
    const { schema, changes } = projectType(m, "Status", openai);
    expect(schema).toEqual({
      type: "object",
      properties: { value: { description: "Where the order is.", type: "string", enum: ["open", "paid", "shipped"] } },
      required: ["value"],
      additionalProperties: false,
    });
    expect(changes[0]).toMatchObject({ kind: "wrapped", pointer: "" });
  });

  /** openai with other limits, under another name. */
  const limited = (limits: Record<string, unknown>): Profile => ({
    ...parseProfile({ ...JSON.parse(readFileSync(builtinProfileFile("openai"), "utf8")), limits }, "limited.json"),
    name: "limited",
  });

  it("puts a recursive type in $defs for a profile with recursion and no depth limit", () => {
    const { schema } = projectType(m, "Category", limited({}));
    expect(Object.keys(schema.$defs as JsonObject)).toEqual(["Category"]);
    expect(JSON.stringify(schema)).toContain('"$ref":"#/$defs/Category"');
    expect(() => projectType(m, "Category", anthropic)).toThrow(
      "category.json#: llm-unsupported: profile anthropic: Category contains itself, and the profile accepts no recursive schema",
    );
  });

  it("fails a recursive type for a profile with a depth limit, since its nesting has no bound", () => {
    expect(() => projectType(m, "Category", openai)).toThrow(
      "category.json#: llm-limit: the openai schema for Category is recursive at " +
        "/$defs/Category/properties/children/anyOf/0/items, so its nesting has no bound, and the profile allows a depth of at most 10",
    );
  });

  const forest = model({
    category: SHOP.category ?? {},
    shelf: {
      title: "Shelf",
      type: "object",
      properties: { left: { $ref: `${BASE}category.json` }, right: { $ref: `${BASE}category.json` } },
      required: ["left", "right"],
      additionalProperties: false,
    },
  });

  it("counts a definition once per use, at the depth of each use", () => {
    // Shelf has 2 properties, and each use of Category 2 more for the root and 2 for $defs.
    expect(() => projectType(forest, "Shelf", limited({ maxProperties: 9 }))).not.toThrow();
    expect(() => projectType(forest, "Shelf", limited({ maxProperties: 5 }))).toThrow("has a property count of 6,");
    // Each use of Category has its children anyOf, once inside the $defs entry it refers to.
    expect(() => projectType(forest, "Shelf", limited({ maxUnions: 1 }))).toThrow("has an anyOf count of 2,");
  });

  it("keeps the doc of an optional field of a recursive type beside the anyOf, never beside a $ref", () => {
    const docs = model({
      node: {
        title: "Node",
        type: "object",
        properties: {
          next: { description: "The next node.", $ref: "#" },
          first: { $ref: "#" },
        },
        additionalProperties: false,
        required: ["first"],
      },
    });
    const { schema } = projectType(docs, "Node", limited({}));
    const props = schema.properties as Record<string, JsonObject>;
    expect(props.next).toEqual({ description: "The next node.", anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }] });
    expect(props.first).toEqual({ $ref: "#/$defs/Node" });
    expect(JSON.stringify(schema)).not.toMatch(/"\$ref":"[^"]*","description"|"description":"[^"]*","\$ref"/);
  });

  it("fails on a value of any type and on data keys beside properties, naming the schema path", () => {
    const anyModel = model({
      event: {
        title: "Event",
        type: "object",
        properties: { payload: {} },
        required: ["payload"],
        additionalProperties: false,
      },
    });
    expect(() => projectType(anyModel, "Event", openai)).toThrow(
      "event.json#: llm-unsupported: profile openai: Event.payload takes any JSON value",
    );
    // With the schemas, the error points at the field itself.
    const set = schemaSet({
      event: {
        $id: `${BASE}event.json`,
        title: "Event",
        type: "object",
        properties: { payload: {} },
        required: ["payload"],
        additionalProperties: false,
      },
    });
    expect(() => projectType(anyModel, "Event", openai, set)).toThrow(
      "event.json#/properties/payload: llm-unsupported: profile openai: Event.payload takes any JSON value",
    );
    const restModel = model({
      attributes: {
        title: "Attributes",
        type: "object",
        properties: { channel: { type: "string" } },
        additionalProperties: { type: "string" },
      },
    });
    expect(() => projectType(restModel, "Attributes", openai)).toThrow(
      "attributes.json#: llm-unsupported: profile openai: Attributes has keys that are data beside its properties",
    );
  });


  it.each([
    [{ maxDepth: 2 }, "order.json#: llm-limit: the limited schema for Order has a nesting depth of 3, at /properties/lines/items"],
    [{ maxProperties: 10 }, "has a property count of"],
    [{ maxEnumValues: 2 }, "has an enum value count of 6"],
    [{ maxStringSize: 20 }, "has names and values of a total length of"],
    [{ maxUnions: 1 }, "has an anyOf count of"],
    [{ largeEnum: { values: 2, maxSize: 5 } }, "has an enum of more than 2 values with a total length of 15, at /properties/status"],
  ])("fails over the limit %j, naming the schema path", (limits, message) => {
    const profile = limited(limits);
    expect(() => projectType(m, "Order", profile)).toThrow(message);
  });

  it("passes at a limit exactly", () => {
    const depth = projectType(m, "Order", limited({ maxDepth: 3 }));
    expect(depth.type).toBe("Order");
  });

  it("writes sentences: the doc with a final stop, then the hints", () => {
    expect(describeText("", [])).toBe("");
    expect(describeText("A note", [])).toBe("A note.");
    expect(describeText("A note!", ["at most 3 characters"])).toBe("A note! At most 3 characters.");
    expect(describeText("", ["at least 1 item", "at most 2 items"])).toBe("At least 1 item, at most 2 items.");
  });

  it("writes ASCII only, every other character as an escape", () => {
    const odd = String.fromCodePoint(0xfeff, 0x2028, 0x1f600, 0x7f);
    const text = schemaText({ description: odd });
    expect(JSON.parse(text)).toEqual({ description: odd });
    expect([...text].every((c) => (c.codePointAt(0) ?? 0) < 0x7f)).toBe(true);
  });
});

describe("LLM output files", () => {
  it("writes one file per profile and type", () => {
    const m = model({ order: SHOP.order ?? {}, status: SHOP.status ?? {} });
    const files = emitLlm(m, PROFILES);
    const types = ["Card", "Contact", "Line", "Order", "Payment", "Status", "Wire"];
    expect(files.map((f) => f.name)).toEqual(
      PROFILES.flatMap((p) => types.map((t) => `${p.name}/${t}.json`)),
    );
    for (const file of files) expect(file.contents.endsWith("}\n")).toBe(true);
  });

  it("fails when a type can't be projected for one of the profiles", () => {
    expect(() => emitLlm(model(SHOP), PROFILES)).toThrow("llm-unsupported: profile anthropic: Category contains itself");
  });

  it("fails on type names that differ only in case, which would be one file on some systems", () => {
    const m = model({
      a: { title: "OrderID", type: "object", properties: {}, additionalProperties: false },
      b: { title: "OrderId", type: "object", properties: {}, additionalProperties: false },
    });
    expect(m.decls.map((d) => d.name)).toEqual(["OrderID", "OrderId"]);
    expect(() => emitLlm(m, PROFILES)).toThrow("b.json#: name-clash: type OrderId and type OrderID differ only in case");
  });
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project in a temp folder with the SHOP order and status schemas and `config`. */
function project(config: object): string {
  const root = mkdtempSync(join(tmpdir(), "strictgen-llm-"));
  roots.push(root);
  mkdirSync(join(root, "schemas"));
  for (const name of ["order", "status"]) {
    writeFileSync(join(root, "schemas", `${name}.json`), JSON.stringify({ $id: `${BASE}${name}.json`, ...SHOP[name] }));
  }
  writeFileSync(join(root, "strictgen.json"), JSON.stringify(config));
  return root;
}

function cli(cwd: string, args: readonly string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { cwd, env: { PATH: "" }, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
}

const TS_ONLY = { targets: { typescript: { out: "ts" } } };
const WITH_LLM = { ...TS_ONLY, llm: { profiles: ["openai", "gemini"], out: "llm" } };

describe("strictgen llm", () => {
  it("prints the schema on stdout and what moved to the decoder on stderr", () => {
    const root = project(TS_ONLY);
    const result = cli(root, ["llm", "--profile", "openai", "Order"]);
    expect(result.code).toBe(EXIT_OK);
    const projection = projectType(model({ order: SHOP.order ?? {}, status: SHOP.status ?? {} }), "Order", builtinProfile("openai"));
    expect(`${result.out.join("\n")}\n`).toBe(schemaText(projection.schema));
    expect(result.err).toEqual(changeLines(projection));
  });

  it("prints the type, profile, schema and changes as JSON with --json", () => {
    const result = cli(project(TS_ONLY), ["llm", "--profile", "gemini", "Status", "--json"]);
    expect(result.code).toBe(EXIT_OK);
    const parsed = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["type", "profile", "schema", "changes"]);
    expect(parsed.profile).toBe("gemini");
    expect(result.err).toEqual([]);
  });

  it("reads a profile file by path, given on the command line or listed in llm.profiles", () => {
    const local = { ...JSON.parse(readFileSync(builtinProfileFile("openai"), "utf8")), name: "local", keywords: [] };
    const root = project({ ...TS_ONLY, llm: { profiles: ["profiles/local.json"], out: "llm" } });
    mkdirSync(join(root, "profiles"));
    writeFileSync(join(root, "profiles", "local.json"), JSON.stringify(local));
    for (const name of ["local", "profiles/local.json"]) {
      const result = cli(root, ["llm", "--profile", name, "Order"]);
      expect(result.code).toBe(EXIT_OK);
      // No keyword is kept, so the bounds of total move to its description.
      expect(result.out.join("\n")).toContain('"description": "The total. At least 0, less than 100000."');
    }
  });

  it("prints one profile though another profile file in llm.profiles is broken", () => {
    const root = project({ ...TS_ONLY, llm: { profiles: ["broken.json", "mine.json"], out: "llm" } });
    writeFileSync(join(root, "broken.json"), "{");
    writeFileSync(join(root, "mine.json"), JSON.stringify({ name: "mine", version: "x" }));
    expect(cli(root, ["llm", "--profile", "openai", "Order"]).code).toBe(EXIT_OK);
    // A file that names the profile, or is named like it when unreadable, is checked in full.
    expect(cli(root, ["llm", "--profile", "mine", "Order"]).err).toEqual(["error: mine.json: date: is required"]);
    expect(cli(root, ["llm", "--profile", "broken", "Order"]).err[0]).toMatch(/^error: broken\.json: not valid JSON/);
    // generate still checks every listed profile.
    expect(cli(root, ["generate"]).err[0]).toMatch(/^error: broken\.json: not valid JSON/);
  });

  it("exits 2 for an unknown type or profile, and 1 for a type it can't project", () => {
    const root = project(TS_ONLY);
    const unknown = cli(root, ["llm", "--profile", "openai", "Nope"]);
    expect(unknown.code).toBe(EXIT_USAGE);
    expect(unknown.err[0]).toMatch(/^error: no type "Nope" in the schemas/);
    const profile = cli(root, ["llm", "--profile", "nope", "Order"]);
    expect(profile.code).toBe(EXIT_USAGE);
    expect(profile.err).toHaveLength(1);
    const missing = cli(root, ["llm", "--profile", "missing.json", "Order"]);
    expect(missing).toEqual({ code: EXIT_USAGE, out: [], err: ["error: missing.json: profile file not found"] });
    const limited = { ...JSON.parse(readFileSync(builtinProfileFile("openai"), "utf8")), name: "tiny", limits: { maxDepth: 1 } };
    writeFileSync(join(root, "tiny.json"), JSON.stringify(limited));
    const over = cli(root, ["llm", "--profile", "tiny.json", "Order"]);
    expect(over.code).toBe(EXIT_FAILED);
    expect(over.out).toEqual([]);
    expect(over.err).toEqual([
      "error: order.json#: llm-limit: the tiny schema for Order has a nesting depth of 3, at /properties/lines/items, and the profile allows at most 1. Hint: split the type into smaller ones, or use a profile with higher limits",
    ]);
  });
});

describe("llm.out", () => {
  it("is written by generate, compared by check and listed by dirs", () => {
    const root = project(WITH_LLM);
    expect(cli(root, ["generate"]).out).toEqual(["Generated 18 files for typescript, llm."]);
    expect(readdirSync(join(root, "llm")).sort()).toEqual(["gemini", "openai"]);
    expect(readdirSync(join(root, "llm", "openai")).sort()).toEqual([
      "Card.json",
      "Contact.json",
      "Line.json",
      "Order.json",
      "Payment.json",
      "Status.json",
      "Wire.json",
    ]);
    expect(cli(root, ["check"]).code).toBe(EXIT_OK);
    writeFileSync(join(root, "llm", "openai", "Old.json"), "{}\n");
    const stale = cli(root, ["check"]);
    expect(stale.code).toBe(EXIT_FAILED);
    expect(stale.err).toContain("  stale:   llm/openai/Old.json");
    // Generating again clears the folder, so the stale file goes.
    cli(root, ["generate"]);
    expect(readdirSync(join(root, "llm", "openai"))).not.toContain("Old.json");
    expect(JSON.parse(cli(root, ["dirs", "--json"]).out.join("\n"))).toEqual([
      { target: "typescript", dir: "ts", shared: false },
      { target: "llm", dir: "llm", shared: false },
    ]);
  });

  it("leaves explain to the languages", () => {
    const result = cli(project(WITH_LLM), ["explain", "order.json", "--json"]);
    expect(result.code).toBe(EXIT_OK);
    const explained = JSON.parse(result.out.join("\n")) as { targets: { target: string }[] };
    expect(explained.targets.map((t) => t.target)).toEqual(["typescript"]);
  });

  it("writes nothing when a type can't be projected for one profile", () => {
    const root = project({ ...TS_ONLY, llm: { profiles: ["openai"], out: "llm" } });
    writeFileSync(
      join(root, "schemas", "event.json"),
      JSON.stringify({ $id: `${BASE}event.json`, title: "Event", type: "object", properties: { payload: {} }, required: ["payload"], additionalProperties: false }),
    );
    const result = cli(root, ["generate"]);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err[0]).toMatch(/^error: event\.json#\/properties\/payload: llm-unsupported: profile openai: Event\.payload/);
    expect(readdirSync(root).sort()).toEqual(["schemas", "strictgen.json"]);
  });

  it("fails with exit 2 when two listed profiles share a name", () => {
    const root = project({ ...TS_ONLY, llm: { profiles: ["openai", "copy.json"], out: "llm" } });
    writeFileSync(join(root, "copy.json"), readFileSync(builtinProfileFile("openai")));
    expect(cli(root, ["generate"])).toEqual({
      code: EXIT_USAGE,
      out: [],
      err: ["error: strictgen.json: llm.profiles[1]: names the profile openai, which llm.profiles[0] names too"],
    });
  });
});

describe("the cleanup helper", () => {
  const m = model({ order: SHOP.order ?? {}, status: SHOP.status ?? {} });
  const file = (files: readonly { name: string; contents: string }[], name: string): string =>
    files.find((f) => f.name === name)?.contents ?? "";

  it("is emitted in every language only when llm.cleanup is on", () => {
    expect(file(emitTypeScript(m), "helpers.ts")).not.toContain("cleanLlmJson");
    expect(file(emitTypeScript(m), "index.ts")).not.toContain("cleanLlmJson");
    expect(file(emitGo(m), "helpers.go")).not.toContain("CleanLLMJSON");
    expect(file(emitRust(m), "helpers.rs")).not.toContain("clean_llm_json");
    expect(file(emitRust(m), "mod.rs")).not.toContain("clean_llm_json");
    expect(file(emitTypeScript(m, { cleanup: true }), "helpers.ts")).toContain("export function cleanLlmJson(text: string): string");
    expect(file(emitTypeScript(m, { cleanup: true }), "index.ts")).toContain("export { cleanLlmJson,");
    expect(file(emitGo(m, { cleanup: true }), "helpers.go")).toContain("func CleanLLMJSON(data []byte) []byte");
    expect(file(emitRust(m, { cleanup: true }), "helpers.rs")).toContain("pub fn clean_llm_json(text: &str) -> String");
    expect(file(emitRust(m, { cleanup: true }), "mod.rs")).toContain("pub use helpers::clean_llm_json;");
  });

  it("reserves CleanLLMJSON in Go when it is on", () => {
    const clash = model({ clean: { title: "CleanLLMJSON", type: "object", properties: {}, additionalProperties: false } });
    expect(() => emitGo(clash)).not.toThrow();
    expect(() => emitGo(clash, { cleanup: true })).toThrow("name-clash: Go name CleanLLMJSON is also used by helpers.go");
  });

  it("refuses to go without the TypeScript decoders, which hold it", () => {
    expect(() => emitTypeScript(m, { cleanup: true, decoders: false })).toThrow("the cleanup step needs the decoders");
  });

  it("cleans the shared vectors in TypeScript as Rust and Go do", async () => {
    const vectors = JSON.parse(
      readFileSync(new URL("../examples/llm/cleanup-vectors.json", import.meta.url), "utf8"),
    ) as { name: string; input: string; output: string }[];
    expect(vectors.length).toBeGreaterThan(40);
    // The example's generated helpers, which strictgen check keeps up to date. A computed path, so
    // tsc doesn't pull the example into this project.
    const path = new URL("../examples/llm/ts/generated/helpers.ts", import.meta.url).pathname;
    const helpers = (await import(path)) as { cleanLlmJson: (text: string) => string };
    for (const v of vectors) {
      expect(Object.keys(v), v.name).toEqual(["name", "input", "output"]);
      expect(helpers.cleanLlmJson(v.input), v.name).toBe(v.output);
    }
  });

  it("has vectors the script writes, so none is typed by hand into the file", () => {
    const script = new URL("../scripts/cleanup-vectors.mjs", import.meta.url).pathname;
    const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
