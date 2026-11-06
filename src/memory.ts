/**
 * The generator for schemas held in memory, with no file system: what `strictgen generate` writes
 * before formatting, from schema texts and settings. The playground runs it in the browser, so
 * nothing this module imports may use Node's built in modules; `scripts/playground-build.mjs`
 * fails the build when one does.
 */
import type { BuildOptions } from "./build.js";
import { buildModel } from "./build.js";
import { DEFAULT_HEADER } from "./common.js";
import type { ReadMode } from "./config.js";
import { GO_PACKAGE } from "./emit-go.js";
import { DEFAULT_ALLOW } from "./emit-rust.js";
import type { OutputFile } from "./generate.js";
import { emitTargets } from "./generate.js";
import type { Profile } from "./llm-profile.js";
import type { Model } from "./model.js";
import type { JsonObject, SchemaOptions, SchemaSet } from "./schema.js";
import { parseSchemaFile, schemaSet } from "./schema.js";
import type { TargetSettings } from "./target-set.js";
import { settingsTargets } from "./target-set.js";

/** One schema file: its name, like `order.json`, and its text. */
export interface MemorySchema {
  readonly name: string;
  readonly text: string;
}

/** What {@link generateInMemory} generates. */
export interface MemoryOptions extends SchemaOptions, BuildOptions {
  readonly schemas: readonly MemorySchema[];
  readonly settings: TargetSettings;
}

/** The schema set, its model and every generated file, unformatted. */
export interface MemoryOutput {
  readonly schemas: SchemaSet;
  readonly model: Model;
  readonly files: readonly OutputFile[];
}

/**
 * Reads schema texts the way `loadSchemas` reads a folder: sorted by file name, each parsed as
 * JSON and checked to be an object, then checked as a set. Every name must end in `.json`, and no
 * name may be given twice. Throws a {@link CodegenError} for a schema outside the conventions.
 */
export function memorySchemas(files: readonly MemorySchema[], options: SchemaOptions = {}): SchemaSet {
  const parsed: Record<string, JsonObject> = {};
  const names = files.map((f) => f.name).sort();
  for (const [i, name] of names.entries()) {
    if (!name.endsWith(".json")) throw new Error(`schema file ${JSON.stringify(name)} must end in .json`);
    if (names[i - 1] === name) throw new Error(`schema file ${JSON.stringify(name)} is given twice`);
  }
  for (const name of names) {
    const file = files.find((f) => f.name === name);
    if (file !== undefined) parsed[name.slice(0, -5)] = parseSchemaFile(name, file.text);
  }
  return schemaSet(parsed, options);
}

/**
 * Generates every target the settings list from schema texts, as `strictgen generate` does
 * before it formats and writes. Throws a {@link CodegenError} when a schema is outside the
 * conventions.
 */
export function generateInMemory(options: MemoryOptions): MemoryOutput {
  const schemas = memorySchemas(options.schemas, options.idBase === undefined ? {} : { idBase: options.idBase });
  const model = buildModel(schemas, {
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.validation === undefined ? {} : { validation: options.validation }),
  });
  return { schemas, model, files: emitTargets(model, schemas, settingsTargets(options.settings)) };
}

/** The output folders {@link defaultSettings} uses. */
export const MEMORY_DIRS = { typescript: "ts", rust: "rust", go: "go", llm: "llm" } as const;

/** The choices {@link defaultSettings} takes; everything else is the config default. */
export interface DefaultSettingsOptions {
  readonly read: ReadMode;
  /** The LLM profiles. None leaves the LLM output and decoders out. */
  readonly profiles: readonly Profile[];
  readonly cleanup: boolean;
}

/**
 * Settings with every target on and every other option at the default a config file gives it:
 * the generated header, TypeScript decoders, Rust's default lint allowances without embedded
 * schemas, Go's default package, and no fixture registries.
 */
export function defaultSettings(options: DefaultSettingsOptions): TargetSettings {
  const { read } = options;
  return {
    header: DEFAULT_HEADER,
    targets: {
      typescript: { out: MEMORY_DIRS.typescript, decoders: true, read },
      rust: { out: MEMORY_DIRS.rust, allow: DEFAULT_ALLOW, embedSchemas: false, read },
      go: { out: MEMORY_DIRS.go, package: GO_PACKAGE, shared: true, fixtures: false, read },
    },
    ...(options.profiles.length === 0
      ? {}
      : { llm: { out: MEMORY_DIRS.llm, cleanup: options.cleanup, profiles: options.profiles } }),
  };
}
