import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { BreakingError, breaking, breakingJson, breakingLines, breaksAnything } from "./breaking.js";
import { differences } from "./check.js";
import type { Config } from "./config.js";
import { ConfigError, configFolders, DOCS_FORMATS, loadConfig } from "./config.js";
import type { DocsFormat } from "./config.js";
import { configModel, examples, UnknownTypeError, writeDocs } from "./examples.js";
import { ExplainError, explain, explained, explanationLines } from "./explain.js";
import { fixCommand } from "./fix-command.js";
import { formatFiles, FormatterFailedError, FormatterMissingError } from "./format.js";
import { fsReason, isFsError } from "./fs-error.js";
import { LlmError, llmProjection } from "./llm.js";
import { changeLines, schemaText } from "./llm-project.js";
import type { OutputFile } from "./main.js";
import { generateProject, writeOutput } from "./main.js";
import { GenerateError } from "./payloads.js";
import type { JsonObject } from "./schema.js";
import { CodegenError } from "./schema.js";
import { serdeFallbacks } from "./emit-rust.js";
import { mainOptions } from "./targets.js";

/** Exit codes: success, generation failed or `check` found a difference, bad usage or config. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Where the CLI reads and writes, so tests can run it in process. */
export interface Io {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** One line of normal output, without its newline. */
  readonly out: (line: string) => void;
  /** One line of notices and errors, without its newline. */
  readonly err: (line: string) => void;
}

interface Command {
  readonly summary: string;
  readonly usage: string;
  readonly details: readonly string[];
  readonly options: readonly string[];
}

const CONFIG_OPTION = "  --config <path>  The config file. Default: strictgen.json in the current folder";
const HELP_OPTION = "  -h, --help       Show this help";

const COMMANDS: Readonly<Record<string, Command>> = {
  generate: {
    summary: "Write every target, formatted (the default command)",
    usage: "strictgen [generate] [--config <path>]",
    details: [
      "Generates every target the config lists, runs each language's formatter (format.rust,",
      "format.go) on it in memory, then writes it. A formatter that isn't installed is skipped with",
      "a notice. When a formatter fails, nothing is written.",
    ],
    options: [CONFIG_OPTION, HELP_OPTION],
  },
  check: {
    summary: "Exit 1 if the generated files on disk are out of date. For CI",
    usage: "strictgen check [--config <path>]",
    details: [
      "Generates and formats in memory, compares with the files on disk and lists every file",
      "that differs, is missing or is stale. Writes nothing. Every configured formatter must be",
      "installed, so the result is the same on every machine.",
    ],
    options: [CONFIG_OPTION, HELP_OPTION],
  },
  explain: {
    summary: "Show how one schema type maps in each configured language",
    usage: "strictgen explain <file.json[#/pointer]> [--json] [--config <path>]",
    details: [
      "Prints the model of the type at a schema location, like user.json#/$defs/address, or",
      "user.json for a root, and its declaration in every configured target, formatted the way",
      "generate writes it. When the type can't be generated, prints the rule it breaks and a",
      "hint. Exits 1 when generation fails, and 2 for an unknown file or pointer.",
    ],
    options: [
      "  --json           Print the model and each target's code or error as JSON",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
  examples: {
    summary: "Print valid or near-miss sample payloads for one type",
    usage: "strictgen examples <type> [--count <n>] [--seed <s>] [--invalid] [--array] [--config <path>]",
    details: [
      "Prints payloads of the type named as in the generated code, like Order, one JSON value per",
      "line. They keep every rule and constraint of the schema, and the same seed gives the same",
      "output. With --invalid, prints near misses instead, each one change away from valid, as",
      "{ path, code, change, payload }: the error every decoder reports for it, and what changed.",
      "Payloads hold in the read mode of every target. Exits 1 when the type has no payload the",
      "generator is sure of, like a pattern it can't match within the length limits.",
    ],
    options: [
      "  --count <n>      How many payloads, from 1 to 10000. Default: 1",
      "  --seed <s>       The seed, an integer from 0 to 4294967295. Default: 0",
      "  --invalid        Print near misses with their expected error",
      "  --array          Print one JSON array instead of one payload per line",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
  docs: {
    summary: "Write a documentation page per type, or one HTML page",
    usage: "strictgen docs [--format markdown|html] [--config <path>]",
    details: [
      "Writes a Markdown page per type and index.md, or one self-contained index.html, into the",
      "folder docs.out names: each type's description, fields, type in every configured language,",
      "constraints, a valid example and links to the types it uses. The folder is shared: only",
      "files that start with the header are replaced or removed, so hand-written pages stay.",
    ],
    options: [
      "  --format <f>     markdown or html. Default: docs.format, else markdown",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
  breaking: {
    summary: "Compare the schemas with an older version and say who each change breaks",
    usage: "strictgen breaking --base <git ref or folder> [--json] [--config <path>]",
    details: [
      "Compares the schemas with the ones in a folder, or at a git ref of the repository that",
      "holds the config (read with git, nothing is checked out), and lists every change by who it",
      "breaks: all consumers, strict consumers, producers, or nobody. A folder wins over a ref of",
      "the same name. Exits 1 when anything breaks, 0 otherwise, and 2 for a base that can't be",
      "loaded. docs/breaking-changes.md has the rules.",
    ],
    options: [
      "  --base <ref|dir> The older version: a git ref, or a project or schemas folder",
      "  --json           Print the changes as JSON",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
  llm: {
    summary: "Print the provider-ready schema of one type for an LLM profile",
    usage: "strictgen llm --profile <name> <Type> [--json] [--config <path>]",
    details: [
      "Prints the schema an LLM provider accepts for structured output, projected from the type",
      "named as the generated code names it, like Order, by a profile: openai, anthropic, gemini,",
      "a profile file llm.profiles lists, or the path of one. What moved to the decoder (optional",
      "fields made nullable, constraints left out, maps as entries) is listed on stderr. Exits 1",
      "when the type can't be projected, and 2 for an unknown type or profile.",
    ],
    options: [
      "  --profile <name> The profile, or the path of a profile file ending in .json",
      "  --json           Print { type, profile, schema, changes } as JSON on stdout",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
  dirs: {
    summary: "Print the folders the targets write to",
    usage: "strictgen dirs [--json] [--config <path>]",
    details: [
      "Prints one folder per line, relative to the current folder, owned and shared, in config",
      "order. strictgen clears an owned folder before writing. In a shared folder it only replaces",
      "the files it generated.",
    ],
    options: [
      "  --json           Print a JSON array of { target, dir, shared }",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
  fix: {
    summary: "Rewrite the schemas into the supported subset, as a diff or in place",
    usage: "strictgen fix [--write] [--config <path>]",
    details: [
      "Rewrites the schema files where it can, with rules that run until nothing changes: it closes",
      "open objects, makes a oneOf whose branches each have a const property a tagged union, merges",
      "simple allOf parts and moves definitions and inline schemas a $ref points at into $defs.",
      "Prints a unified diff of the changes, or with --write writes them in place, keeping key order",
      "and formatting. Then it generates every target in memory and lists what is left to change by",
      "hand, with the file, JSON pointer and rule. Exits 1 when generation still fails; --write",
      "writes the files it fixed even then.",
    ],
    options: [
      "  --write          Write the fixed schemas in place instead of printing a diff",
      CONFIG_OPTION,
      HELP_OPTION,
    ],
  },
};

const OPTIONS = {
  config: { type: "string" },
  base: { type: "string" },
  json: { type: "boolean" },
  write: { type: "boolean" },
  profile: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  count: { type: "string" },
  seed: { type: "string" },
  invalid: { type: "boolean" },
  array: { type: "boolean" },
  format: { type: "string" },
} as const;

/** Options only one command takes, by option. */
const COMMAND_OPTIONS: Readonly<Record<string, string>> = {
  base: "breaking",
  count: "examples",
  seed: "examples",
  invalid: "examples",
  array: "examples",
  format: "docs",
  profile: "llm",
};

/** A whole number from `min` to `max`, from an option's text. */
function wholeNumber(text: string, option: string, min: number, max: number): number {
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) {
    throw new UsageError(`--${option} must be a whole number from ${String(min)} to ${String(max)}, not ${JSON.stringify(text)}`);
  }
  return Number(text);
}

function mainHelp(): string[] {
  return [
    "strictgen: one JSON Schema in, strict Rust, Go and TypeScript out",
    "",
    "Usage: strictgen [command] [options]",
    "",
    "Commands:",
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`),
    "",
    "Options:",
    CONFIG_OPTION,
    HELP_OPTION,
    "  --version        Print the version",
    "",
    "Run strictgen <command> --help for a command's options.",
    "Exit codes: 0 success, 1 generation failed, check found a difference or breaking found a",
    "breaking change, 2 bad usage or config.",
  ];
}

function commandHelp(name: string, command: Command): string[] {
  return [
    `strictgen ${name}: ${command.summary}`,
    "",
    `Usage: ${command.usage}`,
    "",
    ...command.details,
    "",
    "Options:",
    ...command.options,
  ];
}

/** The version in `package.json`. */
export function version(): string {
  const file = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

class UsageError extends Error {}

/** `path` relative to `from`, with `/` separators, or `.` for `from` itself. */
function shown(from: string, path: string): string {
  const rel = relative(from, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/**
 * Runs the CLI with `argv`, the arguments after the program name, and returns the exit code.
 * Never throws: every error is printed as a one line message, with no stack trace.
 */
export function run(argv: readonly string[], io: Io): number {
  try {
    return dispatch(argv, io);
  } catch (error) {
    return report(error, io);
  }
}

function dispatch(argv: readonly string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const name = positionals[0];
  const most = name === "explain" || name === "examples" || name === "llm" ? 2 : 1;
  if (positionals.length > most) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[most])}`);
  }
  const command = name === undefined ? undefined : COMMANDS[name];
  if (name !== undefined && command === undefined) {
    throw new UsageError(
      `unknown command ${JSON.stringify(name)}. Commands: ${Object.keys(COMMANDS).join(", ")}`,
    );
  }
  if (values.version === true) {
    io.out(version());
    return EXIT_OK;
  }
  if (values.help === true) {
    const lines = name === undefined || command === undefined ? mainHelp() : commandHelp(name, command);
    for (const line of lines) io.out(line);
    return EXIT_OK;
  }
  if (
    values.json === true &&
    name !== "dirs" &&
    name !== "explain" &&
    name !== "breaking" &&
    name !== "llm"
  ) {
    throw new UsageError("--json only applies to strictgen dirs, explain, breaking and llm");
  }
  if (name === "breaking" && (values.base === undefined || values.base === "")) {
    throw new UsageError("breaking needs --base <git ref or folder>, like --base main");
  }
  if (name === "llm" && values.profile === undefined) {
    throw new UsageError("llm needs --profile <name>, like --profile openai");
  }
  if (name === "llm" && positionals[1] === undefined) {
    throw new UsageError("llm needs a type name, like Order");
  }
  if (values.write === true && name !== "fix") {
    throw new UsageError("--write only applies to strictgen fix");
  }
  for (const [option, only] of Object.entries(COMMAND_OPTIONS)) {
    if ((values as Record<string, unknown>)[option] !== undefined && name !== only) {
      throw new UsageError(`--${option} only applies to strictgen ${only}`);
    }
  }
  const location = positionals[1];
  if (name === "explain" && location === undefined) {
    throw new UsageError("explain needs a schema location, like user.json#/$defs/address");
  }
  if (name === "examples" && location === undefined) {
    throw new UsageError("examples needs a type, like Order");
  }
  const format = values.format;
  if (format !== undefined && !(DOCS_FORMATS as readonly string[]).includes(format)) {
    throw new UsageError(`--format must be one of ${DOCS_FORMATS.join(", ")}, not ${JSON.stringify(format)}`);
  }
  const count = values.count === undefined ? 1 : wholeNumber(values.count, "count", 1, 10_000);
  const seed = values.seed === undefined ? 0 : wholeNumber(values.seed, "seed", 0, 4_294_967_295);
  const config = loadConfig(values.config, io.cwd);
  switch (name) {
    case "explain":
      return explainCommand(config, io, location ?? "", values.json === true);
    case "examples": {
      const { lines, notice } = examples(config, {
        type: location ?? "",
        count,
        seed,
        invalid: values.invalid === true,
        array: values.array === true,
      });
      for (const line of lines) io.out(line);
      if (notice !== undefined) io.err(notice);
      return EXIT_OK;
    }
    case "docs":
      return docs(config, io, format as DocsFormat | undefined);
    case "check":
      return check(config, io);
    case "fix":
      return fixCommand(config, io, values.write === true);
    case "breaking":
      return breakingCommand(config, io, values.base ?? "", values.json === true);
    case "llm":
      return llmCommand(config, io, values.profile ?? "", location ?? "", values.json === true);
    case "dirs":
      return dirs(config, io, values.json === true);
    default:
      return generate(config, io);
  }
}

/** Prints an error as one line per problem and returns its exit code. */
function report(error: unknown, io: Io): number {
  if (error instanceof UsageError) {
    io.err(`error: ${error.message}`);
    io.err("Run strictgen --help for usage.");
    return EXIT_USAGE;
  }
  if (error instanceof BreakingError) {
    io.err(`error: ${error.message}`);
    return error.exit;
  }
  if (
    error instanceof ConfigError ||
    error instanceof ExplainError ||
    error instanceof UnknownTypeError ||
    error instanceof LlmError
  ) {
    io.err(`error: ${error.message}`);
    return EXIT_USAGE;
  }
  if (
    error instanceof CodegenError ||
    error instanceof GenerateError ||
    error instanceof FormatterFailedError ||
    error instanceof FormatterMissingError
  ) {
    io.err(`error: ${error.message}`);
    return EXIT_FAILED;
  }
  if (isFsError(error)) {
    const where = error.path === undefined ? "" : `${shown(io.cwd, error.path)}: `;
    io.err(`error: ${where}${fsReason(error)}`);
    return EXIT_FAILED;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.err(`error: ${message.split("\n")[0] ?? message}`);
  return EXIT_FAILED;
}

function generate(config: Config, io: Io): number {
  const options = mainOptions(config);
  // Formats in memory, the way check does, and writes only when every file formatted cleanly,
  // so a failing formatter leaves the previous output as it was.
  const files = formatFiles(generateProject(options), config.format, {
    env: io.env,
    header: config.header,
    onMissing: ({ formatter: f }) => {
      io.err(
        `notice: ${f.command} is not installed, so the ${f.language} output is left unformatted. ` +
          `Install it, or set ${f.option} to "none"`,
      );
    },
  });
  writeOutput(config.root, options.targets, files, config.header, [config.schemas, config.file]);
  if (config.targets.rust?.serdeBridge === true) {
    const fallbacks = serdeFallbacks(configModel(config).model);
    if (fallbacks.length > 0) {
      io.err(
        `notice: targets.rust.serdeBridge can't bridge plain type aliases, so these use serde's own ` +
          `Deserialize, which is not strict: ${fallbacks.join(", ")}. Decode them with from_json to keep them strict`,
      );
    }
  }
  const names = options.targets.map((t) => t.name).join(", ");
  io.out(`Generated ${String(files.length)} files for ${names}.`);
  return EXIT_OK;
}

function check(config: Config, io: Io): number {
  const options = mainOptions(config);
  const files: OutputFile[] = formatFiles(generateProject(options), config.format, {
    env: io.env,
    header: config.header,
    requireFormatters: true,
  });
  const found = differences(config.root, options.targets, files, config.header);
  if (found.length === 0) {
    io.out(`${String(files.length)} generated files are up to date.`);
    return EXIT_OK;
  }
  const count = found.length === 1 ? "1 file is" : `${String(found.length)} files are`;
  io.err(`error: ${count} out of date. Run strictgen generate to update them:`);
  for (const { kind, path } of found) {
    io.err(`  ${`${kind}:`.padEnd(8)} ${shown(io.cwd, join(config.root, path))}`);
  }
  return EXIT_FAILED;
}

function explainCommand(config: Config, io: Io, location: string, json: boolean): number {
  const explanation = explain(config, location, io.cwd, io.env);
  if (json) io.out(JSON.stringify(explanation, null, 2));
  else for (const line of explanationLines(explanation)) io.out(line);
  return explained(explanation) ? EXIT_OK : EXIT_FAILED;
}

function docs(config: Config, io: Io, format: DocsFormat | undefined): number {
  if (config.docs === undefined) {
    throw new ConfigError(
      shown(io.cwd, config.file),
      "docs",
      'is not set. Add "docs": { "out": "docs/types" } to say where the pages go',
    );
  }
  const written = writeDocs(config, format);
  const what = written.count === 1 ? "1 docs file" : `${String(written.count)} docs files`;
  io.out(`Wrote ${what} to ${shown(io.cwd, written.dir)}.`);
  return EXIT_OK;
}

function breakingCommand(config: Config, io: Io, base: string, json: boolean): number {
  const result = breaking(config, base, io.cwd, io.env, io.err);
  if (json) io.out(JSON.stringify(breakingJson(result), null, 2));
  else for (const line of breakingLines(result)) io.out(line);
  return breaksAnything(result) ? EXIT_FAILED : EXIT_OK;
}

function llmCommand(config: Config, io: Io, profile: string, type: string, json: boolean): number {
  const projection = llmProjection(config, profile, type, (p) => resolve(io.cwd, p));
  if (json) {
    io.out(schemaText(projection as unknown as JsonObject).trimEnd());
    return EXIT_OK;
  }
  io.out(schemaText(projection.schema).trimEnd());
  for (const line of changeLines(projection)) io.err(line);
  return EXIT_OK;
}

function dirs(config: Config, io: Io, json: boolean): number {
  const list = configFolders(config).map((folder) => ({
    target: (folder.option.startsWith("targets.") ? folder.option.split(".")[1] : folder.option.split(".")[0]) ?? folder.option,
    dir: shown(io.cwd, folder.path),
    shared: !folder.owned,
  }));
  if (json) io.out(JSON.stringify(list, null, 2));
  else for (const { dir } of list) io.out(dir);
  return EXIT_OK;
}
