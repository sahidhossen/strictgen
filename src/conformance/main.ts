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
import { ToolchainError } from "./drivers.js";
import { DriverError, LANGUAGES } from "./protocol.js";
import { runSuite } from "./suite.js";

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseArguments(args);
  if (typeof parsed === "string") {
    process.stderr.write(`conformance: ${parsed}\n${USAGE}\n`);
    return 2;
  }
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const conformance = fileURLToPath(new URL("../../conformance", import.meta.url));
  try {
    const result = await runSuite({ conformance, ...parsed, log: out });
    if (result.kept !== undefined) out(`kept the generated code and drivers in ${result.kept}`);
    const runs = result.cases.length * result.variants.length;
    out(
      `conformance: ${String(result.cases.length)} cases, ${parsed.modes.join(" and ")} mode, ` +
        `${parsed.languages.join(", ")}: ${String(runs)} runs per language, ${String(result.marks.length)} marked`,
    );
    if (parsed.languages.length < LANGUAGES.length) {
      out("only some languages ran, so the marks that compare one language's bytes with another's were not checked");
    }
    if (result.rows.length === 0) {
      out("every language agrees with every case");
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

// A closed stdout, like `| head`, ends the run quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    process.exit(error.code === "EPIPE" ? (process.exitCode ?? 0) : 2);
  });
}

process.exitCode = await main(process.argv.slice(2));
