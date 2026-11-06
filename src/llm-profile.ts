/**
 * LLM provider profiles: what one provider accepts in a structured output schema, as data. The
 * built in ones ship as JSON files in `profiles/`, next to `profile.schema.json`, which describes
 * them. A profile file a config names by its path replaces the built in profile of its name.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config, LlmProfileRef } from "./config.js";
import { ConfigError } from "./config.js";
import { fsReason, isFsError } from "./fs-error.js";

/** The optional keywords a profile can accept, in the order the profile schema lists them. */
export const PROFILE_KEYWORDS = [
  "const",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "propertyNames",
] as const;

export type ProfileKeyword = (typeof PROFILE_KEYWORDS)[number];

/** The keywords a profile may accept only up to a value. */
export const BOUNDED_KEYWORDS = [
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
] as const;

export type BoundedKeyword = (typeof BOUNDED_KEYWORDS)[number];

const FORMATS = ["date-time", "date", "uuid"] as const;

/** Where a profile's rules come from. */
export interface ProfileSource {
  readonly url: string;
  /** The day the rules were checked against it, as YYYY-MM-DD. */
  readonly checked: string;
  readonly notes?: string;
}

/** The size limits of a provider. A limit that is absent isn't checked. */
export interface ProfileLimits {
  readonly maxDepth?: number;
  readonly maxProperties?: number;
  readonly maxEnumValues?: number;
  readonly maxStringSize?: number;
  readonly maxUnions?: number;
  readonly largeEnum?: { readonly values: number; readonly maxSize: number };
}

/** What one provider accepts. `profiles/profile.schema.json` describes each field. */
export interface Profile {
  readonly name: string;
  readonly version: number;
  readonly date: string;
  readonly description?: string;
  readonly sources: readonly ProfileSource[];
  readonly keywords: ReadonlySet<ProfileKeyword>;
  readonly formats: ReadonlySet<string>;
  readonly keywordMaximums: Readonly<Partial<Record<BoundedKeyword, number>>>;
  readonly maps: "entries" | "object";
  readonly recursion: boolean;
  readonly limits: ProfileLimits;
}

/** The profiles strictgen ships, by name. */
export const BUILTIN_PROFILES = ["anthropic", "gemini", "openai"] as const;

/** The folder the built in profiles ship in, beside `src/` and `dist/`. */
const PROFILES_DIR = new URL("../profiles/", import.meta.url);

const NAME = /^[a-z][a-z0-9-]*$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

type Raw = Readonly<Record<string, unknown>>;

/** Reads a profile's values, failing with the option path, like the config reader does. */
class Reader {
  constructor(readonly file: string) {}

  fail(option: string, problem: string): never {
    throw new ConfigError(this.file, option, problem);
  }

  object(value: unknown, option: string, known: readonly string[], required: readonly string[] = []): Raw {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(option, option === "" ? "a profile must be a JSON object" : "must be an object");
    }
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        this.fail(join(option, key), `unknown option. Known options: ${known.join(", ")}`);
      }
    }
    for (const key of required) {
      if ((value as Raw)[key] === undefined) this.fail(join(option, key), "is required");
    }
    return value as Raw;
  }

  string(value: unknown, option: string, pattern?: RegExp, expected?: string): string {
    if (typeof value !== "string") this.fail(option, "must be a string");
    if (pattern !== undefined && !pattern.test(value)) {
      this.fail(option, `${JSON.stringify(value)} is not ${expected ?? String(pattern)}`);
    }
    return value;
  }

  integer(value: unknown, option: string, minimum: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) this.fail(option, "must be an integer");
    if (value < minimum) this.fail(option, `must be at least ${String(minimum)}`);
    return value;
  }

  boolean(value: unknown, option: string): boolean {
    if (typeof value !== "boolean") this.fail(option, "must be true or false");
    return value;
  }

  /** An array of distinct values, each one of `values`. */
  set<T extends string>(value: unknown, option: string, values: readonly T[]): Set<T> {
    if (!Array.isArray(value)) this.fail(option, "must be an array");
    const out = new Set<T>();
    for (const [i, item] of value.entries()) {
      const at = `${option}[${String(i)}]`;
      if (typeof item !== "string" || !(values as readonly string[]).includes(item)) {
        this.fail(at, `must be one of ${values.join(", ")}`);
      }
      if (out.has(item as T)) this.fail(at, `${item} is listed twice`);
      out.add(item as T);
    }
    return out;
  }
}

function join(option: string, key: string): string {
  return option === "" ? key : `${option}.${key}`;
}

/**
 * Validates a parsed profile by the rules of `profiles/profile.schema.json`. `shown` names the
 * file in errors. Throws a {@link ConfigError} naming the option and the problem.
 */
export function parseProfile(value: unknown, shown: string): Profile {
  const r: Reader = new Reader(shown);
  const o = r.object(
    value,
    "",
    [
      "$schema",
      "name",
      "version",
      "date",
      "description",
      "sources",
      "keywords",
      "formats",
      "keywordMaximums",
      "maps",
      "recursion",
      "limits",
    ],
    ["name", "version", "date", "sources", "keywords", "formats", "maps", "recursion", "limits"],
  );
  if (o.$schema !== undefined) r.string(o.$schema, "$schema");
  const description = o.description === undefined ? undefined : r.string(o.description, "description");
  const list: unknown = o.sources;
  if (!Array.isArray(list)) r.fail("sources", "must be an array");
  if (list.length === 0) r.fail("sources", "must list at least one source");
  const sources = list.map((item: unknown, i: number): ProfileSource => {
    const at = `sources[${String(i)}]`;
    const s = r.object(item, at, ["url", "checked", "notes"], ["url", "checked"]);
    const notes = s.notes === undefined ? undefined : r.string(s.notes, `${at}.notes`);
    return {
      url: r.string(s.url, `${at}.url`, /^https:\/\//, "an https URL"),
      checked: r.string(s.checked, `${at}.checked`, DATE, "a date like 2026-01-31"),
      ...(notes === undefined ? {} : { notes }),
    };
  });
  const maximums: Partial<Record<BoundedKeyword, number>> = {};
  if (o.keywordMaximums !== undefined) {
    const m = r.object(o.keywordMaximums, "keywordMaximums", BOUNDED_KEYWORDS);
    for (const key of BOUNDED_KEYWORDS) {
      if (m[key] !== undefined) maximums[key] = r.integer(m[key], `keywordMaximums.${key}`, 0);
    }
  }
  const maps = o.maps;
  if (maps !== "entries" && maps !== "object") r.fail("maps", 'must be "entries" or "object"');
  return {
    name: r.string(o.name, "name", NAME, "a profile name, like openai"),
    version: r.integer(o.version, "version", 1),
    date: r.string(o.date, "date", DATE, "a date like 2026-01-31"),
    ...(description === undefined ? {} : { description }),
    sources,
    keywords: r.set(o.keywords, "keywords", PROFILE_KEYWORDS),
    formats: r.set(o.formats, "formats", FORMATS),
    keywordMaximums: maximums,
    maps,
    recursion: r.boolean(o.recursion, "recursion"),
    limits: readLimits(r, o.limits),
  };
}

function readLimits(r: Reader, value: unknown): ProfileLimits {
  const o = r.object(value, "limits", [
    "maxDepth",
    "maxProperties",
    "maxEnumValues",
    "maxStringSize",
    "maxUnions",
    "largeEnum",
  ]);
  const limit = (key: string, minimum: number): Record<string, number> =>
    o[key] === undefined ? {} : { [key]: r.integer(o[key], `limits.${key}`, minimum) };
  let largeEnum: ProfileLimits["largeEnum"];
  if (o.largeEnum !== undefined) {
    const e = r.object(o.largeEnum, "limits.largeEnum", ["values", "maxSize"], ["values", "maxSize"]);
    largeEnum = {
      values: r.integer(e.values, "limits.largeEnum.values", 1),
      maxSize: r.integer(e.maxSize, "limits.largeEnum.maxSize", 1),
    };
  }
  return {
    ...limit("maxDepth", 1),
    ...limit("maxProperties", 1),
    ...limit("maxEnumValues", 1),
    ...limit("maxStringSize", 1),
    ...limit("maxUnions", 0),
    ...(largeEnum === undefined ? {} : { largeEnum }),
  };
}

/** Reads and validates the profile file at `path`, named `shown` in errors. */
export function loadProfile(path: string, shown: string = path): Profile {
  if (!existsSync(path)) throw new ConfigError(shown, "", "profile file not found");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (!isFsError(error)) throw error;
    throw new ConfigError(shown, "", `can't read it: ${fsReason(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(shown, "", `not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseProfile(value, shown);
}

/** True for the name of a profile strictgen ships. */
export function isBuiltinProfile(name: string): boolean {
  return (BUILTIN_PROFILES as readonly string[]).includes(name);
}

/** The path of a built in profile's file. */
export function builtinProfileFile(name: string): string {
  return fileURLToPath(new URL(`${name}.json`, PROFILES_DIR));
}

/** A built in profile by name. Throws a {@link ConfigError} for a name strictgen doesn't ship. */
export function builtinProfile(name: string, option = "llm.profiles"): Profile {
  if (!isBuiltinProfile(name)) {
    throw new ConfigError(
      option,
      "",
      `no built in profile ${JSON.stringify(name)}. Built in profiles: ${BUILTIN_PROFILES.join(", ")}, ` +
        "or give the path of a profile file, ending in .json",
    );
  }
  const profile = loadProfile(builtinProfileFile(name), `profiles/${name}.json`);
  if (profile.name !== name) throw new ConfigError(`profiles/${name}.json`, "name", `must be ${name}`);
  return profile;
}

/**
 * The profiles `llm.profiles` lists, in config order: built in ones by name and profile files by
 * path. Two that end up with the same name fail.
 */
export function configProfiles(refs: readonly LlmProfileRef[], configFile: string): Profile[] {
  const profiles = refs.map((ref, i) =>
    "name" in ref ? builtinProfile(ref.name, `${configFile}: llm.profiles[${String(i)}]`) : loadProfile(ref.file, ref.shown),
  );
  for (const [i, p] of profiles.entries()) {
    const first = profiles.findIndex((q) => q.name === p.name);
    if (first !== i) {
      throw new ConfigError(
        configFile,
        `llm.profiles[${String(i)}]`,
        `names the profile ${p.name}, which llm.profiles[${String(first)}] names too`,
      );
    }
  }
  return profiles;
}

/**
 * The profile `strictgen llm --profile` names: a path ending in .json, a profile file of that
 * name in `llm.profiles`, or a built in one.
 */
export function namedProfile(config: Config, name: string, path: (p: string) => string): Profile {
  if (name.endsWith(".json")) return loadProfile(path(name), name);
  for (const ref of config.llm?.profiles ?? []) {
    if ("file" in ref && couldName(ref.file, name)) return loadProfile(ref.file, ref.shown);
  }
  return builtinProfile(name, "--profile");
}

/**
 * True when the profile file at `path` could be the profile `name`: its `name` field says so, or,
 * when the file can't be read as a JSON object with a string name, its file name does. So a
 * broken file doesn't stop the printing of another profile, while generate still checks them all.
 */
function couldName(path: string, name: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = undefined;
  }
  const written =
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw).name : undefined;
  return typeof written === "string" ? written === name : basename(path) === `${name}.json`;
}
