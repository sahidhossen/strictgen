// Regenerates the example under examples/basic from its schemas and `strictgen.json`, or checks
// that the committed output matches. Runs against the built package, so `pnpm build` first:
//
//   node --experimental-strip-types scripts/examples.ts           write the output
//   node --experimental-strip-types scripts/examples.ts --check   fail if the output differs
//
// `pnpm examples` and `pnpm examples:check` build and run it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { OutputFile } from "../dist/index.js";
import {
  configTargets,
  generateProject,
  isGenerated,
  loadConfig,
  mainOptions,
  writeOutput,
} from "../dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "basic");
/** The example's config, read with the same loader the CLI uses. */
const CONFIG = loadConfig(join(ROOT, "strictgen.json"));
/**
 * TypeScript and Rust write to folders they own. Go shares its folder with the hand written
 * `go.mod` and fixture tests, so only the generated files there are replaced.
 */
const TARGETS = configTargets(CONFIG);

function run(): OutputFile[] {
  return generateProject(mainOptions(CONFIG));
}

/** Every file below `dir`, as paths relative to the example root. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(ROOT, path)];
  });
}

/** The differences between `files` and what is on disk, one line each. */
function differences(files: readonly OutputFile[]): string[] {
  const out: string[] = [];
  const expected = new Set(files.map((f) => f.path));
  for (const file of files) {
    const path = join(ROOT, file.path);
    if (!existsSync(path)) out.push(`missing: ${file.path}`);
    else if (readFileSync(path, "utf8") !== file.contents) out.push(`differs: ${file.path}`);
  }
  const owned = TARGETS.flatMap((t) => t.dirs).flatMap((dir) => walk(join(ROOT, dir)));
  const shared = TARGETS.flatMap((t) => t.shared ?? []).flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name))
      .filter((path) => isGenerated(readFileSync(join(ROOT, path), "utf8"), CONFIG.header)),
  );
  for (const path of [...owned, ...shared].sort()) {
    if (!expected.has(path.split("\\").join("/"))) out.push(`stale: ${path}`);
  }
  return out;
}

const check = process.argv.includes("--check");
const files = run();
const again = run();
if (JSON.stringify(files) !== JSON.stringify(again)) {
  process.stderr.write("examples: two runs gave different output\n");
  process.exit(1);
}
if (check) {
  const found = differences(files);
  if (found.length > 0) {
    process.stderr.write(
      `examples: the committed output is out of date, run pnpm examples\n${found.join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`examples: ${String(files.length)} files up to date\n`);
} else {
  writeOutput(CONFIG.root, TARGETS, files, CONFIG.header, [CONFIG.schemas, CONFIG.file]);
  process.stdout.write(`examples: wrote ${String(files.length)} files\n`);
}
