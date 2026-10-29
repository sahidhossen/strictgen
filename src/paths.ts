import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * A path as the filesystem sees it, for safety checks before a folder is cleared: absolute,
 * with symlinks resolved through its nearest existing ancestor, then case-folded and in NFC.
 * Case is folded on every platform, so a check never depends on whether the filesystem is case
 * sensitive. At worst that refuses two folders that differ only in case.
 */
export function canonical(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // Unreadable: keep the resolved path.
  }
  return join(real, ...rest)
    .normalize("NFC")
    .toLowerCase();
}

/** True when `path` is `dir` or below it, both compared as {@link canonical} paths. */
export function within(path: string, dir: string): boolean {
  const rel = relative(canonical(dir), canonical(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when `a` and `b` are the same folder, compared as {@link canonical} paths. */
export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}
