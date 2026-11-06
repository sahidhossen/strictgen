import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { configModel } from "./examples.js";
import { llmProfiles } from "./llm.js";
import { llmTypes } from "./llm-decoders.js";
import type { LlmVector } from "./llm-vectors.js";
import { llmCandidates, vectorsText } from "./llm-vectors.js";
import type { Payload } from "./payloads.js";
import { PayloadGenerator } from "./payloads.js";

const FILE = fileURLToPath(new URL("../examples/llm/llm-vectors.json", import.meta.url));
const CONFIG = fileURLToPath(new URL("../examples/llm/strictgen.json", import.meta.url));

/** What the generated TypeScript gives for a decode: the value or the error. */
type Result = { ok: true; value: unknown } | { ok: false; error: { path: string; code: string; compact(): string } };
type Module = Record<string, (input: unknown) => unknown>;

/**
 * Hand made payloads, in normal JSON, for what generated ones may miss: map keys with the
 * characters a JSON Pointer escapes, an astral character counted as one, a line separator, and
 * escape runs, quotes, commas and braces inside strings, which the cleanup step must leave alone.
 */
function extras(generator: PayloadGenerator): { name: string; type: string; json: Payload }[] {
  const base = generator.valid("OrderRequest");
  if (typeof base !== "object" || base === null || Array.isArray(base)) throw new Error("an order is an object");
  const emoji = String.fromCodePoint(0x1f600);
  const separator = String.fromCodePoint(0x2028);
  const order = (labels: Record<string, string>, note: string): Payload => ({ ...base, labels, note });
  return [
    {
      name: "OrderRequest with escaped keys",
      type: "OrderRequest",
      json: order({ "a/b~c": `line${separator}two`, [emoji.repeat(3)]: 'q"uote\\back\\\\"' }, 'a ",} and ``` inside'),
    },
    { name: "OrderRequest with a key of 12 astral characters", type: "OrderRequest", json: order({ [emoji.repeat(12)]: "x" }, "\\\\\\") },
  ];
}

describe("the shared LLM vectors", () => {
  it(
    "decode in TypeScript as their labels say, and the file holds them",
    async () => {
      const config = loadConfig(CONFIG);
      const { model } = configModel(config);
      if (config.llm === undefined) throw new Error("the example configures llm");
      const profiles = llmProfiles(config, config.llm);
      const path = new URL("../examples/llm/ts/generated/index.ts", import.meta.url).pathname;
      const ts = (await import(path)) as Module;
      const call = (name: string, input: unknown): unknown => {
        const fn = ts[name];
        if (fn === undefined) throw new Error(`no ${name} in the example`);
        return fn(input);
      };
      const generator = new PayloadGenerator(model, { seed: 7 });
      const candidates = llmCandidates(model, profiles, { seed: 1, count: 3, cleanup: config.llm.cleanup }, extras(generator));
      const vectors: LlmVector[] = [];
      const codes = new Set<string>();
      for (const c of candidates) {
        const result = call(`tryDecode${c.type}FromLlm`, c.llm) as Result;
        if (c.json !== undefined) {
          if (!result.ok) throw new Error(`${c.name}: ${result.error.compact()}\n${c.llm}`);
          const normal = call(`decode${c.type}FromJson`, c.json);
          // The value decoded through the LLM path equals the one decoded normally.
          expect(call(`encode${c.type}ToJson`, result.value), c.name).toBe(call(`encode${c.type}ToJson`, normal));
          vectors.push({ name: c.name, type: c.type, llm: c.llm, json: c.json });
        } else {
          if (result.ok) throw new Error(`${c.name}: decoded, expected ${JSON.stringify(c.expect)}\n${c.llm}`);
          expect({ path: result.error.path, code: result.error.code }, `${c.name}\n${c.llm}`).toEqual(c.expect);
          vectors.push({ name: c.name, type: c.type, llm: c.llm, error: result.error.compact() });
          codes.add(result.error.code);
        }
      }
      const types = new Set(vectors.map((v) => v.type));
      expect([...types].sort()).toEqual(llmTypes(model).map((d) => d.name));
      for (const code of ["duplicate_key", "missing_key", "unknown_key", "wrong_type", "null_not_allowed", "too_long", "pattern_mismatch"]) {
        expect(codes, code).toContain(code);
      }
      const text = vectorsText(vectors);
      if (process.env.STRICTGEN_WRITE_VECTORS === "1") writeFileSync(FILE, text);
      expect(readFileSync(FILE, "utf8"), "run pnpm vectors:llm to write examples/llm/llm-vectors.json again").toBe(text);
    },
    60_000,
  );
});
