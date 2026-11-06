#!/usr/bin/env node
/**
 * Checks the npm package before it is ever published:
 *
 *   pnpm build && node scripts/package-check.mjs
 *
 * 1. `npm pack --dry-run` lists exactly the expected files: package.json, README.md, LICENSE,
 *    CHANGELOG.md, every file in profiles/, and `dist/<module>.js` and `dist/<module>.d.ts` for
 *    every module directly in src/ except tests and the docs snippet tools. So nothing from
 *    dist/conformance (the proof suite and its TypeScript runner), no source maps and no
 *    playground output. A new folder in src/ fails until this list says where it goes
 * 2. Every relative import of a packed module points at a packed file
 * 3. The packed tarball installs into an empty project with npm --offline (it has no
 *    dependencies, so nothing but the tarball is read), and there `npx strictgen --version`
 *    prints the version, `strictgen llm ... --profile openai` finds its built in profile, and
 *    `import("strictgen")` loads the API
 *
 * Exit 0 when all hold, 1 with one line per problem otherwise.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Always in the package. */
const FIXED = ["CHANGELOG.md", "LICENSE", "README.md", "package.json"];
/** Folders of src/ and why none of their modules ship. */
const SRC_FOLDERS = {
  __snapshots__: "test snapshots",
  conformance: "the proof suite and fuzzer, run from a checkout",
};
/** Modules directly in src/ that don't ship: the docs snippet tools, run from a checkout. */
const NOT_SHIPPED = /^snippets(-[a-z]+)?\.ts$/;
const TIMEOUT = 120_000;

const problems = [];

function npm(args, cwd) {
  // npm is a .cmd file on Windows; the shell finds it there. This check runs on Linux in CI.
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", timeout: TIMEOUT, shell: process.platform === "win32" });
  if (r.error !== undefined) throw new Error(`npm ${args.join(" ")}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} exited with ${String(r.status)}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** The files the package must hold, sorted. */
export function expectedFiles(root) {
  const files = [...FIXED];
  for (const name of readdirSync(join(root, "profiles"))) files.push(`profiles/${name}`);
  for (const name of readdirSync(join(root, "src"))) {
    if (statSync(join(root, "src", name)).isDirectory()) {
      if (!(name in SRC_FOLDERS)) problems.push(`src/${name}/ is new: say in scripts/package-check.mjs whether it ships`);
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || NOT_SHIPPED.test(name)) continue;
    const module = name.slice(0, -".ts".length);
    files.push(`dist/${module}.js`, `dist/${module}.d.ts`);
  }
  return files.sort();
}

/** The relative imports of a module's text, static, `export from` and dynamic, as TypeScript reads them. */
function relativeImports(text) {
  return ts
    .preProcessFile(text, true, true)
    .importedFiles.map((f) => f.fileName)
    .filter((name) => name.startsWith("./") || name.startsWith("../"));
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const packed = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], ROOT))[0].files.map((f) => f.path).sort();
  const expected = expectedFiles(ROOT);
  for (const f of packed) if (!expected.includes(f)) problems.push(`packed but not expected: ${f}`);
  for (const f of expected) if (!packed.includes(f)) problems.push(`expected but not packed: ${f}`);

  for (const f of packed.filter((p) => p.endsWith(".js"))) {
    for (const spec of relativeImports(readFileSync(join(ROOT, f), "utf8"))) {
      const target = posix.normalize(posix.join(posix.dirname(f), spec));
      if (!packed.includes(target)) problems.push(`${f} imports ${spec}, which isn't packed`);
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), "strictgen-pack-"));
  try {
    const out = join(scratch, "tarball");
    mkdirSync(out);
    const tarball = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", out], ROOT))[0].filename;
    const project = join(scratch, "project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: "pack-check", private: true, type: "module" })}\n`);
    npm(["install", "--offline", "--no-audit", "--no-fund", "--save-dev", join(out, tarball)], project);

    const version = npm(["exec", "--offline", "--no", "--", "strictgen", "--version"], project);
    if (version !== `${pkg.version}\n`) problems.push(`npx strictgen --version printed ${JSON.stringify(version)}, not ${pkg.version}`);
    const config = join(ROOT, "examples", "quickstart", "strictgen.json");
    const llm = npm(["exec", "--offline", "--no", "--", "strictgen", "llm", "Order", "--profile", "openai", "--config", config], project);
    if (!llm.startsWith("{")) problems.push(`strictgen llm --profile openai printed ${JSON.stringify(llm.slice(0, 80))}`);
    const api = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'const m = await import("strictgen"); if (typeof m.buildModel !== "function") process.exit(1);'],
      { cwd: project, encoding: "utf8", timeout: TIMEOUT },
    );
    if (api.status !== 0) problems.push(`import("strictgen") failed: ${(api.stderr ?? "").trim()}`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`package-check: ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(`package-check: ${String(packed.length)} files packed as expected; the tarball installs and runs\n`);
}

main();
