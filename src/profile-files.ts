/**
 * Profile files on disk: the built in profiles in `profiles/`, beside `src/` and `dist/`, and the
 * profile files a config names by path. What a profile is and how it is checked lives in
 * `llm-profile.ts`, which needs no file system.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import type { Config, LlmProfileRef } from "./config.js";
import { ConfigError } from "./config-error.js";
import { fsReason, isFsError } from "./fs-error.js";
import type { BuiltinProfileName, Profile } from "./llm-profile.js";
import { builtinProfileFromText, checkBuiltinProfile, profileFromText } from "./llm-profile.js";
import { inBinary, packageFileText, packagePath } from "./package-files.js";

type Raw = Readonly<Record<string, unknown>>;

/** Reads and validates the profile file at `path`, named `shown` in errors. */
export function loadProfile(path: string, shown: string = path): Profile {
  return profileFromText(readProfile(path, shown), shown);
}

function readProfile(path: string, shown: string): string {
  if (!existsSync(path)) throw new ConfigError(shown, "", "profile file not found");
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (!isFsError(error)) throw error;
    throw new ConfigError(shown, "", `can't read it: ${fsReason(error)}`);
  }
}

/** The path of a built in profile's file in the package folder: `profiles/`, beside `dist/`. */
export function builtinProfileFile(name: string): string {
  return packagePath(`profiles/${name}.json`);
}

/**
 * A built in profile by name, from the package folder or, in a single executable, from the
 * binary's assets. Throws a {@link ConfigError} for a name strictgen doesn't ship.
 */
export function builtinProfile(name: string, option = "llm.profiles"): Profile {
  checkBuiltinProfile(name, option);
  const file = `profiles/${name as BuiltinProfileName}.json` as const;
  const text = inBinary() ? packageFileText(file) : readProfile(builtinProfileFile(name), file);
  return builtinProfileFromText(name, text);
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
