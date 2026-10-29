import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BuildOptions } from "./build.js";
import { buildModel } from "./build.js";
import { commentHeader, DEFAULT_HEADER } from "./common.js";
import type { Model } from "./model.js";
import type { SchemaOptions, SchemaSet } from "./schema.js";
import { CodegenError, loadSchemas } from "./schema.js";

/** One generated file, with a path relative to the output root. */
export interface OutputFile {
  readonly path: string;
  readonly contents: string;
}

/**
 * A language the generator writes. Each target owns its `dirs`, which are
 * cleared before writing, so a removed schema leaves no stale file behind.
 * In `shared` folders, which also hold hand written files like tests, only the
 * files that start with the generated header are removed.
 */
export interface Target {
  readonly name: string;
  readonly dirs: readonly string[];
  readonly shared?: readonly string[];
  readonly emit: (model: Model, schemas: SchemaSet) => readonly OutputFile[];
}

/** The folders the targets write to, owned and shared, for scripts and CI. */
export function targetDirs(targets: readonly Target[]): string[] {
  return targets.flatMap((t) => [...t.dirs, ...(t.shared ?? [])]);
}

/** Builds the model from a schema set and emits every target, without writing. */
export function generate(
  schemas: SchemaSet,
  targets: readonly Target[],
  options: BuildOptions = {},
): OutputFile[] {
  const model = buildModel(schemas, options);
  return targets.flatMap((t) => t.emit(model, schemas));
}

/** True when `contents` is a generated file: its first line is the header text as a comment. */
export function isGenerated(contents: string, header: string = DEFAULT_HEADER): boolean {
  return contents.startsWith(`${commentHeader(header)}\n`);
}

/** Removes the generated files, the ones starting with the header, directly in a shared folder. */
function clearGenerated(dir: string, header: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && isGenerated(readFileSync(path, "utf8"), header)) rmSync(path);
  }
}

/**
 * Writes `files` under `rootDir`, after clearing every folder the targets own and the
 * generated files in their shared folders, the ones that start with `header`.
 */
export function writeOutput(
  rootDir: string,
  targets: readonly Target[],
  files: readonly OutputFile[],
  header: string = DEFAULT_HEADER,
): void {
  for (const dir of targets.flatMap((t) => t.dirs))
    rmSync(join(rootDir, dir), { recursive: true, force: true });
  for (const dir of targets.flatMap((t) => t.shared ?? []))
    clearGenerated(join(rootDir, dir), header);
  for (const file of files) {
    const path = join(rootDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
  }
}

/** Receives one line of output, without a trailing newline. */
export type Log = (line: string) => void;

/** What {@link main} generates, and where. */
export interface MainOptions extends SchemaOptions, BuildOptions {
  /** The folder the schemas are read from. */
  readonly schemaDir: string;
  /** The folder output paths are relative to. */
  readonly rootDir: string;
  readonly targets: readonly Target[];
  /** The header text generated files start with, to find them in shared folders. */
  readonly header?: string;
}

/**
 * Reads the schemas and emits every target, without writing. Throws a
 * {@link CodegenError} when a schema is outside the conventions.
 */
export function generateProject(options: MainOptions): OutputFile[] {
  const schemas = loadSchemas(
    options.schemaDir,
    options.idBase === undefined ? {} : { idBase: options.idBase },
  );
  return generate(schemas, options.targets, options.ids === undefined ? {} : { ids: options.ids });
}

/**
 * Reads the schemas, regenerates every target and logs a summary. Returns the
 * process exit code: 0 on success, 1 when a schema is outside the conventions.
 */
export function main(options: MainOptions, log: Log): number {
  const { rootDir, targets } = options;
  let files: OutputFile[];
  try {
    files = generateProject(options);
  } catch (error) {
    if (!(error instanceof CodegenError)) throw error;
    log(error.message);
    return 1;
  }
  writeOutput(rootDir, targets, files, options.header);
  log(`Generated ${String(files.length)} files for ${targets.map((t) => t.name).join(", ")}.`);
  return 0;
}
