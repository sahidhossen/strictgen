import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

import { differences } from "./check.js";
import type { Config } from "./config.js";
import { ConfigError, configFolders, loadConfig } from "./config.js";
import { formatFiles, FormatterFailedError, FormatterMissingError } from "./format.js";
import { fsReason, isFsError } from "./fs-error.js";
import type { OutputFile } from "./main.js";
import { generateProject, writeOutput } from "./main.js";
import { CodegenError } from "./schema.js";
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
};

const OPTIONS = {
  config: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

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
    "Exit codes: 0 success, 1 generation failed or check found a difference, 2 bad usage or config.",
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
  if (positionals.length > 1) {
    throw new UsageError(`unexpected argument ${JSON.stringify(positionals[1])}`);
  }
  const name = positionals[0];
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
  if (values.json === true && name !== "dirs") {
    throw new UsageError("--json only applies to strictgen dirs");
  }
  const config = loadConfig(values.config, io.cwd);
  switch (name) {
    case "check":
      return check(config, io);
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
  if (error instanceof ConfigError) {
    io.err(`error: ${error.message}`);
    return EXIT_USAGE;
  }
  if (
    error instanceof CodegenError ||
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

function dirs(config: Config, io: Io, json: boolean): number {
  const list = configFolders(config).map((folder) => ({
    target: folder.option.split(".")[1] ?? folder.option,
    dir: shown(io.cwd, folder.path),
    shared: !folder.owned,
  }));
  if (json) io.out(JSON.stringify(list, null, 2));
  else for (const { dir } of list) io.out(dir);
  return EXIT_OK;
}
