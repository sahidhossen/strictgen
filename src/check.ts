import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { DEFAULT_HEADER } from "./common.js";
import type { OutputFile, Target } from "./main.js";
import { isGenerated } from "./main.js";

/** How a file on disk differs from the generated output. */
export type DifferenceKind = "differs" | "missing" | "stale";

/** One file that is out of date, with its path relative to the output root. */
export interface Difference {
  readonly kind: DifferenceKind;
  readonly path: string;
}

/** `path` relative to `root`, with `/` separators, as output paths are. */
function under(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

/** Every file below `dir`, as absolute paths. */
function walk(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/** The generated files directly in a shared folder, the ones that start with `header`. */
function generatedIn(dir: string, header: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(dir, entry.name))
    .filter((path) => isGenerated(readFileSync(path, "utf8"), header));
}

/**
 * Compares `files` with what is under `rootDir`, without writing anything: a file that is missing
 * or has other contents, and a stale file, one that generating again would remove. Stale files
 * are any file in an owned folder, and a generated file in a shared folder, that `files` doesn't
 * list. Sorted by path.
 */
export function differences(
  rootDir: string,
  targets: readonly Target[],
  files: readonly OutputFile[],
  header: string = DEFAULT_HEADER,
): Difference[] {
  const found: Difference[] = [];
  const expected = new Set(files.map((f) => f.path));
  for (const file of files) {
    const path = join(rootDir, file.path);
    if (!existsSync(path)) found.push({ kind: "missing", path: file.path });
    else if (!statSync(path).isFile() || readFileSync(path, "utf8") !== file.contents) {
      found.push({ kind: "differs", path: file.path });
    }
  }
  const owned = targets.flatMap((t) => t.dirs).flatMap((dir) => walk(join(rootDir, dir)));
  const shared = targets
    .flatMap((t) => t.shared ?? [])
    .flatMap((dir) => generatedIn(join(rootDir, dir), header));
  for (const path of [...owned, ...shared].map((p) => under(rootDir, p))) {
    if (!expected.has(path)) found.push({ kind: "stale", path });
  }
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
