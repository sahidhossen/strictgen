#!/usr/bin/env node
/**
 * Checks a strictgen binary against `node dist/cli.js` from the same checkout:
 *
 *   pnpm build && node scripts/binary-smoke.mjs <binary>
 *
 * - `--version` prints the version in package.json
 * - `--help` and `llm Order --profile openai` print exactly what the Node CLI prints, so the
 *   built in profiles embedded in the binary are the ones the package ships
 * - `check` passes on examples/basic and examples/quickstart (rustfmt and gofmt on the PATH)
 * - `generate` on a copy of every example writes the same files, byte for byte, as the Node CLI
 *   on another copy, and prints the same output
 * - the binary doesn't hold the absolute path of this checkout or of the binary's folder, so no
 *   build machine's folders ship in it (Node's own build paths, from the official Node binary,
 *   are expected and not checked)
 *
 * The binary is copied into an empty temporary folder first, so it can't read anything from the
 * checkout by accident. Exit 0 when everything matches, 1 with one line per difference otherwise.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const EXAMPLES = ["basic", "report", "llm", "quickstart"];
const CHECKED = ["basic", "quickstart"];
/** Long enough for a cold rustfmt and gofmt on every generated file of an example. */
const TIMEOUT = 120_000;

const failures = [];

function call(command, args, cwd = ROOT) {
  const r = spawnSync(command, args, { cwd, encoding: "utf8", timeout: TIMEOUT });
  if (r.error !== undefined) throw new Error(`${basename(command)} ${args.join(" ")}: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** At most 200 characters of `value`, quoted, for one line of a report. */
function shown(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

function same(what, a, b) {
  for (const key of ["status", "stdout", "stderr"]) {
    if (a[key] !== b[key]) failures.push(`${what}: ${key} differs (binary ${shown(a[key])}, node ${shown(b[key])})`);
  }
}

/** Every file under `dir`, by its path from `dir` with `/` separators, sorted. */
function files(dir) {
  const found = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(dir, path).split("\\").join("/"));
    }
  };
  walk(dir);
  return found;
}

function compareTrees(a, b) {
  const left = files(a);
  const right = files(b);
  if (left.join("\n") !== right.join("\n")) {
    const only = (x, y) => x.filter((f) => !y.includes(f));
    failures.push(`generate: different files (binary only: ${only(left, right).join(", ") || "none"}; node only: ${only(right, left).join(", ") || "none"})`);
    return;
  }
  for (const f of left) {
    if (!readFileSync(join(a, f)).equals(readFileSync(join(b, f)))) failures.push(`generate: ${f} differs`);
  }
}

/** A copy of the examples and the config schema they point at, in a new temporary folder. */
function examplesCopy(scratch, name) {
  const root = join(scratch, name);
  cpSync(join(ROOT, "examples"), join(root, "examples"), { recursive: true });
  copyFileSync(join(ROOT, "strictgen.schema.json"), join(root, "strictgen.schema.json"));
  return root;
}

/**
 * The absolute build folders found in the binary's bytes: with either path separator, lower case
 * too on Windows, whose paths ignore case, each in UTF-8 and in UTF-16LE.
 */
function buildPaths(binary, folders) {
  const bytes = readFileSync(binary);
  const forms = folders.flatMap((f) => {
    const spelled = [f, f.split("\\").join("/"), f.split("/").join("\\")];
    return process.platform === "win32" ? [...spelled, ...spelled.map((p) => p.toLowerCase())] : spelled;
  });
  return [...new Set(forms)].filter(
    (f) => f.length > 1 && (bytes.includes(Buffer.from(f, "utf8")) || bytes.includes(Buffer.from(f, "utf16le"))),
  );
}

function main() {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: node scripts/binary-smoke.mjs <binary>\n");
    process.exit(2);
  }
  const scratch = mkdtempSync(join(tmpdir(), "strictgen-smoke-"));
  try {
    mkdirSync(join(scratch, "bin"));
    const binary = join(scratch, "bin", basename(process.argv[2]));
    copyFileSync(resolve(process.argv[2]), binary);
    const bin = (args, cwd) => call(binary, args, cwd);

    for (const path of buildPaths(binary, [ROOT, dirname(resolve(process.argv[2]))])) {
      failures.push(`the binary holds the build path ${shown(path)}`);
    }
    const node = (args, cwd) => call(process.execPath, [CLI, ...args], cwd);

    const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const v = bin(["--version"]);
    if (v.status !== 0 || v.stdout !== `${version}\n`) failures.push(`--version: printed ${JSON.stringify(v.stdout)}, exit ${String(v.status)}`);

    same("--help", bin(["--help"]), node(["--help"]));
    const llm = ["llm", "Order", "--profile", "openai", "--config", "examples/quickstart/strictgen.json"];
    const fromBinary = bin(llm);
    if (fromBinary.status !== 0 || fromBinary.stdout === "") failures.push(`llm --profile openai: exit ${String(fromBinary.status)}: ${shown(fromBinary.stderr)}`);
    same("llm --profile openai", fromBinary, node(llm));

    for (const example of CHECKED) {
      const c = bin(["check", "--config", `examples/${example}/strictgen.json`]);
      if (c.status !== 0) failures.push(`check ${example}: exit ${String(c.status)}: ${shown(c.stdout + c.stderr)}`);
    }

    const byBinary = examplesCopy(scratch, "binary");
    const byNode = examplesCopy(scratch, "node");
    for (const example of EXAMPLES) {
      const args = ["generate", "--config", `examples/${example}/strictgen.json`];
      const a = bin(args, byBinary);
      const b = node(args, byNode);
      if (a.status !== 0) failures.push(`generate ${example}: exit ${String(a.status)}: ${shown(a.stderr)}`);
      same(`generate ${example}`, a, b);
    }
    compareTrees(byBinary, byNode);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`binary-smoke: ${f}\n`);
    process.exit(1);
  }
  process.stdout.write("binary-smoke: the binary matches node dist/cli.js\n");
}

main();
