import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BuildOptions } from "./build.js";
import { buildModel } from "./build.js";
import { HEADER } from "./common.js";
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

/** Removes the generated files, the ones starting with the header, directly in a shared folder. */
function clearGenerated(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && readFileSync(path, "utf8").startsWith(`${HEADER}\n`)) rmSync(path);
  }
}

/**
 * Writes `files` under `rootDir`, after clearing every folder the targets own and the
 * generated files in their shared folders.
 */
export function writeOutput(
  rootDir: string,
  targets: readonly Target[],
  files: readonly OutputFile[],
): void {
  for (const dir of targets.flatMap((t) => t.dirs))
    rmSync(join(rootDir, dir), { recursive: true, force: true });
  for (const dir of targets.flatMap((t) => t.shared ?? [])) clearGenerated(join(rootDir, dir));
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
}

/**
 * Reads the schemas, regenerates every target and logs a summary. Returns the
 * process exit code: 0 on success, 1 when a schema is outside the conventions.
 */
export function main(options: MainOptions, log: Log): number {
  const { rootDir, schemaDir, targets } = options;
  let files: OutputFile[];
  try {
    const schemas = loadSchemas(
      schemaDir,
      options.idBase === undefined ? {} : { idBase: options.idBase },
    );
    files = generate(schemas, targets, options.ids === undefined ? {} : { ids: options.ids });
  } catch (error) {
    if (!(error instanceof CodegenError)) throw error;
    log(error.message);
    return 1;
  }
  writeOutput(rootDir, targets, files);
  log(`Generated ${String(files.length)} files for ${targets.map((t) => t.name).join(", ")}.`);
  return 0;
}
