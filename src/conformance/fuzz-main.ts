#!/usr/bin/env node
/**
 * `pnpm fuzz`: random payloads through every decoder of the proof suite, in Rust, Go and
 * TypeScript, compared (`fuzz.ts`).
 *
 * Exit codes: 0 when every run agrees, 1 on a disagreement, 2 when the run can't happen (bad
 * arguments, a missing toolchain, a broken case folder, a driver that fails to build).
 */

import { randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

import { CodegenError } from "../schema.js";
import { LayoutError } from "./cases.js";
import { ToolchainError } from "./drivers.js";
import { FUZZ_USAGE, parseFuzzArguments } from "./fuzz-args.js";
import { failureLines, ranLanguages, runFuzz } from "./fuzz.js";
import { DriverError } from "./protocol.js";

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseFuzzArguments(args);
  if (typeof parsed === "string") {
    process.stderr.write(`fuzz: ${parsed}\n${FUZZ_USAGE}\n`);
    return 2;
  }
  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  const conformance = fileURLToPath(new URL("../../conformance", import.meta.url));
  const seed = parsed.seed ?? randomInt(0, 0x100000000);
  out(`fuzz: seed ${String(seed)}, runs ${String(parsed.start)} to ${String(parsed.start + parsed.runs - 1)}, ${parsed.languages.join(", ")}`);
  try {
    const result = await runFuzz({ conformance, seed, start: parsed.start, runs: parsed.runs, languages: parsed.languages, log: out, ...(parsed.save === undefined ? {} : { save: parsed.save }) });
    for (const u of result.unfuzzable) out(`  ${u.type}: no payloads, ${u.reason}`);
    if (result.failure === undefined) {
      out(`fuzz: ${String(result.runs)} runs, ${String(result.requests)} requests per language, ${parsed.languages.join(", ")} agree`);
      return 0;
    }
    out("");
    for (const line of failureLines(seed, result.failure, ranLanguages(parsed.languages))) out(line);
    if (result.failure.shrunk !== undefined && result.failure.saved === undefined) {
      out(parsed.save === undefined ? "to keep it as a case: --save <language>, with the language the spec says is right" : "the case was not saved");
    }
    return 1;
  } catch (error) {
    if (error instanceof LayoutError || error instanceof ToolchainError || error instanceof DriverError || error instanceof CodegenError) {
      process.stderr.write(`fuzz: ${error.message}\n`);
      return 2;
    }
    process.stderr.write(`fuzz: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

// A closed stdout only stops the output: the run goes on, removes its scratch folder and exits
// with its own code.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") process.exitCode = 2;
  });
}

const code = await main(process.argv.slice(2));
if (process.exitCode !== 2) process.exitCode = code;
