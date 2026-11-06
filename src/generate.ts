/**
 * Generation without a file system: a schema set in, the files of every target out. `main.ts`
 * reads the schemas from disk and writes what this returns; `memory.ts` and the playground use it
 * with schemas held in memory.
 */
import type { BuildOptions } from "./build.js";
import { buildModel } from "./build.js";
import type { Model } from "./model.js";
import type { SchemaSet } from "./schema.js";

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
  return emitTargets(buildModel(schemas, options), schemas, targets);
}

/** Emits every target from a model and the schema set it was built from, in target order. */
export function emitTargets(model: Model, schemas: SchemaSet, targets: readonly Target[]): OutputFile[] {
  return targets.flatMap((t) => t.emit(model, schemas));
}
