#!/usr/bin/env node
/**
 * `pnpm conformance`: decodes every conformance case in Rust, Go and TypeScript, in strict and
 * report mode, and fails on any disagreement between the languages or with a case's expectation.
 *
 * Exit codes: 0 when everything agrees, 1 on a disagreement, 2 when the run can't happen (bad
 * arguments, a missing toolchain, a broken case folder, a driver that fails to build).
 */

import { fileURLToPath } from "node:url";

import { CodegenError } from "../schema.js";
import { parseArguments, USAGE } from "./args.js";
import { LayoutError } from "./cases.js";
import { table } from "./compare.js";
import { conformanceModel, ToolchainError } from "./drivers.js";
import { DriverError, LANGUAGES } from "./protocol.js";
import { coverageLines } from "./coverage.js";
import { loadSuite, runSuite, withScratch } from "./suite.js";

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args);
  if (typeof parsed === "string") {
    process.stderr.write(`conformance: ${parsed}\n${USAGE}\n`);
    return 2;
  }
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const conformance = fileURLToPath(new URL("../../conformance", import.meta.url));
  try {
    if (parsed.coverage) {
      const { manifest, coverage: report } = await withScratch(false, async (dir) => Promise.resolve(loadSuite(conformance, conformanceModel(conformance, dir))));
      for (const line of coverageLines(report, manifest.coverage)) out(line);
      return 0;
    }
    const result = await runSuite({ conformance, ...parsed, log: out });
    if (result.kept !== undefined) out(`kept the generated code and drivers in ${result.kept}`);
    out(
      `conformance: ${String(result.cases.length)} cases, ${parsed.modes.join(" and ")} mode, ` +
        `${parsed.languages.join(", ")}: ${String(result.jobs.length)} runs per language (${String(result.variants.length)} variants), ${String(result.marks.length)} marked`,
    );
    const llm = result.jobs.filter((j) => j.variant.decoder === "llm" && j.variant.vectors !== true).length;
    const vectors = result.jobs.filter((j) => j.variant.vectors === true).length;
    out(`  ${String(llm)} runs through the LLM decoders, ${String(vectors)} of the shared vectors of examples/llm`);
    const reasons = new Map<string, number>();
    for (const why of result.skipped.values()) reasons.set(why, (reasons.get(why) ?? 0) + 1);
    for (const [why, n] of [...reasons].sort(([a], [b]) => (a < b ? -1 : 1))) out(`  ${String(n)} invalid cases not in the LLM form: ${why}`);
    if (parsed.languages.length < LANGUAGES.length || parsed.modes.length < 2) {
      out("not every language and mode ran, so marks were not checked for being needed");
    }
    if (result.rows.length === 0) {
      out(
        parsed.languages.length === 1
          ? `${parsed.languages[0] ?? ""} agrees with every case's expectation`
          : `${parsed.languages.join(", ")} agree with each other and with every case`,
      );
      return 0;
    }
    out("");
    for (const line of table(result.rows, parsed.languages)) out(line);
    const failing = new Set(result.rows.map((r) => r.case)).size;
    out("");
    const count = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
    out(`${count(result.rows.length, "disagreement")} in ${count(failing, "case")}`);
    return 1;
  } catch (error) {
    if (
      error instanceof LayoutError ||
      error instanceof ToolchainError ||
      error instanceof DriverError ||
      error instanceof CodegenError
    ) {
      process.stderr.write(`conformance: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`conformance: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

// A closed stdout, like `| head`, only stops the output: the run goes on to the end, so it still
// removes its scratch folder and exits with its own code. Exiting here would skip that.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") process.exitCode = 2;
  });
}

const code = await main(process.argv.slice(2));
if (process.exitCode !== 2) process.exitCode = code;
