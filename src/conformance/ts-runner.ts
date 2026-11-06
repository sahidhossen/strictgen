/**
 * Runs conformance requests through the generated TypeScript, in a process of its own, so a
 * decoder that never returns (a catastrophic regex, an endless loop) is stopped by the same
 * timeout as the Rust and Go drivers, and a whole batch runs in one process.
 *
 * `drivers.ts` writes this module, as JavaScript, into the scratch folder with a call of
 * {@link runnerMain} at the end ({@link RUNNER_START}), and runs it as
 * `node ts-runner.mjs <out> <package>...`: it imports the generated TypeScript of each package
 * (transpiled under `<out>/ts/<package>/`), reads the request lines on stdin and writes one
 * result line per request on stdout, in the format of `protocol.ts`. A request it can't run is a
 * broken driver: it writes why on stderr and exits 2.
 *
 * It has no imports of its own but Node's, since it runs from the scratch folder. The names it
 * shares with the rest of the runner, like the crash code and the LLM decoder names, are checked
 * against theirs by its tests.
 */

import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ErrorFields, Request, Result } from "./protocol.js";

export type Fn = (...args: unknown[]) => unknown;

/** The generated TypeScript of one package, by export name. */
export interface TsModule {
  readonly fn: (name: string) => Fn;
  readonly DecodeError: abstract new (...args: never[]) => Error;
}

/** A request the runner can't run: the driver is broken, not the decoder. */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

/** The error code of a decoder that threw something other than its DecodeError (protocol.ts CRASH). */
export const RUNNER_CRASH = "crash";

/** The TypeScript LLM decoder of a type (llm-decoders.ts tsLlmName). */
export const runnerLlmName = (type: string): string => `decode${type}FromLlm`;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Runs one request through the generated TypeScript, as the binaries do. `modules` are by package name. */
export function runRequest(modules: Readonly<Record<string, TsModule>>, request: Request): Result {
  // decodeXFromJson and reportXFromJson are the public entry points, and what the fixture tests
  // call, so both entries decode the same way.
  if (request.entry !== "public" && request.entry !== "registry") throw new RunnerError(`entry ${String(request.entry)} is not supported`);
  if (request.decoder !== "normal" && request.decoder !== "llm" && request.decoder !== "cleanup") {
    throw new RunnerError(`decoder ${String(request.decoder)} is not supported`);
  }
  const m = modules[request.package];
  if (m === undefined) throw new RunnerError(`no generated package ${request.package}`);
  const rejected = (error: ErrorFields): Result => ({
    id: request.id,
    accepted: false,
    error,
    unknown: null,
    encoded: null,
    encodeError: null,
  });
  const crash = (message: string): Result => rejected({ path: "", code: RUNNER_CRASH, expected: null, found: null, message });
  let text: string;
  try {
    text = UTF8.decode(new Uint8Array(Buffer.from(request.hex, "hex")));
  } catch {
    // The TypeScript decoders take a string, so bytes that aren't UTF-8 never reach them. The
    // runner only sends text to the LLM decoders and the cleanup step, as the other drivers need.
    if (request.decoder !== "normal") throw new RunnerError(`the ${request.decoder} input of request ${String(request.id)} is not UTF-8`);
    return rejected({ path: "", code: "invalid_json", expected: null, found: null, message: "not UTF-8 text" });
  }
  if (request.decoder === "cleanup") {
    let cleaned: unknown;
    try {
      cleaned = m.fn("cleanLlmJson")(text);
    } catch (error) {
      return crash(String(error));
    }
    if (typeof cleaned !== "string") return crash("cleanLlmJson returned no string");
    return { id: request.id, accepted: true, error: null, unknown: [], encoded: cleaned, encodeError: null };
  }
  const decode =
    request.decoder === "llm"
      ? m.fn(runnerLlmName(request.type))
      : request.mode === "report"
        ? m.fn(`report${request.type}FromJson`)
        : m.fn(`decode${request.type}FromJson`);
  const encode = m.fn(`encode${request.type}ToJson`);
  let value: unknown;
  let unknown: readonly string[] = [];
  try {
    const decoded = decode(text);
    // An LLM decoder is strict in every read mode, and returns the value alone.
    if (request.mode === "report" && request.decoder === "normal") {
      ({ value, unknown } = decoded as { value: unknown; unknown: string[] });
    } else {
      value = decoded;
    }
  } catch (error) {
    if (!(error instanceof m.DecodeError)) return crash(String(error));
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

/** Imports the transpiled TypeScript of one package under `out`. */
async function importPackage(out: string, name: string): Promise<TsModule> {
  const module = (await import(pathToFileURL(join(out, "ts", name, "index.js")).href)) as Record<string, unknown>;
  const value = (fn: string): unknown => {
    if (!(fn in module)) throw new RunnerError(`the generated TypeScript of ${name} exports no ${fn}`);
    return module[fn];
  };
  return { fn: (fn) => value(fn) as Fn, DecodeError: value("DecodeError") as TsModule["DecodeError"] };
}

/** One request line, checked only as far as the runner needs; the parent wrote it. */
function parseRequest(line: string, index: number): Request {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new RunnerError(`request line ${String(index + 1)} is not JSON`);
  }
  const r = value as Partial<Record<keyof Request, unknown>>;
  if (
    typeof r !== "object" ||
    r === null ||
    typeof r.id !== "number" ||
    typeof r.type !== "string" ||
    typeof r.package !== "string" ||
    typeof r.hex !== "string" ||
    typeof r.mode !== "string" ||
    typeof r.decoder !== "string" ||
    typeof r.entry !== "string"
  ) {
    throw new RunnerError(`request line ${String(index + 1)} is not a request`);
  }
  return value as Request;
}

/** Writes all of `text` to a file descriptor, however many writes it takes. */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
}

/** What `drivers.ts` appends to the copy it runs, so importing this module never runs it. */
export const RUNNER_START = "\nprocess.exitCode = await runnerMain(process.argv.slice(2));\n";

/** The command line: `node ts-runner.mjs <out> <package>...`, requests on stdin. */
export async function runnerMain(args: readonly string[]): Promise<number> {
  try {
    const [out, ...names] = args;
    if (out === undefined || names.length === 0) throw new RunnerError("usage: ts-runner <out> <package>...");
    const modules: Record<string, TsModule> = {};
    for (const name of names) modules[name] = await importPackage(out, name);
    const lines = readFileSync(0, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const results = lines.map((line, i) => JSON.stringify(runRequest(modules, parseRequest(line, i))));
    writeAll(1, results.map((r) => `${r}\n`).join(""));
    return 0;
  } catch (error) {
    writeAll(2, `${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
