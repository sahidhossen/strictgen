import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import type { JsonObject } from "./schema.js";
import { CodegenError, schemaSet } from "./schema.js";
import { isRuleId, RULE_IDS, RULES } from "./rules.js";

const BASE = "https://example.com/schemas/v1/";
const SRC = new URL(".", import.meta.url).pathname;

/**
 * The source files that can raise generation errors: every non-test file that names
 * `CodegenError`. Others, like the config reader and the formatters, have a `fail` of their own.
 */
function sources(): { name: string; text: string }[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }))
    .filter(({ text }) => text.includes("CodegenError"));
}

/**
 * The top-level arguments of every `fail(...)` and `new CodegenError(...)` call in `text`, as
 * source text. Strings and template literals are skipped over, so commas inside them don't split.
 * Method calls like `p.fail(`, the Go method `func (p *parser) fail(` in the generated Go
 * helpers, and the declaration `function fail(` are not calls of the schema `fail`.
 */
function calls(text: string): string[][] {
  const found: string[][] = [];
  const start = /(?<![.\w])(?<!function |\) )(fail|new CodegenError)\(/g;
  for (const match of text.matchAll(start)) {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    let i = match.index + match[0].length;
    for (; i < text.length; i++) {
      const ch = text[i] ?? "";
      if (ch === '"' || ch === "'" || ch === "`") {
        let j = i + 1;
        while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
        current += text.slice(i, j + 1);
        i = j;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      }
      if (ch === "," && depth === 0) {
        args.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim() !== "") args.push(current.trim());
    found.push(args);
  }
  return found;
}

describe("rule ids", () => {
  it("are kebab-case, sorted and summarized", () => {
    for (const id of RULE_IDS) {
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(RULES[id].length).toBeGreaterThan(0);
    }
    expect([...RULE_IDS].sort()).toEqual(RULE_IDS);
    expect(isRuleId("open-object")).toBe(true);
    expect(isRuleId("toString")).toBe(false);
  });

  it("are given as a known string literal at every fail site", () => {
    let sites = 0;
    for (const { name, text } of sources()) {
      for (const args of calls(text)) {
        // `fail` itself passes its typed rule on to the error.
        if (name === "schema.ts" && args[1] === "rule") continue;
        sites++;
        const rule = /^"([^"]+)"$/.exec(args[1] ?? "")?.[1];
        expect(rule, `${name}: ${args.join(", ")}`).toBeDefined();
        expect(isRuleId(rule ?? ""), `${name}: unknown rule ${String(rule)}`).toBe(true);
      }
    }
    // The audit found this many sites. A new one must name a rule too.
    expect(sites).toBeGreaterThan(80);
  });
});

function schema(name: string, body: JsonObject): JsonObject {
  return { $id: `${BASE}${name}.json`, title: name, ...body };
}

function failure(body: JsonObject): CodegenError {
  try {
    buildModel(schemaSet({ user: schema("user", body) }));
  } catch (error) {
    if (error instanceof CodegenError) return error;
    throw error;
  }
  throw new Error("expected a CodegenError");
}

describe("generation errors name the rule and a hint", () => {
  it("reads <file>#<pointer>: <rule>: <reason>. Hint: <hint>", () => {
    const error = failure({
      $defs: { address: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(error.message).toBe(
      'user.json#/$defs/address: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false',
    );
  });

  it("leaves the hint out when there is no obvious fix", () => {
    const error = failure({ $defs: { x: { enum: ["a", "a"] } } });
    expect(error).toMatchObject({ rule: "unsupported-enum", hint: undefined });
    expect(error.message).toBe("user.json#/$defs/x/enum: unsupported-enum: enum values must be unique");
  });

  it.each<[string, JsonObject, string, string, string | RegExp]>([
    [
      "an open object",
      { $defs: { x: { type: "object", properties: { a: { type: "string" } } } } },
      "user.json#/$defs/x",
      "open-object",
      'add "additionalProperties": false',
    ],
    [
      "an open object beside allOf",
      {
        $defs: {
          base: { type: "object", properties: { a: { type: "string" } } },
          x: { type: "object", allOf: [{ $ref: "#/$defs/base" }] },
        },
      },
      "user.json#/$defs/x",
      "open-object",
      'add "unevaluatedProperties": false',
    ],
    [
      "additionalProperties false beside allOf",
      {
        $defs: {
          base: { type: "object", properties: { a: { type: "string" } } },
          x: { type: "object", allOf: [{ $ref: "#/$defs/base" }], additionalProperties: false },
        },
      },
      "user.json#/$defs/x/additionalProperties",
      "closed-with-allof",
      'replace "additionalProperties": false with "unevaluatedProperties": false',
    ],
    [
      "a oneOf whose branches carry a tag only partly",
      {
        $defs: {
          a: {
            type: "object",
            properties: { kind: { const: "a" } },
            required: ["kind"],
            additionalProperties: false,
          },
          b: { type: "object", properties: { n: { type: "integer" } }, additionalProperties: false },
          x: { oneOf: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }] },
        },
      },
      "user.json#/$defs/x",
      "union-tag",
      "make kind a required string const on every branch, with a different value on each",
    ],
    [
      "a oneOf without a tag whose branches map to the same variant",
      { $defs: { x: { oneOf: [{ type: "string" }, { type: "string", format: "date" }] } } },
      "user.json#/$defs/x/oneOf/1",
      "untagged-union",
      /^give every branch a required tag property with a distinct const/,
    ],
    [
      "an unsupported keyword",
      { $defs: { x: { type: "string", contentEncoding: "base64" } } },
      "user.json#/$defs/x/contentEncoding",
      "unsupported-keyword",
      'remove it, or keep the note in "description" or "$comment"',
    ],
    [
      "a root keyword below the root",
      { $defs: { x: { type: "string", $id: "x" } } },
      "user.json#/$defs/x/$id",
      "unsupported-keyword",
      "$id is only allowed at the root of a schema file",
    ],
    [
      "an unsupported format",
      { $defs: { x: { type: "string", format: "email" } } },
      "user.json#/$defs/x/format",
      "unsupported-format",
      'remove "format", or check the shape with "pattern"',
    ],
    [
      "a nullable type",
      { $defs: { x: { type: ["string", "null"] } } },
      "user.json#/$defs/x/type",
      "unsupported-type",
      "use one type and make the key optional instead of allowing null",
    ],
    [
      "a required key without a property",
      {
        $defs: {
          x: {
            type: "object",
            properties: {},
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      "user.json#/$defs/x/required",
      "undeclared-key",
      'add id to "properties"',
    ],
    [
      "an array without items",
      { $defs: { x: { type: "array" } } },
      "user.json#/$defs/x",
      "missing-items",
      'add "items", like "items": { "type": "string" }',
    ],
    [
      "a type name that starts with a digit",
      { $defs: { "1st": { type: "string" } } },
      "user.json#/$defs/1st",
      "unsupported-name",
      /^rename the \$defs entry/,
    ],
  ])("%s", (_, body, path, rule, hint) => {
    const error = failure(body);
    expect(error).toMatchObject({ path, rule });
    expect(error.hint).toMatch(hint);
    expect(error.message).toBe(`${path}: ${rule}: ${error.reason}. Hint: ${String(error.hint)}`);
  });

  it("names the rule for a missing title", () => {
    const error = (() => {
      try {
        buildModel(schemaSet({ user: { $id: `${BASE}user.json`, type: "string" } }));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toMatchObject({ path: "user.json#/title", rule: "missing-title" });
  });
});
