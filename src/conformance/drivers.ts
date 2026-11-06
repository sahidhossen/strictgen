/**
 * Generates every language for the conformance schemas into a temporary folder, once per read
 * mode, builds one Rust and one Go driver binary over them, and runs requests through each:
 * the binaries read a batch over stdin, TypeScript runs in process. Every driver answers in the
 * format of `protocol.ts`.
 */

import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import type { Config } from "../config.js";
import { parseConfig } from "../config.js";
import { GO_FIXTURES } from "../emit-go.js";
import { configModel } from "../examples.js";
import type { Model } from "../model.js";
import { configTargets } from "../targets.js";
import type { ErrorFields, Language, Mode, Request, Result } from "./protocol.js";
import { CRASH, DriverError, MODES, parseResult, requestLine } from "./protocol.js";

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

/** The config that generates every language for the conformance schemas in one read mode, under `out`. */
export function conformanceConfig(conformance: string, out: string, mode: Mode): Config {
  return parseConfig(
    {
      schemas: join(conformance, "schemas"),
      ids: IDS,
      targets: {
        typescript: { out: `ts/${mode}`, read: mode },
        rust: { out: `rust/src/${mode}`, read: mode },
        go: { out: `go/${mode}`, package: mode, fixtures: true, read: mode },
      },
    },
    join(out, "strictgen.json"),
  );
}

/** The model of the conformance schemas, the same in every read mode. */
export function conformanceModel(conformance: string, out: string): Model {
  return configModel(conformanceConfig(conformance, out, "strict")).model;
}

/** A type a case folder may name: its key in the fixture registry, and whether it is a tagged union. */
export interface CaseType {
  readonly key: string;
  readonly tagged: boolean;
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
                tagged: d.kind === "tagged",
              },
            ] as const,
          ],
    ),
  );
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * Writes the generated code of every language and read mode under `out`, with the Go fixture
 * registry as a normal file, so the driver can use it.
 */
export function generateAll(conformance: string, out: string): void {
  for (const mode of MODES) {
    const config = conformanceConfig(conformance, out, mode);
    const { schemas, model } = configModel(config);
    for (const file of configTargets(config).flatMap((t) => t.emit(model, schemas))) {
      const path = file.path.endsWith(`/${GO_FIXTURES}`) ? file.path.replace(/_test\.go$/, ".go") : file.path;
      write(join(out, path), file.contents);
    }
  }
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

function rustDispatch(types: readonly string[]): string {
  const arms = MODES.flatMap((mode) =>
    types.map((t) => `        (${JSON.stringify(mode)}, ${JSON.stringify(t)}) => crate::run_${mode}::<${mode}::${t}>(json),\n`),
  );
  return `//! Written by the conformance runner: maps a read mode and a type name to the generated type.

use conformance_driver::{report, strict};

use crate::Outcome;

/// Decodes \`json\` as the type named \`ty\` in \`mode\`, or \`None\` when there is no such type.
pub fn decode(mode: &str, ty: &str, json: &[u8]) -> Option<Outcome> {
    Some(match (mode, ty) {
${arms.join("")}        _ => return None,
    })
}
`;
}

/** The public Go entry point for one type in one read mode, as a function literal. */
function goPublic(mode: Mode, name: string, type: CaseType): string {
  const sig = "func(data []byte) (any, []string, error)";
  if (mode === "strict") {
    return type.tagged
      ? `${sig} { v, err := Decode${name}(data); return v, []string{}, err }`
      : `${sig} { v := new(${name}); err := json.Unmarshal(data, v); return *v, []string{}, err }`;
  }
  return type.tagged
    ? `${sig} { r, err := Report${name}(data); return r.Value, r.Unknown, err }`
    : `${sig} { r, err := Report[${name}](data); return r.Value, r.Unknown, err }`;
}

function goConform(mode: Mode, types: ReadonlyMap<string, CaseType>): string {
  const keys = [...types].map(([t, c]) => `\t${JSON.stringify(t)}: ${JSON.stringify(c.key)},\n`).join("");
  const publics = [...types].map(([t, c]) => `\t${JSON.stringify(t)}: ${goPublic(mode, t, c)},\n`).join("");
  const unmarshals = mode === "strict" && [...types.values()].some((c) => !c.tagged);
  const registry =
    mode === "report"
      ? `\t\tvalue, unknown, err = decode(data)`
      : `\t\tvalue, err = decode(data)
\t\tunknown = []string{}`;
  return `// Written by the conformance runner.

package ${mode}

import (
${unmarshals ? '\t"encoding/json"\n' : ""}\t"errors"
)

// conformanceKeys maps each type a case may name to its key in the fixture registry.
var conformanceKeys = map[string]string{
${keys}}

// conformancePublic maps each type a case may name to a decode through its public entry point.
var conformancePublic = map[string]func(data []byte) (any, []string, error){
${publics}}

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

/** A driver that answers a batch of requests. */
export interface Driver {
  readonly language: Language;
  readonly run: (requests: readonly Request[]) => Result[];
}

/** Runs a binary driver over a batch: requests from a file on stdin, results to a file on stdout. */
export function binaryDriver(language: Language, binary: string, scratch: string, timeout = RUN_TIMEOUT): Driver {
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
        result = spawn(binary, [], { timeout, stdin, stdout });
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
export function buildRust(conformance: string, out: string, types: readonly string[]): Driver {
  const driver = join(conformance, "driver", "rust");
  const crate = join(out, "rust");
  for (const file of ["Cargo.toml", "Cargo.lock", "src/main.rs", "src/lib.rs"]) {
    mkdirSync(dirname(join(crate, file)), { recursive: true });
    copyFileSync(join(driver, file), join(crate, file));
  }
  write(join(crate, "src", "dispatch.rs"), rustDispatch(types));
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
export function buildGo(conformance: string, out: string, types: ReadonlyMap<string, CaseType>): Driver {
  const driver = join(conformance, "driver", "go");
  const module = join(out, "go");
  for (const file of ["go.mod", "main.go"]) copyFileSync(join(driver, file), join(module, file));
  for (const mode of MODES) write(join(module, mode, "conform.go"), goConform(mode, types));
  const binary = join(out, "bin", process.platform === "win32" ? "conformance-driver.exe" : "conformance-driver");
  const result = spawn("go", ["build", "-o", binary, "."], { cwd: module, env: goEnv(), timeout: BUILD_TIMEOUT });
  check("go build of the Go driver", result, BUILD_TIMEOUT);
  return binaryDriver("go", binary, out);
}

export type Fn = (...args: unknown[]) => unknown;

/** The generated TypeScript of one read mode, by export name. */
export interface TsModule {
  readonly fn: (name: string) => Fn;
  readonly DecodeError: abstract new (...args: never[]) => Error;
}

/** Transpiles the TypeScript `generateAll` wrote for one mode, and imports it. */
async function loadTypeScript(out: string, mode: Mode): Promise<TsModule> {
  const dir = join(out, "ts", mode);
  writeFileSync(join(out, "package.json"), '{ "type": "module" }\n');
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const js = ts.transpileModule(readFileSync(join(dir, name), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    }).outputText;
    writeFileSync(join(dir, name.replace(/\.ts$/, ".js")), js);
  }
  const module = (await import(pathToFileURL(join(dir, "index.js")).href)) as Record<string, unknown>;
  const value = (name: string): unknown => {
    if (!(name in module)) throw new DriverError(`the generated TypeScript exports no ${name}`);
    return module[name];
  };
  return { fn: (name) => value(name) as Fn, DecodeError: value("DecodeError") as TsModule["DecodeError"] };
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Runs one request through the generated TypeScript, as the binaries do. */
export function runTs(modules: Readonly<Record<Mode, TsModule>>, request: Request): Result {
  if (request.decoder !== "normal") throw new DriverError(`decoder ${request.decoder} is not supported`);
  // decodeXFromJson and reportXFromJson are the public entry points, and what the fixture tests
  // call, so both entries decode the same way.
  if (request.entry !== "public" && request.entry !== "registry") throw new DriverError(`entry ${String(request.entry)} is not supported`);
  const m = modules[request.mode];
  const rejected = (error: ErrorFields): Result => ({
    id: request.id,
    accepted: false,
    error,
    unknown: null,
    encoded: null,
    encodeError: null,
  });
  let text: string;
  try {
    text = UTF8.decode(hexBytes(request.hex));
  } catch {
    // The TypeScript decoders take a string, so bytes that aren't UTF-8 never reach them.
    return rejected({ path: "", code: "invalid_json", expected: null, found: null, message: "not UTF-8 text" });
  }
  const decode = request.mode === "report" ? m.fn(`report${request.type}FromJson`) : m.fn(`decode${request.type}FromJson`);
  const encode = m.fn(`encode${request.type}ToJson`);
  let value: unknown;
  let unknown: readonly string[] = [];
  try {
    const decoded = decode(text);
    if (request.mode === "report") {
      ({ value, unknown } = decoded as { value: unknown; unknown: string[] });
    } else {
      value = decoded;
    }
  } catch (error) {
    if (!(error instanceof m.DecodeError)) {
      return rejected({ path: "", code: CRASH, expected: null, found: null, message: String(error) });
    }
    const e = error as unknown as { path: string; code: string; expected?: string; found?: string };
    return rejected({
      path: e.path,
      code: e.code,
      expected: e.expected ?? null,
      found: e.found ?? null,
      message: error.message,
    });
  }
  try {
    return { id: request.id, accepted: true, error: null, unknown, encoded: encode(value) as string, encodeError: null };
  } catch (error) {
    return {
      id: request.id,
      accepted: true,
      error: null,
      unknown,
      encoded: null,
      encodeError: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The TypeScript driver, in process, over the code `generateAll` wrote under `out`. */
export async function typeScriptDriver(out: string): Promise<Driver> {
  const modules = { strict: await loadTypeScript(out, "strict"), report: await loadTypeScript(out, "report") };
  return { language: "ts", run: (requests) => requests.map((r) => runTs(modules, r)) };
}
