/**
 * Files strictgen ships beside its code: `package.json` and the built in profiles. From npm or a
 * checkout they are read from disk, next to `src/` and `dist/`. A single executable has no
 * package folder, so the binary build (`scripts/binary-build.mjs`) embeds them as assets under the
 * same paths, and they are read from there.
 */
import { readFileSync } from "node:fs";
import { getAsset, isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import type { BuiltinProfileName } from "./llm-profile.js";
import { BUILTIN_PROFILES } from "./llm-profile.js";

/** A file the package ships and the binary embeds, by its path from the package root. */
export type PackageFile = "package.json" | `profiles/${BuiltinProfileName}.json`;

/** Every file the binary embeds. */
export const PACKAGE_FILES: readonly PackageFile[] = [
  "package.json",
  ...BUILTIN_PROFILES.map((name) => `profiles/${name}.json` as const),
];

/** True when strictgen runs as a single executable, not from a package folder. */
export function inBinary(): boolean {
  return isSea();
}

/**
 * The path on disk of a file in the package root. Only for a package folder: the bundled code of
 * a binary has no module URL, so this is never called there.
 */
export function packagePath(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

/** The text of a file the package ships, from the binary's assets or from disk. */
export function packageFileText(path: PackageFile): string {
  return inBinary() ? getAsset(path, "utf8") : readFileSync(packagePath(path), "utf8");
}
