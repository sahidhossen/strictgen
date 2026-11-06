/**
 * `strictgen examples <type>` and `strictgen docs`, the commands built on the payload generator
 * (src/payloads.ts). They read the schemas the way `generate` does and print or write payloads
 * and pages, never generated code.
 */
import { buildModel } from "./build.js";
import type { Config, DocsFormat } from "./config.js";
import { docsFiles, docsTarget, readModes } from "./docs.js";
import { writeOutput } from "./main.js";
import type { Model } from "./model.js";
import type { Payload } from "./payloads.js";
import { GenerateError, PayloadGenerator, Random } from "./payloads.js";
import type { SchemaSet } from "./schema.js";
import { loadSchemas } from "./schema-files.js";

/** A type `examples` doesn't know. The CLI exits 2 for it. */
export class UnknownTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownTypeError";
  }
}

/** What `strictgen examples` prints. */
export interface ExamplesOptions {
  /** The type, by its name in the generated code, like `Order`. */
  readonly type: string;
  readonly count: number;
  readonly seed: number;
  /** Near misses with their expected error, in place of valid payloads. */
  readonly invalid: boolean;
  /** One JSON array, in place of one payload per line. */
  readonly array: boolean;
}

/**
 * The schemas of a config and their model, as `generate` builds it. The schemas let errors point
 * into them. Throws a CodegenError.
 */
export function configModel(config: Config): { schemas: SchemaSet; model: Model } {
  const schemas = loadSchemas(config.schemas, config.idBase === undefined ? {} : { idBase: config.idBase });
  const model = buildModel(schemas, {
    ...(config.ids === undefined ? {} : { ids: config.ids }),
    validation: config.validation,
  });
  return { schemas, model };
}

function checkType(model: Model, type: string): void {
  if (model.decls.some((d) => d.name === type)) return;
  const near = model.decls.find((d) => d.name.toLowerCase() === type.toLowerCase());
  const hint = near === undefined ? "Types are named as in the generated code, like Order" : `Did you mean ${near.name}?`;
  throw new UnknownTypeError(`unknown type ${JSON.stringify(type)}. ${hint}`);
}

/** Rounds of near misses tried without a new one before `examples --invalid` stops looking. */
const ROUNDS_WITHOUT_NEW = 20;

/**
 * The lines `strictgen examples` prints, and a notice when there are fewer near misses than
 * asked for. Valid payloads hold in every read mode the targets use, and each near miss fails
 * with its error in every one. Throws a {@link GenerateError} when the type has no value the
 * generator is sure of, or no near miss at all.
 */
export function examples(config: Config, options: ExamplesOptions): { lines: string[]; notice?: string } {
  const { model } = configModel(config);
  checkType(model, options.type);
  const generator = new PayloadGenerator(model, { seed: options.seed, read: readModes(config) });
  const items: unknown[] = [];
  if (!options.invalid) {
    for (let i = 0; i < options.count; i++) items.push(generator.valid(options.type));
  } else {
    const random = new Random(options.seed);
    const seen = new Set<string>();
    for (let idle = 0; items.length < options.count && idle < ROUNDS_WITHOUT_NEW; idle++) {
      for (const miss of random.shuffle(generator.nearMisses(options.type))) {
        const item = { path: miss.path, code: miss.code, change: miss.change, payload: miss.payload as Payload };
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(item);
        idle = -1;
        if (items.length === options.count) break;
      }
    }
    if (items.length === 0) {
      throw new GenerateError(options.type, "", "it has no near misses, since it takes every JSON value");
    }
  }
  const lines = options.array ? [JSON.stringify(items, null, 2)] : items.map((item) => JSON.stringify(item));
  const notice =
    items.length < options.count
      ? `notice: only ${String(items.length)} different near misses of ${options.type} found, of the ${String(options.count)} asked for`
      : undefined;
  return { lines, ...(notice === undefined ? {} : { notice }) };
}

/**
 * Writes the docs pages into `docs.out`, in the config's format or `format`, and returns how
 * many files it wrote. Only files that start with the generated header are replaced or removed.
 */
export function writeDocs(config: Config, format?: DocsFormat): { count: number; dir: string } {
  const docs = config.docs;
  if (docs === undefined) throw new Error("writeDocs needs a docs config");
  const files = docsFiles(config, configModel(config).model, format ?? docs.format);
  writeOutput(config.root, [docsTarget(config)], files, config.header, [config.schemas, config.file]);
  return { count: files.length, dir: docs.out };
}
