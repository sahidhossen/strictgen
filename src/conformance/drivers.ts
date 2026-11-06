/**
 * Generates every language for the conformance schemas into a temporary folder, once per
 * generated package (a read mode, and the LLM map shapes the code reads, see `packages`), builds
 * one Rust and one Go driver binary over them, and runs requests through each: every driver is a
 * process that reads a batch over stdin, TypeScript a Node process running `ts-runner.ts`, so a
 * timeout stops any of them. Every driver answers in the format of `protocol.ts`.
 */

import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import type { Config } from "../config.js";
import { parseConfig } from "../config.js";
import { GO_FIXTURES } from "../emit-go.js";
import { configModel } from "../examples.js";
import { goLlmName, rustLlmName } from "../llm-decoders.js";
import type { Decl, Model } from "../model.js";
import { configTargets } from "../targets.js";
import type { Language, Maps, Mode, Request, Result } from "./protocol.js";
import { DriverError, MAPS, MODES, packageName, parseResult, requestLine } from "./protocol.js";
import type { TsModule } from "./ts-runner.js";
import { RUNNER_START, runRequest, RunnerError } from "./ts-runner.js";

/** How long building one driver may take, a cold Rust build included. */
export const BUILD_TIMEOUT = 15 * 60_000;
/** How long one driver may take for a whole batch of requests. */
export const RUN_TIMEOUT = 5 * 60_000;
/** How long `cargo --version` or `go version` may take. */
const PROBE_TIMEOUT = 60_000;

/** A toolchain a driver needs is missing or broken. */
export class ToolchainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolchainError";
  }
}

/** The ID rule of the conformance schemas, as in `examples/basic`. */
const IDS = { file: "common", suffix: "Id" };

/** The built in profiles that give each set of map shapes. */
export const MAPS_PROFILES: Readonly<Record<Maps, readonly string[]>> = {
  both: ["openai", "anthropic", "gemini"],
  entries: ["openai"],
  objects: ["gemini"],
};

/** The folder, under the scratch folder, that holds the schemas the LLM packages are generated from. */
export const LLM_SCHEMAS = "llm-schemas";

/**
 * One generated package: what it is generated from and how. `maps` is set for code generated
 * with `llm`, whose LLM decoders read those map shapes; `vectors` for `examples/llm`, generated
 * with its own config, cleanup step included.
 */
export interface Build {
  readonly mode: Mode;
  readonly maps?: Maps;
  readonly vectors?: true;
}

/**
 * Every package a run generates: the normal decoders in both read modes without `llm`, as most
 * users generate them; with `llm` reading both map shapes in both read modes; with `llm` reading
 * one shape only; and `examples/llm` in report mode, so its shared vectors run in report mode in
 * every language.
 */
export const BUILDS: readonly Build[] = [
  ...MODES.map((mode) => ({ mode })),
  ...MODES.map((mode) => ({ mode, maps: "both" as const })),
  ...MAPS.filter((m) => m !== "both").map((maps) => ({ mode: "strict" as const, maps })),
  { mode: "report", vectors: true },
];

/** The `examples/llm` folder, beside the `conformance` folder. */
export function vectorsFolder(conformance: string): string {
  return join(conformance, "..", "examples", "llm");
}

/** The targets of one package under `out`. */
function targetsOf(name: string, mode: Mode): Record<string, unknown> {
  return {
    typescript: { out: `ts/${name}`, read: mode },
    rust: { out: `rust/src/${name}`, read: mode },
    go: { out: `go/${name}`, package: name, fixtures: true, read: mode },
  };
}

/**
 * The config that generates every language for one package under `out`. The LLM packages read
 * the schemas `writeLlmSchemas` copied, the vectors package `examples/llm` with its own profiles
 * and cleanup step.
 */
export function conformanceConfig(conformance: string, out: string, build: Build | Mode): Config {
  const b: Build = typeof build === "string" ? { mode: build } : build;
  const name = packageName({ ...b, decoder: "normal", entry: "public" });
  const file = join(out, "strictgen.json");
  if (b.vectors === true) {
    const folder = vectorsFolder(conformance);
    const raw = JSON.parse(readFileSync(join(folder, "strictgen.json"), "utf8")) as { llm?: { profiles?: unknown; cleanup?: unknown } };
    return parseConfig(
      {
        schemas: join(folder, "schemas"),
        targets: targetsOf(name, b.mode),
        llm: { profiles: raw.llm?.profiles, out: `llm/${name}`, cleanup: raw.llm?.cleanup },
      },
      file,
    );
  }
  return parseConfig(
    {
      schemas: b.maps === undefined ? join(conformance, "schemas") : join(out, LLM_SCHEMAS),
      ids: IDS,
      targets: targetsOf(name, b.mode),
      ...(b.maps === undefined ? {} : { llm: { profiles: MAPS_PROFILES[b.maps], out: `llm/${name}` } }),
    },
    file,
  );
}

/** The model of the conformance schemas, the same in every read mode. */
export function conformanceModel(conformance: string, out: string): Model {
  return configModel(conformanceConfig(conformance, out, "strict")).model;
}

/**
 * Copies the schemas the LLM packages are generated from to `out`: every conformance schema but
 * the `excluded` ones, whose types no provider-ready schema can describe.
 */
export function writeLlmSchemas(conformance: string, out: string, excluded: ReadonlySet<string>): void {
  const from = join(conformance, "schemas");
  const to = join(out, LLM_SCHEMAS);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from).sort()) {
    if (name.endsWith(".json") && !excluded.has(name)) copyFileSync(join(from, name), join(to, name));
  }
}

/**
 * A type a case folder may name: its key in the fixture registry, and the tagged union it is,
 * itself or through aliases, whose Go functions (`DecodeX`, `ReportX`) decode it.
 */
export interface CaseType {
  readonly key: string;
  readonly tagged: string | undefined;
}

/** The tagged union a declaration is, itself or as an alias of one. */
function taggedOf(model: Model, decl: Decl): string | undefined {
  let d: Decl | undefined = decl;
  const seen = new Set<string>();
  while (d !== undefined && !seen.has(d.name)) {
    seen.add(d.name);
    if (d.kind === "tagged") return d.name;
    if (d.kind !== "alias" || d.type.kind !== "ref") return undefined;
    const name: string = d.type.name;
    d = model.decls.find((x) => x.name === name);
  }
  return undefined;
}

/** The types a case folder may name: those with their own schema root or `$defs` entry. */
export function caseTypes(model: Model): Map<string, CaseType> {
  return new Map(
    model.decls.flatMap((d) =>
      d.source === undefined
        ? []
        : [
            [
              d.name,
              {
                key: d.source.def === undefined ? d.source.schema : `${d.source.schema}/${d.source.def}`,
                tagged: taggedOf(model, d),
              },
            ] as const,
          ],
    ),
  );
}

/** One generated package, by its name in every language. */
export interface Package {
  readonly name: string;
  readonly build: Build;
  readonly model: Model;
  /** The types requests may name, each with an LLM decoder when the package has `llm`. */
  readonly types: ReadonlyMap<string, CaseType>;
  readonly llm: boolean;
  readonly cleanup: boolean;
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * Writes the generated code of every language and package under `out`, the provider-ready
 * schemas of the LLM packages included, with the Go fixture registry as a normal file, so the
 * driver can use it. The LLM packages leave out the `excluded` schemas.
 */
export function generateAll(conformance: string, out: string, excluded: ReadonlySet<string> = new Set()): Package[] {
  writeLlmSchemas(conformance, out, excluded);
  return BUILDS.map((build) => {
    const config = conformanceConfig(conformance, out, build);
    const { schemas, model } = configModel(config);
    for (const file of configTargets(config).flatMap((t) => t.emit(model, schemas))) {
      const path = file.path.endsWith(`/${GO_FIXTURES}`) ? file.path.replace(/_test\.go$/, ".go") : file.path;
      write(join(out, path), file.contents);
    }
    return {
      name: packageName({ ...build, decoder: "normal", entry: "public" }),
      build,
      model,
      types: caseTypes(model),
      llm: config.llm !== undefined,
      cleanup: config.llm?.cleanup === true,
    };
  });
}

interface Spawned {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException;
}

/** Runs a command, with stdin and stdout from file descriptors when given. */
function spawn(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number; stdin?: number; stdout?: number },
): Spawned {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin ?? "ignore", options.stdout ?? "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout,
    killSignal: "SIGKILL",
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error === undefined ? {} : { error: result.error as NodeJS.ErrnoException }),
  };
}

/** The last non-empty lines of a command's output, as one line. */
function tail(text: string, lines = 6): string {
  const kept = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-lines);
  return kept.length === 0 ? "no output" : kept.join(" | ");
}

/** Throws a clean error for a command that didn't run or failed. */
function check(what: string, result: Spawned, timeout: number): void {
  if (result.error?.code === "ETIMEDOUT") {
    throw new DriverError(`${what} took longer than ${String(timeout / 1000)}s and was stopped`);
  }
  if (result.error !== undefined) throw new DriverError(`${what} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DriverError(`${what} failed (exit ${String(result.status)}): ${tail(result.stderr)}`);
  }
}

const TOOLCHAINS: Readonly<Record<"rust" | "go", { command: string; args: string[]; install: string }>> = {
  rust: { command: "cargo", args: ["--version"], install: "install Rust 1.97 or later" },
  go: { command: "go", args: ["version"], install: "install Go 1.23 or later" },
};

/** The environment Go runs in: no toolchain download behind the runner's back. */
function goEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" };
}

/** Checks that the toolchain a binary driver needs runs, and returns its version line. */
export function probeToolchain(language: "rust" | "go"): string {
  const { command, args, install } = TOOLCHAINS[language];
  const result = spawn(command, args, { timeout: PROBE_TIMEOUT, env: language === "go" ? goEnv() : process.env });
  const leaveOut = `or leave ${language === "rust" ? "Rust" : "Go"} out with --lang`;
  if (result.error?.code === "ENOENT" || result.error?.code === "EACCES") {
    throw new ToolchainError(`${command} is not installed or not on PATH: ${install}, ${leaveOut}`);
  }
  if (result.error !== undefined || result.status !== 0) {
    // A rustup proxy without a toolchain exits non-zero here.
    throw new ToolchainError(
      `${command} ${args.join(" ")} failed: ${tail(result.stderr || (result.error?.message ?? ""), 2)}. ${install}, ${leaveOut}`,
    );
  }
  return result.stdout.trim().split("\n")[0] ?? command;
}

/** The Rust library over the generated packages: one module per package. */
function rustLib(packages: readonly Package[]): string {
  const mods = packages
    .map((p) => p.name)
    .sort()
    .map((n) => `pub mod ${n};\n`)
    .join("");
  return `//! The Rust code strictgen generates for the conformance schemas, one module per package.
//!
//! Written by the conformance runner, beside the generated modules, before it builds the crate.

${mods}`;
}

/** The Rust dispatch: a package and a type name to the generated decoder, the LLM decoder and the cleanup step. */
function rustDispatch(packages: readonly Package[]): string {
  const normal: string[] = [];
  const llm: string[] = [];
  const clean: string[] = [];
  for (const p of packages) {
    const macro = p.build.mode === "strict" ? "strict_outcome" : "report_outcome";
    for (const t of [...p.types.keys()].sort()) {
      normal.push(`        (${JSON.stringify(p.name)}, ${JSON.stringify(t)}) => ${macro}!(${p.name}, ${t}, json),\n`);
      if (p.llm) llm.push(`        (${JSON.stringify(p.name)}, ${JSON.stringify(t)}) => llm_outcome!(${p.name}::${rustLlmName(t)}(text)),\n`);
    }
    if (p.cleanup) clean.push(`        ${JSON.stringify(p.name)} => ${p.name}::clean_llm_json(text),\n`);
  }
  const uses = packages
    .map((p) => p.name)
    .sort()
    .join(", ");
  return `//! Written by the conformance runner: maps a package and a type name to the generated code.

use conformance_driver::{${uses}};

use crate::Outcome;

/// Decodes \`json\` as the type named \`ty\` of \`package\`, or \`None\` when there is no such type.
#[allow(clippy::too_many_lines, reason = "one arm per package and type")]
pub fn decode(package: &str, ty: &str, json: &[u8]) -> Option<Outcome> {
    Some(match (package, ty) {
${normal.join("")}        _ => return None,
    })
}

/// Decodes \`text\` with the LLM decoder of the type named \`ty\` of \`package\`, or \`None\`
/// when the package has no such decoder.
#[allow(clippy::too_many_lines, reason = "one arm per package and type")]
pub fn llm(package: &str, ty: &str, text: &str) -> Option<Outcome> {
    Some(match (package, ty) {
${llm.join("")}        _ => return None,
    })
}

/// Runs the cleanup step of \`package\` on \`text\`, or \`None\` when the package has none.
pub fn clean(package: &str, text: &str) -> Option<String> {
    Some(match package {
${clean.join("")}        _ => return None,
    })
}
`;
}

/** The public Go entry point for one type in one read mode, as a function literal. */
function goPublic(mode: Mode, name: string, type: CaseType): string {
  const sig = "func(data []byte) (any, []string, error)";
  if (mode === "strict") {
    return type.tagged !== undefined
      ? `${sig} { v, err := Decode${type.tagged}(data); return v, []string{}, err }`
      : `${sig} { v := new(${name}); err := json.Unmarshal(data, v); return *v, []string{}, err }`;
  }
  return type.tagged !== undefined
    ? `${sig} { r, err := Report${type.tagged}(data); return r.Value, r.Unknown, err }`
    : `${sig} { r, err := Report[${name}](data); return r.Value, r.Unknown, err }`;
}

function byName<T>(entries: Iterable<readonly [string, T]>): (readonly [string, T])[] {
  return [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function goConform(p: Package): string {
  const mode = p.build.mode;
  const types = byName(p.types);
  const keys = types.map(([t, c]) => `\t${JSON.stringify(t)}: ${JSON.stringify(c.key)},\n`).join("");
  const publics = types.map(([t, c]) => `\t${JSON.stringify(t)}: ${goPublic(mode, t, c)},\n`).join("");
  const llms = p.llm
    ? types.map(([t]) => `\t${JSON.stringify(t)}: func(data []byte) (any, error) { v, err := ${goLlmName(t)}(data); return v, err },\n`).join("")
    : "";
  const unmarshals = mode === "strict" && types.some(([, c]) => c.tagged === undefined);
  const registry =
    mode === "report"
      ? `\t\tvalue, unknown, err = decode(data)`
      : `\t\tvalue, err = decode(data)
\t\tunknown = []string{}`;
  const clean = p.cleanup
    ? `func ConformanceClean(data []byte) (out []byte, ok bool) {
\treturn CleanLLMJSON(data), true
}`
    : `func ConformanceClean([]byte) (out []byte, ok bool) {
\treturn nil, false
}`;
  return `// Written by the conformance runner.

package ${p.name}

import (
${unmarshals ? '\t"encoding/json"\n' : ""}\t"errors"
)

// conformanceKeys maps each type a case may name to its key in the fixture registry.
var conformanceKeys = map[string]string{
${keys}}

// conformancePublic maps each type a case may name to a decode through its public entry point.
var conformancePublic = map[string]func(data []byte) (any, []string, error){
${publics}}

// conformanceLlm maps each type a case may name to its LLM decoder, when the package has them.
var conformanceLlm = map[string]func(data []byte) (any, error){
${llms}}

// ConformanceDecode decodes data as the type named typ, through the public entry point or the
// fixture registry, and returns the value with the paths of its unknown keys. ok is false when
// there is no such type or entry.
func ConformanceDecode(typ, entry string, data []byte) (value any, unknown []string, ok bool, err error) {
\tswitch entry {
\tcase "public":
\t\tdecode, found := conformancePublic[typ]
\t\tif !found {
\t\t\treturn nil, nil, false, nil
\t\t}
\t\tvalue, unknown, err = decode(data)
\tcase "registry":
\t\tkey, found := conformanceKeys[typ]
\t\tif !found {
\t\t\treturn nil, nil, false, nil
\t\t}
\t\tdecode, found := fixtureDecoders()[key]
\t\tif !found {
\t\t\treturn nil, nil, false, nil
\t\t}
${registry}
\tdefault:
\t\treturn nil, nil, false, nil
\t}
\tif unknown == nil {
\t\tunknown = []string{}
\t}
\treturn value, unknown, true, err
}

// ConformanceLlm decodes data with the LLM decoder of the type named typ. ok is false when the
// package has no such decoder.
func ConformanceLlm(typ string, data []byte) (value any, ok bool, err error) {
\tdecode, found := conformanceLlm[typ]
\tif !found {
\t\treturn nil, false, nil
\t}
\tvalue, err = decode(data)
\treturn value, true, err
}

// ConformanceClean runs the cleanup step on data. ok is false when the package has none.
${clean}

// ConformanceFields returns the fields of a *DecodeError, and false for any other error.
func ConformanceFields(err error) (path, code, expected, found string, ok bool) {
\tvar e *DecodeError
\tif !errors.As(err, &e) {
\t\treturn "", "", "", "", false
\t}
\treturn e.Path, e.Code, e.Expected, e.Found, true
}
`;
}

/** The Go driver's table of packages, by name. */
function goPackages(packages: readonly Package[]): string {
  const sorted = packages.map((p) => p.name).sort();
  const imports = sorted.map((n) => `\t"conformance/${n}"\n`).join("");
  const rows = sorted
    .map((n) => `\t${JSON.stringify(n)}: {${n}.ConformanceDecode, ${n}.ConformanceLlm, ${n}.ConformanceClean, ${n}.ConformanceFields},\n`)
    .join("");
  return `// Written by the conformance runner: the generated packages, by name.

package main

import (
${imports})

var packages = map[string]generated{
${rows}}
`;
}

/** A driver that answers a batch of requests. */
export interface Driver {
  readonly language: Language;
  readonly run: (requests: readonly Request[]) => Result[];
}

/** Runs a binary driver over a batch: requests from a file on stdin, results to a file on stdout. */
export function binaryDriver(language: Language, binary: string, scratch: string, timeout = RUN_TIMEOUT, args: readonly string[] = []): Driver {
  return {
    language,
    run: (requests) => {
      const input = join(scratch, `${language}-requests.jsonl`);
      const output = join(scratch, `${language}-results.jsonl`);
      writeFileSync(input, requests.map((r) => `${requestLine(r)}\n`).join(""));
      const stdin = openSync(input, "r");
      const stdout = openSync(output, "w");
      let result: Spawned;
      try {
        result = spawn(binary, args, { timeout, stdin, stdout });
      } finally {
        closeSync(stdin);
        closeSync(stdout);
      }
      check(`the ${language} driver`, result, timeout);
      const lines = readFileSync(output, "utf8").split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (lines.length !== requests.length) {
        throw new DriverError(
          `the ${language} driver wrote ${String(lines.length)} results for ${String(requests.length)} requests`,
        );
      }
      return requests.map((r, i) => parseResult(lines[i] ?? "", language, r.id));
    },
  };
}

/** The folder Cargo builds the Rust driver in, kept between runs so only the generated code rebuilds. */
export function cargoTarget(conformance: string): string {
  return join(conformance, "driver", "rust", "target");
}

/** Builds the Rust driver over the code `generateAll` wrote under `out`. */
export function buildRust(conformance: string, out: string, packages: readonly Package[]): Driver {
  const driver = join(conformance, "driver", "rust");
  const crate = join(out, "rust");
  for (const file of ["Cargo.toml", "Cargo.lock", "src/main.rs"]) {
    mkdirSync(dirname(join(crate, file)), { recursive: true });
    copyFileSync(join(driver, file), join(crate, file));
  }
  write(join(crate, "src", "lib.rs"), rustLib(packages));
  write(join(crate, "src", "dispatch.rs"), rustDispatch(packages));
  const target = cargoTarget(conformance);
  const result = spawn("cargo", ["build", "--locked", "--quiet"], {
    cwd: crate,
    env: { ...process.env, CARGO_TARGET_DIR: target },
    timeout: BUILD_TIMEOUT,
  });
  check("cargo build of the Rust driver", result, BUILD_TIMEOUT);
  return binaryDriver("rust", join(target, "debug", process.platform === "win32" ? "conformance-driver.exe" : "conformance-driver"), out);
}

/** Builds the Go driver over the code `generateAll` wrote under `out`. */
export function buildGo(conformance: string, out: string, packages: readonly Package[]): Driver {
  const driver = join(conformance, "driver", "go");
  const module = join(out, "go");
  for (const file of ["go.mod", "main.go"]) copyFileSync(join(driver, file), join(module, file));
  for (const p of packages) write(join(module, p.name, "conform.go"), goConform(p));
  write(join(module, "packages.go"), goPackages(packages));
  const binary = join(out, "bin", process.platform === "win32" ? "conformance-driver.exe" : "conformance-driver");
  const result = spawn("go", ["build", "-o", binary, "."], { cwd: module, env: goEnv(), timeout: BUILD_TIMEOUT });
  check("go build of the Go driver", result, BUILD_TIMEOUT);
  return binaryDriver("go", binary, out);
}

export type { Fn, TsModule } from "./ts-runner.js";

/** Transpiles the TypeScript `generateAll` wrote for one package, beside it, for the runner to import. */
function transpilePackage(out: string, name: string): void {
  const dir = join(out, "ts", name);
  writeFileSync(join(out, "package.json"), '{ "type": "module" }\n');
  for (const file of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    writeFileSync(join(dir, file.replace(/\.ts$/, ".js")), transpile(readFileSync(join(dir, file), "utf8")));
  }
}

function transpile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
}

/**
 * Writes the TypeScript runner (`ts-runner.ts`) as JavaScript into `out`, from the built module
 * next to this one, or from its source when the runner runs from source, as under vitest.
 */
function writeRunner(out: string): string {
  const here = new URL(import.meta.url);
  const fromSource = here.pathname.endsWith(".ts");
  const source = readFileSync(fileURLToPath(new URL(fromSource ? "./ts-runner.ts" : "./ts-runner.js", here)), "utf8");
  const file = join(out, "ts-runner.mjs");
  writeFileSync(file, `${fromSource ? transpile(source) : source}${RUNNER_START}`);
  return file;
}

/**
 * Runs one request through the generated TypeScript in this process, as the runner does in its
 * own. `modules` are by package name. For tests: the runs go through {@link typeScriptDriver}.
 */
export function runTs(modules: Readonly<Record<string, TsModule>>, request: Request): Result {
  try {
    return runRequest(modules, request);
  } catch (error) {
    if (error instanceof RunnerError) throw new DriverError(error.message);
    throw error;
  }
}

/**
 * The TypeScript driver over the code `generateAll` wrote under `out`: a Node process per batch,
 * running `ts-runner.ts`, stopped like the binaries when a batch takes longer than `timeout`.
 */
export function typeScriptDriver(out: string, packages: readonly Package[], timeout = RUN_TIMEOUT): Driver {
  for (const p of packages) transpilePackage(out, p.name);
  const runner = writeRunner(out);
  return binaryDriver("ts", process.execPath, out, timeout, [runner, out, ...packages.map((p) => p.name)]);
}
