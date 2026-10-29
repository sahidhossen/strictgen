#!/usr/bin/env node
import { run } from "./run.js";

// A reader that goes away early, like `strictgen dirs | head -1`, is not an error: stop quietly.
// Any other output error can't be printed either, so it exits 1 without a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    process.exit(error.code === "EPIPE" ? (process.exitCode ?? 0) : 1);
  });
}

process.exitCode = run(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
