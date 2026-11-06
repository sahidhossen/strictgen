import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { table } from "./compare.js";
import { variantName } from "./protocol.js";
import { runSuite } from "./suite.js";

/** The conformance folder of this repository. */
const CONFORMANCE = join(import.meta.dirname, "..", "..", "conformance");

/** Generating and loading the TypeScript of both read modes takes a few seconds on a cold start. */
const SUITE_TIMEOUT = 120_000;

describe("the conformance cases in TypeScript", () => {
  // `pnpm conformance` runs Rust and Go too; this keeps every case checked by `pnpm test`.
  it(
    "agree with every expectation and mark, in strict and report mode",
    async () => {
      const result = await runSuite({ conformance: CONFORMANCE, modes: ["strict", "report"], languages: ["ts"] });
      expect(table(result.rows, ["ts"]).join("\n")).toBe(table([], ["ts"]).join("\n"));
      // How many cases there are is checked against conformance/manifest.json by the run itself.
      expect(result.marks.length).toBeGreaterThan(0);
      expect(result.variants.map(variantName)).toEqual([
        "strict",
        "strict/registry",
        "strict/serde",
        "report",
        "report/registry",
        "report/serde",
        "strict/with-llm",
        "report/with-llm",
        "strict/llm/both:entries",
        "strict/llm/both:objects",
        "report/llm/both:entries",
        "report/llm/both:objects",
        "strict/llm/entries",
        "strict/llm/objects",
        "report/llm/vectors",
        "report/vectors",
        "report/cleanup/vectors",
      ]);
      // Every LLM variant reads cases of every type with an LLM decoder, valid and invalid, and
      // near misses only the LLM form has.
      for (const v of result.variants.filter((x) => x.decoder === "llm" && x.vectors !== true)) {
        const jobs = result.jobs.filter((j) => j.variant === v);
        expect(jobs.some((j) => j.case.valid && j.case.encodes !== undefined), variantName(v)).toBe(true);
        expect(jobs.some((j) => !j.case.valid && j.case.id.includes("(llm: ")), variantName(v)).toBe(true);
        expect(new Set(jobs.map((j) => j.case.type)).has("Refund"), variantName(v)).toBe(true);
        expect(new Set(jobs.map((j) => j.case.type)).has("OrderId"), variantName(v)).toBe(true);
      }
      // A single-shape decoder also gets each one-map case in the other shape.
      for (const name of ["strict/llm/entries", "strict/llm/objects"]) {
        expect(result.jobs.some((j) => variantName(j.variant) === name && j.case.id.includes(" as ")), name).toBe(true);
      }
      expect(result.jobs.filter((j) => j.variant.decoder === "cleanup").length).toBeGreaterThan(60);
    },
    SUITE_TIMEOUT,
  );
});
