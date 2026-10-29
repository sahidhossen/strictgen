import { spawnSync } from "node:child_process";
import { devNull } from "node:os";

import type { FormatConfig } from "./config.js";
import type { OutputFile } from "./main.js";

/** A formatter command that reads a file on stdin and writes it formatted to stdout. */
export interface Formatter {
  /** The command, looked up on `PATH`. */
  readonly command: string;
  readonly args: readonly string[];
  /** The language whose output it formats, for messages. */
  readonly language: string;
  /** The `format` option that picks it. */
  readonly option: string;
}

/**
 * rustfmt always formats with its defaults and edition 2024: `--config-path` points at an empty
 * file, so no `rustfmt.toml`, of the project or of the user, changes the output. That keeps
 * `strictgen check` giving the same answer on every machine.
 */
const RUSTFMT: Formatter = {
  command: "rustfmt",
  args: ["--edition", "2024", "--config-path", devNull],
  language: "Rust",
  option: "format.rust",
};

/** gofmt has no options that change its output. */
const GOFMT: Formatter = { command: "gofmt", args: [], language: "Go", option: "format.go" };

/** The formatter for a generated file, by its extension, or `undefined` when none applies. */
export function formatterFor(path: string, format: FormatConfig): Formatter | undefined {
  if (path.endsWith(".rs") && format.rust === "rustfmt") return RUSTFMT;
  if (path.endsWith(".go") && format.go === "gofmt") return GOFMT;
  return undefined;
}

/** A formatter that is configured but not installed. */
export class FormatterMissingError extends Error {
  constructor(readonly formatter: Formatter) {
    super(
      `${formatter.command} is not installed, so the ${formatter.language} output can't be ` +
        `formatted. Fix: install it, or set ${formatter.option} to "none"`,
    );
    this.name = "FormatterMissingError";
  }
}

/** A formatter that exited with an error, with what it printed. */
export class FormatterFailedError extends Error {
  constructor(
    readonly formatter: Formatter,
    readonly path: string,
    readonly output: string,
  ) {
    super(
      `${path}: ${formatter.command} failed${output === "" ? "" : `:\n${output.trimEnd()}`}`,
    );
    this.name = "FormatterFailedError";
  }
}

export interface FormatOptions {
  /** The environment the formatters run in. Its `PATH` finds them. */
  readonly env?: NodeJS.ProcessEnv;
  /** Throw a {@link FormatterMissingError} for a formatter that isn't installed, instead of skipping it. */
  readonly requireFormatters?: boolean;
  /** Called once for each formatter that is skipped because it isn't installed. */
  readonly onMissing?: (error: FormatterMissingError) => void;
}

/**
 * Runs every file through its formatter, on stdin, and returns the files with their formatted
 * contents. A formatter that isn't installed is skipped, its files left as they are, unless
 * `requireFormatters` is set. Throws a {@link FormatterFailedError} when a formatter fails.
 */
export function formatFiles(
  files: readonly OutputFile[],
  format: FormatConfig,
  options: FormatOptions = {},
): OutputFile[] {
  const missing = new Set<Formatter>();
  return files.map((file) => {
    const formatter = formatterFor(file.path, format);
    if (formatter === undefined || missing.has(formatter)) return file;
    const result = spawnSync(formatter.command, formatter.args, {
      input: file.contents,
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES") throw result.error;
      const error = new FormatterMissingError(formatter);
      if (options.requireFormatters === true) throw error;
      missing.add(formatter);
      options.onMissing?.(error);
      return file;
    }
    if (result.status !== 0) {
      const output = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim();
      throw new FormatterFailedError(formatter, file.path, output);
    }
    return { path: file.path, contents: result.stdout };
  });
}
