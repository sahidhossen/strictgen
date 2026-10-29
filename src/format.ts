import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_HEADER } from "./common.js";
import type { FormatConfig } from "./config.js";
import type { OutputFile } from "./main.js";
import { isGenerated } from "./main.js";

/** A formatter command that reads a file on stdin and writes it formatted to stdout. */
export interface Formatter {
  /** The command, looked up on `PATH`. */
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Arguments for a quick run that shows the formatter works, or `undefined` when finding the
   * command is enough. A rustup proxy named `rustfmt` exists even when the component isn't
   * installed, and only fails when run.
   */
  readonly probe?: readonly string[];
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
  probe: ["--version"],
  language: "Rust",
  option: "format.rust",
};

/** gofmt has no options that change its output. */
const GOFMT: Formatter = { command: "gofmt", args: [], language: "Go", option: "format.go" };

/** How long one formatter run may take before it is killed, in milliseconds. */
export const FORMAT_TIMEOUT = 60_000;

/** The formatter for a generated file, by its extension, or `undefined` when none applies. */
export function formatterFor(path: string, format: FormatConfig): Formatter | undefined {
  if (path.endsWith(".rs") && format.rust === "rustfmt") return RUSTFMT;
  if (path.endsWith(".go") && format.go === "gofmt") return GOFMT;
  return undefined;
}

/** A formatter that is configured but not installed, or doesn't run. */
export class FormatterMissingError extends Error {
  constructor(readonly formatter: Formatter) {
    super(
      `${formatter.command} is not installed, so the ${formatter.language} output can't be ` +
        `formatted. Fix: install it, or set ${formatter.option} to "none"`,
    );
    this.name = "FormatterMissingError";
  }
}

/** A formatter that failed on a file, with what it printed or why it failed. */
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
  /** The header generated files start with. A formatted file must still start with it. */
  readonly header?: string;
  /** How long one formatter run may take, in milliseconds. Default {@link FORMAT_TIMEOUT}. */
  readonly timeout?: number;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: NodeJS.ErrnoException;
}

/**
 * Runs a formatter with `input` on stdin. The input goes through a temporary file, not a pipe:
 * Go programs like gofmt sometimes never see the end of a large input written to them through
 * the socket pair Node uses for `input`, and hang.
 */
function spawn(
  formatter: Formatter,
  args: readonly string[],
  input: string,
  scratch: () => string,
  options: FormatOptions,
): Run {
  const file = join(scratch(), "input");
  writeFileSync(file, input);
  const fd = openSync(file, "r");
  try {
    const result = spawnSync(formatter.command, args, {
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
      env: options.env ?? process.env,
      maxBuffer: 256 * 1024 * 1024,
      timeout: options.timeout ?? FORMAT_TIMEOUT,
      killSignal: "SIGKILL",
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.error === undefined ? {} : { error: result.error as NodeJS.ErrnoException }),
    };
  } finally {
    closeSync(fd);
  }
}

/** True when the spawn error means the command isn't there, or can't be run. */
function notFound(error: NodeJS.ErrnoException | undefined): boolean {
  return error?.code === "ENOENT" || error?.code === "EACCES";
}

/**
 * Runs every file through its formatter, on stdin, and returns the files with their formatted
 * contents, without writing anything. A formatter that isn't installed, or whose probe fails, is
 * skipped, its files left as they are, unless `requireFormatters` is set. Throws a
 * {@link FormatterFailedError} when a formatter fails, times out, or prints something that isn't
 * a generated file.
 */
export function formatFiles(
  files: readonly OutputFile[],
  format: FormatConfig,
  options: FormatOptions = {},
): OutputFile[] {
  const header = options.header ?? DEFAULT_HEADER;
  const timeout = options.timeout ?? FORMAT_TIMEOUT;
  const ready = new Map<Formatter, boolean>();
  let dir: string | undefined;
  const scratch = (): string => (dir ??= mkdtempSync(join(tmpdir(), "strictgen-format-")));

  /** Probes a formatter once, and reports it when it is missing. */
  const available = (formatter: Formatter): boolean => {
    const known = ready.get(formatter);
    if (known !== undefined) return known;
    let ok = true;
    if (formatter.probe !== undefined) {
      const result = spawn(formatter, formatter.probe, "", scratch, options);
      ok = result.error === undefined && result.status === 0;
    }
    ready.set(formatter, ok);
    if (!ok) missing(formatter);
    return ok;
  };
  const missing = (formatter: Formatter): void => {
    ready.set(formatter, false);
    const error = new FormatterMissingError(formatter);
    if (options.requireFormatters === true) throw error;
    options.onMissing?.(error);
  };

  try {
    return files.map((file) => {
      const formatter = formatterFor(file.path, format);
      if (formatter === undefined || !available(formatter)) return file;
      const result = spawn(formatter, formatter.args, file.contents, scratch, options);
      const fail = (output: string): never => {
        throw new FormatterFailedError(formatter, file.path, output);
      };
      if (notFound(result.error)) {
        missing(formatter);
        return file;
      }
      if (result.error?.code === "ETIMEDOUT") {
        fail(`it took longer than ${String(timeout / 1000)}s and was stopped`);
      }
      if (result.error !== undefined) fail(`it could not run: ${result.error.message}`);
      if (result.status !== 0) {
        fail((result.stderr.trim() === "" ? result.stdout : result.stderr).trim());
      }
      if (result.stdout.trim() === "") fail("it printed nothing");
      if (!isGenerated(result.stdout, header)) {
        fail("what it printed doesn't start with the generated header, so it was not used");
      }
      return { path: file.path, contents: result.stdout };
    });
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}
