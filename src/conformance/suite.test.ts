import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { table } from "./compare.js";
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
      expect(result.cases.length).toBeGreaterThan(250);
      expect(result.marks.length).toBeGreaterThan(0);
      expect(result.variants).toEqual([
        { mode: "strict", decoder: "normal" },
        { mode: "report", decoder: "normal" },
      ]);
    },
    SUITE_TIMEOUT,
  );
});
