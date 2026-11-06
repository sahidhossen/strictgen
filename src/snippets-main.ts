#!/usr/bin/env node
/**
 * `pnpm docs` writes every snippet of README.md and docs/*.md again from real output, and
 * `pnpm docs:check` fails when one is out of date (see snippets.ts). Both need Rust and Go, since
 * some snippets are what the Rust and Go decoders print.
 *
 * Exit codes: 0 when every snippet is up to date (or was written), 1 when `--check` found one
 * out of date, 2 when a snippet can't be made.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolchainError } from "./conformance/drivers.js";
import { DriverError } from "./conformance/protocol.js";
import { SnippetError, staleFiles } from "./snippets.js";

async function main(args: readonly string[]): Promise<number> {
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    process.stderr.write(`docs: unknown argument ${unknown[0] ?? ""}\nusage: docs [--check]\n`);
    return 2;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    const stale = await staleFiles(root);
    if (check) {
      for (const s of stale) process.stderr.write(`docs: ${s.file} is out of date, run pnpm docs\n`);
      return stale.length === 0 ? 0 : 1;
    }
    for (const s of stale) writeFileSync(join(root, s.file), s.text);
    process.stdout.write(`docs: ${stale.length === 0 ? "every snippet is up to date" : `wrote ${stale.map((s) => s.file).join(", ")}`}\n`);
    return 0;
  } catch (error) {
    if (error instanceof SnippetError || error instanceof ToolchainError || error instanceof DriverError) {
      process.stderr.write(`docs: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
