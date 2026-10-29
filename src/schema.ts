import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A parsed JSON value. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

/** A parsed JSON object. */
export interface JsonObject {
  readonly [key: string]: Json;
}

/** One schema file, keyed by its file name without `.json`. */
export interface SchemaFile {
  readonly name: string;
  readonly root: JsonObject;
}

/** Every schema of the set, sorted by name. */
export type SchemaSet = readonly SchemaFile[];

/** A schema that the generator can't map, with the schema path that holds it. */
export class CodegenError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "CodegenError";
  }
}

/** A position inside a schema file, as a JSON Pointer. */
export interface Loc {
  readonly file: string;
  readonly pointer: string;
}

/** Formats a location like `payment.json#/$defs/cardPayment`. */
export function where(loc: Loc): string {
  return `${loc.file}.json#${loc.pointer}`;
}

/** Appends JSON Pointer segments to a location. */
export function at(loc: Loc, ...segments: readonly (string | number)[]): Loc {
  const tail = segments
    .map((s) => `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
  return { file: loc.file, pointer: loc.pointer + tail };
}

/** Throws a {@link CodegenError} at `loc`. */
export function fail(loc: Loc, reason: string): never {
  throw new CodegenError(where(loc), reason);
}

/** Returns true for a JSON object (not an array or null). */
export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Options for reading a schema set. */
export interface SchemaOptions {
  /**
   * The base every `$id` starts with: a schema in `<file>.json` must have the `$id`
   * `<idBase><file>.json`. When left out, it is taken from the first schema by file name, must
   * end in `/` or `#`, and every other schema must use the same base.
   */
  readonly idBase?: string;
}

/** Reads every `*.json` schema in `dir`, sorted by file name. */
export function loadSchemas(dir: string, options: SchemaOptions = {}): SchemaSet {
  const files: Record<string, JsonObject> = {};
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of names) {
    const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as Json;
    if (!isObject(parsed))
      fail({ file: file.slice(0, -5), pointer: "" }, "schema is not an object");
    files[file.slice(0, -5)] = parsed;
  }
  return schemaSet(files, options);
}

/** Describes a `$id` value for an error message. */
function shown(id: Json | undefined): string {
  return id === undefined ? "missing" : JSON.stringify(id);
}

/**
 * Builds a schema set from parsed schemas keyed by name, checking that each `$id` is
 * `<idBase><name>.json`, with `idBase` given or taken from the first schema by name.
 */
export function schemaSet(
  files: Readonly<Record<string, JsonObject>>,
  options: SchemaOptions = {},
): SchemaSet {
  const names = Object.keys(files).sort();
  let base = options.idBase;
  let from: string | undefined;
  return names.map((name) => {
    const root = files[name];
    const loc = { file: name, pointer: "" };
    if (root === undefined) return fail(loc, "missing schema");
    const id = root.$id;
    const tail = `${name}.json`;
    if (base === undefined) {
      const derived =
        typeof id === "string" && id.endsWith(tail) ? id.slice(0, -tail.length) : undefined;
      if (derived === undefined || !/[/#]$/.test(derived)) {
        return fail(
          at(loc, "$id"),
          `$id is ${shown(id)}, expected <idBase>${tail} with a base that ends in / or #, ` +
            `so no idBase can be taken from it. ` +
            `Fix: set the $id to a base ending in / or # followed by ${tail}, or set the idBase option`,
        );
      }
      base = derived;
      from = name;
    } else if (id !== `${base}${tail}`) {
      const source = from === undefined ? "from the idBase option" : `taken from ${from}.json`;
      fail(
        at(loc, "$id"),
        `$id is ${shown(id)}, expected ${base}${tail} (base ${base}, ${source}). ` +
          `Fix: set the $id to ${base}${tail}` +
          (from === undefined ? ", or change the idBase option" : ", or set the idBase option"),
      );
    }
    return { name, root };
  });
}

/**
 * The base every `$id` of a checked schema set starts with, or undefined for an empty set.
 * {@link schemaSet} makes sure every schema shares it.
 */
export function idBaseOf(set: SchemaSet): string | undefined {
  const first = set[0];
  if (first === undefined || typeof first.root.$id !== "string") return undefined;
  return first.root.$id.slice(0, -`${first.name}.json`.length);
}

/** A named schema: a file root (`def` undefined) or one of its `$defs`. */
export interface DefKey {
  readonly file: string;
  readonly def: string | undefined;
}

/** Formats a def key like `payment#cardPayment`, or `payment#` for a root. */
export function keyString(key: DefKey): string {
  return `${key.file}#${key.def ?? ""}`;
}

/** Location of a def key's schema. */
export function keyLoc(key: DefKey): Loc {
  return { file: key.file, pointer: key.def === undefined ? "" : `/$defs/${key.def}` };
}

/**
 * Resolves a `$ref` locally. Only `#/$defs/<name>` and absolute `$id` refs with
 * an optional `#/$defs/<name>` pointer are allowed.
 */
export function resolveRef(set: SchemaSet, ref: string, loc: Loc): DefKey {
  const hash = ref.indexOf("#");
  const base = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  let file = loc.file;
  if (base !== "") {
    const prefix = idBaseOf(set);
    const match = /^([a-z0-9-]+)\.json$/.exec(
      prefix !== undefined && base.startsWith(prefix) ? base.slice(prefix.length) : "",
    );
    if (match?.[1] === undefined) fail(loc, `$ref ${ref} is outside the schema set`);
    file = match[1];
  }
  const schema = set.find((s) => s.name === file);
  if (schema === undefined) return fail(loc, `$ref ${ref} names an unknown schema`);
  if (pointer === "") return { file, def: undefined };
  const def = /^\/\$defs\/([A-Za-z0-9]+)$/.exec(pointer)?.[1];
  if (def === undefined) return fail(loc, `$ref ${ref} must point at a $defs entry`);
  if (!isObject(schema.root.$defs) || !isObject(schema.root.$defs[def])) {
    fail(loc, `$ref ${ref} names an unknown def`);
  }
  return { file, def };
}

/** The schema a def key names. */
export function schemaAt(set: SchemaSet, key: DefKey): JsonObject {
  const file = set.find((s) => s.name === key.file);
  if (file === undefined) return fail(keyLoc(key), "unknown schema");
  if (key.def === undefined) return file.root;
  const defs = file.root.$defs;
  const schema = isObject(defs) ? defs[key.def] : undefined;
  if (!isObject(schema)) return fail(keyLoc(key), "unknown def");
  return schema;
}

const ROOT_ONLY_KEYS = new Set(["$schema", "$id", "title", "description", "$comment", "$defs"]);

/** True for a definitions-only schema, like `common.json`, which has no root type. */
export function isDefsOnly(root: JsonObject): boolean {
  return Object.keys(root).every((k) => ROOT_ONLY_KEYS.has(k));
}

/** Sorted `$defs` names of a schema file. */
export function defNames(root: JsonObject): string[] {
  return isObject(root.$defs) ? Object.keys(root.$defs).sort() : [];
}
