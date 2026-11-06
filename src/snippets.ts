/**
 * The snippets of the docs, made from real output. A Markdown file marks each one:
 *
 * ```text
 * <!-- snippet: decode json message payloads/zero-quantity.json -->
 * ...whatever this module made last time...
 * <!-- /snippet -->
 * ```
 *
 * `pnpm docs` writes every snippet again, `pnpm docs:check` fails when one is out of date. The
 * kinds:
 *
 * - `file <path>`: a file of the repository, in a code block
 * - `region <path> <name>`: the lines of a file between `docs:start <name>` and `docs:end <name>`
 * - `decl <path> <Name>`: the declaration of a type in a generated Rust, Go or TypeScript file
 * - `decode <json|llm> <message|compact> <file>...`: what the Rust, Go and TypeScript programs
 *   of `examples/quickstart` print for each payload, run for real
 * - `command <folder> <argument>...`: what `strictgen <argument>...` prints, run in that folder
 * - `rule <id>`: a schema that breaks a generation rule, the error it gives, and the fixed schema
 * - `error-code <code>`: a conformance case that fails with the code, and the error each
 *   language's decoder gives for it
 * - `profile <name>`: a table of what a built in LLM profile accepts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

import { loadManifest } from "./conformance/cases.js";
import { buildGo, buildRust, generateAll, probeToolchain, typeScriptDriver } from "./conformance/drivers.js";
import type { Driver } from "./conformance/drivers.js";
import type { Language, Request, Result } from "./conformance/protocol.js";
import { withScratch } from "./conformance/suite.js";
import { compactOf } from "./conformance/vectors.js";
import { ERROR_CODES } from "./errors.js";
import { isBuiltinProfile, PROFILE_KEYWORDS } from "./llm-profile.js";
import { builtinProfile } from "./profile-files.js";

/** The formats strictgen checks, in the order the docs list them. */
const FORMATS = ["date-time", "date", "uuid"] as const;
import { run } from "./run.js";
import { RULE_EXAMPLES } from "./snippets-rules.js";
import type { RuleExample } from "./snippets-rules.js";

/** One marked snippet in a Markdown file: its spec and the lines it spans, markers excluded. */
export interface Marker {
  readonly spec: string;
  /** The index of the line after the start marker. */
  readonly from: number;
  /** The index of the end marker. */
  readonly to: number;
}

/** A docs file or a snippet that can't be made. */
export class SnippetError extends Error {}

const START = /^<!-- snippet: (.+?) -->$/;
const END = "<!-- /snippet -->";

/** The marked snippets of a Markdown text, in order. Throws on a start without an end, or the other way. */
export function markers(text: string, file: string): Marker[] {
  const lines = text.split("\n");
  const found: Marker[] = [];
  let open: { spec: string; line: number } | undefined;
  lines.forEach((line, i) => {
    const start = START.exec(line);
    if (start !== null) {
      if (open !== undefined) throw new SnippetError(`${file}:${String(i + 1)}: a snippet starts inside the one of line ${String(open.line + 1)}`);
      open = { spec: start[1] ?? "", line: i };
    } else if (line === END) {
      if (open === undefined) throw new SnippetError(`${file}:${String(i + 1)}: a snippet end without a start`);
      found.push({ spec: open.spec, from: open.line + 1, to: i });
      open = undefined;
    } else if (line.includes("<!-- snippet")) {
      throw new SnippetError(`${file}:${String(i + 1)}: a snippet marker must be a line of its own, like <!-- snippet: file a.json -->`);
    }
  });
  if (open !== undefined) throw new SnippetError(`${file}:${String(open.line + 1)}: a snippet without an end`);
  return found;
}

/** The text with every snippet replaced by what `make` gives for its spec. */
export async function fill(text: string, file: string, make: (spec: string) => Promise<string>): Promise<string> {
  const lines = text.split("\n");
  const out: string[] = [];
  let next = 0;
  for (const m of markers(text, file)) {
    out.push(...lines.slice(next, m.from));
    const body = await make(m.spec);
    out.push(...(body === "" ? [] : body.replace(/\n$/, "").split("\n")));
    next = m.to;
  }
  out.push(...lines.slice(next));
  return out.join("\n");
}

/** A code block. */
export function fence(lang: string, body: string): string {
  const text = body.replace(/\n+$/, "");
  if (text.includes("```")) throw new SnippetError("a snippet holds three backticks, which would end its code block");
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

const LANG_OF: Readonly<Record<string, string>> = { json: "json", rs: "rust", go: "go", ts: "ts", toml: "toml" };

function langOf(path: string): string {
  return LANG_OF[path.slice(path.lastIndexOf(".") + 1)] ?? "text";
}

/** The lines between `docs:start <name>` and `docs:end <name>`, with their common indent taken off. */
export function region(text: string, name: string, file: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim().endsWith(`docs:start ${name}`));
  const end = lines.findIndex((l, i) => i > start && l.trim().endsWith(`docs:end ${name}`));
  if (start < 0 || end < 0) throw new SnippetError(`${file}: no region ${name}`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(indent)).join("\n");
}

/**
 * The declaration of the type `name` in a generated Rust, Go or TypeScript file: its doc comment
 * and attributes, and its body up to the closing brace at the start of a line.
 */
export function declaration(text: string, name: string, file: string): string {
  const lines = text.split("\n");
  const head = file.endsWith(".rs")
    ? new RegExp(`^pub (struct|enum|type) ${name}\\b`)
    : file.endsWith(".go")
      ? new RegExp(`^type ${name}\\b`)
      : new RegExp(`^export (interface|type) ${name}\\b`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) throw new SnippetError(`${file}: no declaration of ${name}`);
  let first = at;
  const comment = (l: string): boolean => /^(\/\/|#\[| \*|\/\*\*)/.test(l);
  while (first > 0 && comment(lines[first - 1] ?? "")) first--;
  let last = at;
  const line = lines[at] ?? "";
  if (line.endsWith("{")) {
    while (last < lines.length && lines[last] !== "}" && lines[last] !== "};") last++;
  } else {
    while (last < lines.length && !(lines[last] ?? "").trimEnd().endsWith(";") && file.endsWith(".ts")) last++;
  }
  return lines.slice(first, last + 1).join("\n");
}

/** What a command printed, with the folder it ran in left out of every line. */
interface Ran {
  readonly status: number;
  readonly out: string[];
  readonly err: string[];
}

/** Runs the CLI in a folder, as `strictgen <args>` would from a shell there. */
export function cli(folder: string, args: readonly string[]): Ran {
  const out: string[] = [];
  const err: string[] = [];
  const status = run(args, { cwd: folder, env: { ...process.env, NO_COLOR: "1" }, out: (l) => out.push(l), err: (l) => err.push(l) });
  // Paths under the folder are shown relative to it, like a shell there shows them.
  const local = (l: string): string => l.split(`${folder}/`).join("").split(folder).join(".");
  return { status, out: out.map(local), err: err.map(local) };
}

/** A JSON value on one line, with a space after each comma and colon and inside braces. */
function flatJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(flatJson).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${flatJson(v)}`).join(", ")} }`;
}

/** A JSON value as the docs show it: two space indent, short objects and arrays on one line. */
export function prettyJson(value: unknown, indent = ""): string {
  const flat = flatJson(value);
  if (flat.length + indent.length <= 88 || value === null || typeof value !== "object") return flat;
  const inner = `${indent}  `;
  if (Array.isArray(value)) return `[\n${value.map((v) => `${inner}${prettyJson(v, inner)}`).join(",\n")}\n${indent}]`;
  const entries = Object.entries(value as Record<string, unknown>);
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${prettyJson(v, inner)}`).join(",\n")}\n${indent}}`;
}

/** The header every rule example schema gets, so it only shows what the rule is about. */
function withHeader(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  if ("$id" in schema) return schema;
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `https://example.com/schemas/${name}`, ...schema };
}

/** The files of a rule example, written into `folder`. */
function writeExample(folder: string, files: RuleExample["files"], config: Record<string, unknown>): void {
  mkdirSync(join(folder, "schemas"), { recursive: true });
  writeFileSync(join(folder, "strictgen.json"), `${JSON.stringify(config, null, 2)}\n`);
  for (const [name, schema] of Object.entries(files)) {
    const path = join(folder, "schemas", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof schema === "string" ? schema : `${JSON.stringify(withHeader(name, schema), null, 2)}\n`);
  }
}

const RULE_CONFIG = { schemas: "schemas", targets: { typescript: { out: "out/ts" } } };

/** Runs `strictgen generate` on a rule example in a new temporary folder. */
function runExample(example: RuleExample, files: RuleExample["files"]): Ran {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "strictgen-docs-")));
  try {
    writeExample(folder, files, { ...RULE_CONFIG, ...example.config });
    example.setup?.(folder);
    return cli(folder, example.args ?? ["generate"]);
  } finally {
    // A folder an example made read only has to be writable again to go.
    spawnSync("chmod", ["-R", "u+w", folder]);
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The files of an example as the docs show them. */
function showFiles(files: RuleExample["files"]): string {
  return Object.entries(files)
    .map(([name, schema]) =>
      typeof schema === "string" ? `\`${name}\`:\n\n${fence("text", schema)}` : `\`${name}\`:\n\n${fence("json", prettyJson(schema))}`,
    )
    .join("\n\n");
}

/** The `rule <id>` snippet: the schema, the error, and the fix, each checked by running it. */
export function ruleSnippet(id: string): string {
  const example = (RULE_EXAMPLES as Readonly<Record<string, RuleExample | null | undefined>>)[id];
  if (example === undefined || example === null) throw new SnippetError(`no example for the rule ${id} in src/snippets-rules.ts`);
  const broken = runExample(example, example.files);
  const lines = broken.err
    .filter((l) => l.includes(`: ${id}: `) || l.startsWith(`error: ${id}: `))
    // What follows is V8's JSON.parse message, whose words change between Node versions.
    .map((l) => l.replace(/(: invalid-json: not valid JSON: ).+$/, "$1<the JSON.parse message>"));
  if (broken.status === 0 || lines.length === 0) {
    throw new SnippetError(`the example of ${id} doesn't fail with it: exit ${String(broken.status)}, ${broken.err.join(" | ")}`);
  }
  const config = example.config === undefined ? [] : [`\`strictgen.json\`:\n\n${fence("json", prettyJson({ ...RULE_CONFIG, ...example.config }))}`];
  const parts = [...config, showFiles(example.files), fence("text", lines.join("\n"))];
  if (example.fixed !== undefined) {
    const fixed = runExample(example, example.fixed);
    if (fixed.status !== 0) throw new SnippetError(`the fixed example of ${id} still fails: ${fixed.err.join(" | ")}`);
    parts.push(`Fixed:\n\n${showFiles(example.fixed)}`);
  }
  return parts.join("\n\n");
}

/** The `profile <name>` snippet: what a built in profile keeps and how it maps. */
export function profileSnippet(name: string): string {
  if (!isBuiltinProfile(name)) throw new SnippetError(`no built in profile ${name}`);
  const p = builtinProfile(name);
  const limits = Object.entries(p.limits ?? {}).map(([k, v]) => `\`${k}\` ${typeof v === "object" ? `${String(v.values)} values, ${String(v.maxSize)} characters` : String(v)}`);
  // Every constraint the provider doesn't take goes into the description as a hint, and only
  // the decoder checks it. A const it doesn't take is written as an enum of one value instead.
  const moved: string[] = PROFILE_KEYWORDS.filter((k) => k !== "const" && !p.keywords.has(k));
  const unlisted = FORMATS.filter((f) => !p.keywords.has("format") || !p.formats.has(f));
  moved.push(...unlisted.map((f) => `format: ${f}`));
  const maximums = Object.entries(p.keywordMaximums ?? {}).map(([k, v]) => `\`${k}\` up to ${String(v)}`);
  const rows = [
    ["Version", `${String(p.version)}, checked ${p.date}`],
    ["Keywords kept", p.keywords.size === 0 ? "none" : [...p.keywords].map((k) => `\`${k}\``).join(", ")],
    ["Not accepted", moved.length === 0 ? "none" : moved.map((k) => `\`${k}\``).join(", ")],
    ["`const`", p.keywords.has("const") ? "kept" : "written as an `enum` of one value"],
    ["Formats", p.formats.size === 0 ? "none" : [...p.formats].map((f) => `\`${f}\``).join(", ")],
    ["Keyword maximums", maximums.length === 0 ? "none" : maximums.join(", ")],
    ["Maps", p.maps === "entries" ? "an array of `{ key, value }` entries" : "an object"],
    ["Recursive types", p.recursion ? "yes" : "no"],
    ["Limits", limits.length === 0 ? "none" : limits.join(", ")],
    ["Sources", p.sources.map((s) => `<${s.url}>`).join(", ")],
  ];
  return ["| | |", "| - | - |", ...rows.map(([k, v]) => `| ${k ?? ""} | ${v ?? ""} |`)].join("\n");
}

/** The languages, as the docs name them. */
const SHOWN: Readonly<Record<Language, string>> = { rust: "Rust", go: "Go", ts: "TypeScript" };

function spawn(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 10 * 60_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
  if (result.error !== undefined) throw new SnippetError(`${command} ${args.join(" ")} could not run in ${cwd}: ${result.error.message}`);
  if (result.status !== 0) throw new SnippetError(`${command} ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Lines a quickstart program printed, by payload file, from `file <name>` headings. */
function byFile(text: string, rename: (file: string) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("file ")) {
      current = [];
      out.set(rename(line.slice(5)), current);
    } else if (current === undefined) throw new SnippetError(`a quickstart program printed ${line} before a file`);
    else current.push(line);
  }
  return out;
}

/** The folder of each decoder's inputs in `examples/quickstart`. */
const INPUTS = { json: "payloads", llm: "answers" } as const;
type Decoder = keyof typeof INPUTS;

/** Runs the quickstart programs of every language on every input of a decoder. */
async function quickstart(root: string, decoder: Decoder): Promise<Map<Language, Map<string, string[]>>> {
  const example = join(root, "examples", "quickstart");
  const folder = INPUTS[decoder];
  const files = readdirSync(join(example, folder)).filter((n) => n.endsWith(".json")).sort().map((n) => `${folder}/${n}`);
  const up = files.map((f) => `../${f}`);
  const fromProgram = (f: string): string => f.replace(/^\.\.\//, "");
  const results = new Map<Language, Map<string, string[]>>();
  results.set("rust", byFile(spawn("cargo", ["run", "--quiet", "--locked", "--", decoder, ...up], join(example, "rust")), fromProgram));
  results.set("go", byFile(spawn("go", ["run", ".", decoder, ...up], join(example, "go"), { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod" }), fromProgram));
  const scratch = mkdtempSync(join(tmpdir(), "strictgen-docs-"));
  try {
    writeFileSync(join(scratch, "package.json"), '{ "type": "module" }\n');
    const ts_ = join(example, "ts");
    const sources = ["decode.ts", ...readdirSync(join(ts_, "generated")).filter((n) => n.endsWith(".ts")).map((n) => `generated/${n}`)];
    for (const s of sources) {
      const out = join(scratch, s.replace(/\.ts$/, ".js"));
      mkdirSync(dirname(out), { recursive: true });
      const source = readFileSync(join(ts_, s), "utf8");
      writeFileSync(out, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText);
    }
    const module = (await import(pathToFileURL(join(scratch, "decode.js")).href)) as { decode: (decoder: string, text: string) => string[] };
    results.set("ts", new Map(files.map((f) => [f, module.decode(decoder, readFileSync(join(example, f), "utf8"))])));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // A difference here is a bug in strictgen: the proof suite should have caught it.
  for (const f of files) {
    const [first, ...rest] = [...results.values()].map((r) => JSON.stringify(r.get(f)));
    if (rest.some((r) => r !== first)) {
      throw new SnippetError(`the languages disagree on examples/quickstart/${f}: ${[...results].map(([l, r]) => `${l} ${JSON.stringify(r.get(f))}`).join(", ")}`);
    }
  }
  return results;
}

/** The toolchains `pnpm docs` needs, as one line for a run without them. */
export const TOOLCHAINS_NEEDED = "needs Rust 1.97.0 (RUSTUP_TOOLCHAIN=1.97.0) and Go";

/** The Rust the docs are made with: CI's, whose rustfmt formats the explain output. */
const RUST_VERSION = /^rustc 1\.97\.\d+ /;

/**
 * Checks that Rust 1.97 with rustfmt, and Go, run, and throws one SnippetError naming what is
 * missing, rather than a raw ENOENT or a cargo error about an edition later.
 */
export function checkToolchains(env: NodeJS.ProcessEnv = process.env): void {
  const version = (command: string, args: readonly string[]): string | undefined => {
    const r = spawnSync(command, args, { env, encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
    return r.error === undefined && r.status === 0 ? r.stdout.trim() : undefined;
  };
  const rustc = version("rustc", ["--version"]);
  let problem: string | undefined;
  if (rustc === undefined) problem = "rustc is not installed or doesn't run";
  else if (!RUST_VERSION.test(rustc)) problem = `found ${rustc}`;
  else if (version("rustfmt", ["--version"]) === undefined) problem = "rustfmt is not installed for that toolchain";
  else if (version("cargo", ["--version"]) === undefined) problem = "cargo doesn't run";
  else if (version("go", ["version"]) === undefined) problem = "go is not installed or doesn't run";
  if (problem !== undefined) throw new SnippetError(`${TOOLCHAINS_NEEDED}: ${problem}`);
}

/** The one code whose message differs by language: each names the integer range it holds. */
const RANGE_CODE = "out_of_range_integer";

/** One conformance case an error code section shows. */
export interface CodeCase {
  readonly type: string;
  /** Under `conformance/cases`. */
  readonly file: string;
}

/**
 * The conformance case each error code's section shows: a small one, made of printable
 * characters. Every code in ERROR_CODES has one, which a test checks.
 */
export const CODE_CASES: Readonly<Record<string, CodeCase>> = {
  unknown_key: { type: "Item", file: "Item/invalid/unknown-key.json" },
  missing_key: { type: "Note", file: "Note/invalid/missing-text.json" },
  null_not_allowed: { type: "Bundle", file: "Bundle/invalid/label-null.json" },
  wrong_type: { type: "Code", file: "Code/invalid/number.json" },
  bad_tag: { type: "Payment", file: "Payment/invalid/unknown-tag.json" },
  not_in_enum: { type: "Role", file: "Role/invalid/not-in-enum.json" },
  not_const: { type: "Bundle", file: "Bundle/invalid/version-other.json" },
  too_short: { type: "Line", file: "Line/invalid/sku-below-minimum.json" },
  too_long: { type: "Code", file: "Code/invalid/four.json" },
  too_small: { type: "Line", file: "Line/invalid/count-below-minimum.json" },
  too_large: { type: "PercentOff", file: "PercentOff/invalid/over-100.json" },
  not_multiple_of: { type: "Order", file: "Order/invalid/pack-size-not-a-multiple.json" },
  pattern_mismatch: { type: "TrackingNumber", file: "TrackingNumber/invalid/lower-case.json" },
  bad_format: { type: "Day", file: "Day/invalid/leap-day-in-2100.json" },
  not_unique: { type: "LabelCodes", file: "LabelCodes/invalid/repeat.json" },
  out_of_range_integer: { type: "Event", file: "Event/invalid/attempt-above-int64-maximum.json" },
  invalid_json: { type: "ShopOrder", file: "ShopOrder/invalid/invalid-json-in-unknown-value.json" },
  duplicate_key: { type: "Bundle", file: "Bundle/invalid/meta-key-twice.json" },
  too_deep: { type: "Bundle", file: "Bundle/invalid/meta-empty-array-past-depth-limit.json" },
};

interface CodeRun {
  readonly results: ReadonlyMap<Language, Result>;
  /** Where the type is declared, like `common.json#/$defs/code`. */
  readonly source: string;
}

/** Decodes every case of CODE_CASES in Rust, Go and TypeScript through the conformance drivers. */
async function codeRuns(root: string): Promise<Map<string, CodeRun>> {
  const conformance = join(root, "conformance");
  for (const l of ["rust", "go"] as const) probeToolchain(l);
  return withScratch(false, async (out) => {
    const manifest = loadManifest(join(conformance, "manifest.json"));
    const packages = generateAll(conformance, out, new Set(manifest.llm.keys())).filter((p) => p.name === "strict");
    const pkg = packages[0];
    if (pkg === undefined) throw new SnippetError("the conformance run has no strict package");
    const drivers: Driver[] = [buildRust(conformance, out, packages), buildGo(conformance, out, packages), typeScriptDriver(out, packages)];
    const codes = Object.keys(CODE_CASES);
    const requests: Request[] = codes.map((code, id) => {
      const c = CODE_CASES[code] as CodeCase;
      const hex = readFileSync(join(conformance, "cases", c.file)).toString("hex");
      // The registry entry, so Go's answer for text that isn't JSON is the DecodeError, not
      // json.Unmarshal's own SyntaxError.
      return { id, type: c.type, mode: "strict", decoder: "normal", entry: "registry", package: pkg.name, hex };
    });
    const answers = new Map(drivers.map((d) => [d.language, d.run(requests)] as const));
    return new Map(
      codes.map((code, i) => {
        const c = CODE_CASES[code] as CodeCase;
        const key = pkg.types.get(c.type)?.key;
        if (key === undefined) throw new SnippetError(`no conformance type ${c.type}`);
        const slash = key.indexOf("/");
        const source = slash < 0 ? `${key}.json#` : `${key.slice(0, slash)}.json#/$defs/${key.slice(slash + 1)}`;
        const results = new Map([...answers].map(([l, r]) => [l, r[i] as Result] as const));
        return [code, { results, source }] as const;
      }),
    );
  });
}

/** The longest payload an error code section shows whole. */
const PAYLOAD_MAX = 400;

/** Text cut to `max` characters, with what was left out said. */
function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... (${String(text.length - max)} more characters)`;
}

/** Makes snippets for one docs run, running each slow thing once. */
export class Snippets {
  private readonly decodes = new Map<Decoder, Promise<Map<Language, Map<string, string[]>>>>();
  private codes: Promise<Map<string, CodeRun>> | undefined;

  constructor(readonly root: string) {}

  async make(spec: string): Promise<string> {
    const [kind, ...args] = spec.split(" ").filter((a) => a !== "");
    const path = (p: string | undefined): string => {
      if (p === undefined) throw new SnippetError(`${spec}: a path is missing`);
      return join(this.root, p);
    };
    switch (kind) {
      case "file": {
        const [p] = args;
        return fence(langOf(p ?? ""), readFileSync(path(p), "utf8"));
      }
      case "region": {
        const [p, name] = args;
        return fence(langOf(p ?? ""), region(readFileSync(path(p), "utf8"), name ?? "", p ?? ""));
      }
      case "decl": {
        const [p, name] = args;
        return fence(langOf(p ?? ""), declaration(readFileSync(path(p), "utf8"), name ?? "", p ?? ""));
      }
      case "decode":
        return this.decode(spec, args);
      case "command": {
        const [folder, ...rest] = args;
        const ran = cli(path(folder), rest);
        return fence("text", [`$ strictgen ${rest.join(" ")}`, ...ran.out, ...ran.err].join("\n"));
      }
      case "rule":
        return ruleSnippet(args[0] ?? "");
      case "error-code":
        return this.errorCode(args[0] ?? "");
      case "profile":
        return profileSnippet(args[0] ?? "");
      default:
        throw new SnippetError(`unknown snippet kind in "${spec}"`);
    }
  }

  private async decode(spec: string, args: readonly string[]): Promise<string> {
    const [decoder, field, ...files] = args;
    if ((decoder !== "json" && decoder !== "llm") || (field !== "message" && field !== "compact") || files.length === 0) {
      throw new SnippetError(`${spec}: expected decode <json|llm> <message|compact> <file>...`);
    }
    let runs = this.decodes.get(decoder);
    if (runs === undefined) {
      runs = quickstart(this.root, decoder);
      this.decodes.set(decoder, runs);
    }
    const results = await runs;
    const blocks = files.map((f) => {
      const rows = [...results].map(([language, r]) => {
        const lines = r.get(f);
        if (lines === undefined) throw new SnippetError(`${spec}: no input ${f} in examples/quickstart`);
        const ok = lines.find((l) => l.startsWith("ok "));
        const shown = ok ?? lines.find((l) => l.startsWith(field === "message" ? "error " : "compact "));
        if (shown === undefined) throw new SnippetError(`${spec}: ${language} printed ${lines.join(" | ")}`);
        return `${SHOWN[language].padEnd(12)}${shown.startsWith("ok ") ? shown : shown.slice(shown.indexOf(" ") + 1)}`;
      });
      return [f, ...rows.map((r) => `  ${r}`)].join("\n");
    });
    return fence("text", blocks.join("\n\n"));
  }

  private async errorCode(code: string): Promise<string> {
    const c = CODE_CASES[code];
    if (c === undefined || !ERROR_CODES.some((e) => e.code === code)) throw new SnippetError(`no case for the error code ${code}`);
    this.codes ??= codeRuns(this.root);
    const ran = (await this.codes).get(code);
    if (ran === undefined) throw new SnippetError(`no run for ${code}`);
    const rows = [...ran.results].map(([language, r]) => {
      if (r.error === null) throw new SnippetError(`${language} accepted conformance/cases/${c.file}`);
      if (r.error.code !== code) throw new SnippetError(`${language} failed conformance/cases/${c.file} with ${r.error.code}, not ${code}`);
      return [language, r.error] as const;
    });
    // Only out_of_range_integer names a range of its own in each language; every other code
    // gives one message, which the conformance suite holds equal too.
    const messages = new Set(rows.map(([, e]) => e.message));
    if (messages.size !== 1 && code !== RANGE_CODE) throw new SnippetError(`the languages disagree on conformance/cases/${c.file}`);
    const compact = messages.size === 1 ? rows.slice(0, 1) : rows;
    const payload = readFileSync(join(this.root, "conformance", "cases", c.file), "utf8").trim();
    const link = `[\`${c.file}\`](../conformance/cases/${c.file})`;
    const labelled = [
      ...rows.map(([l, e]) => [SHOWN[l], e.message] as const),
      ...compact.map(([l, e]) => [messages.size === 1 ? "compact" : `${SHOWN[l]} compact`, compactOf(e)] as const),
    ];
    const width = Math.max(...labelled.map(([label]) => label.length)) + 2;
    return [
      `The case ${link}, decoded as \`${c.type}\` (\`${ran.source}\` in [\`conformance/schemas\`](../conformance/schemas)):`,
      "",
      // A payload cut short is no longer JSON, so it shows as text.
      payload.length <= PAYLOAD_MAX ? fence("json", payload) : fence("text", cut(payload, PAYLOAD_MAX)),
      "",
      fence("text", labelled.map(([label, text]) => `${label.padEnd(width)}${text}`).join("\n")),
    ].join("\n");
  }
}

/** The Markdown files that hold snippets, relative to the repository root. */
export function docsFiles(root: string): string[] {
  return ["README.md", ...readdirSync(join(root, "docs")).filter((n) => n.endsWith(".md")).sort().map((n) => `docs/${n}`)];
}

/** Every docs file whose snippets are out of date, with its new text. */
export async function staleFiles(root: string): Promise<{ file: string; text: string }[]> {
  const snippets = new Snippets(root);
  const stale: { file: string; text: string }[] = [];
  for (const file of docsFiles(root)) {
    const before = readFileSync(join(root, file), "utf8");
    const after = await fill(before, file, (spec) => snippets.make(spec));
    if (after !== before) stale.push({ file, text: after });
  }
  return stale;
}

/** The path of a file under the root, as messages show it. */
export function shown(root: string, file: string): string {
  return relative(root, join(root, file));
}
