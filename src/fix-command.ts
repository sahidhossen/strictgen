import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import type { Config } from "./config.js";
import type { FixedFile, FixInput } from "./fix.js";
import { fixSchemas, noteText } from "./fix.js";
import { unifiedDiff } from "./fix-diff.js";
import { fsReason, isFsError } from "./fs-error.js";
import { writeError } from "./main.js";
import { canonical, samePath, within } from "./paths.js";
import type { Io } from "./run.js";
import { CodegenError } from "./schema.js";
import { mainOptions } from "./targets.js";

/** `path` relative to `from`, with `/` separators. */
function shown(from: string, path: string): string {
  const rel = relative(from, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Reads every `*.json` file in the schemas folder, sorted by name, the way generation does. */
export function readSchemaFiles(dir: string): FixInput[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (error) {
    if (!isFsError(error)) throw error;
    throw new CodegenError(dir, "read-failed", `can't read the schemas folder: ${fsReason(error)}`);
  }
  return names.map((file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, file));
    } catch (error) {
      if (!isFsError(error)) throw error;
      throw new CodegenError(file, "read-failed", `can't read it: ${fsReason(error)}`);
    }
    let text: string;
    try {
      text = UTF8.decode(bytes);
    } catch {
      throw new CodegenError(file, "invalid-json", "not valid UTF-8");
    }
    return { name: file.slice(0, -".json".length), text };
  });
}

/**
 * Writes the changed files back into the schemas folder. First checks every one: it must still
 * hold what was read, be a regular file inside the schemas folder (a symlink may point at one),
 * not be the config file, and not be the same file as another schema entry. Then writes each to
 * a temporary file next to it, and only when all of them are written renames them over the
 * originals, keeping each file's mode. The renames are not atomic as a group: when one fails,
 * the error names the files already renamed.
 */
function writeFixed(config: Config, files: readonly FixedFile[]): void {
  const planned: { path: string; name: string; after: string; mode: number }[] = [];
  try {
    const seen = new Map<string, string>();
    for (const file of files) {
      const name = shown(config.root, join(config.schemas, file.file));
      const path = realpathSync(join(config.schemas, file.file));
      const other = seen.get(canonical(path));
      if (other !== undefined) {
        throw new CodegenError(
          name,
          "output-conflict",
          `refusing to write: it is the same file as ${other}`,
          "keep one of them and remove the other, which is a symlink or a hard link to it",
        );
      }
      seen.set(canonical(path), name);
      if (file.before === file.after) continue;
      const refuse = (reason: string, hint: string): never => {
        throw new CodegenError(name, "output-conflict", `refusing to write it: ${reason}`, hint);
      };
      if (!within(path, config.schemas))
        refuse(
          "it is a symlink to a file outside the schemas folder",
          "replace the symlink with the file it points at",
        );
      if (samePath(path, config.file))
        refuse("it is the config file", "keep the config file out of the schemas folder");
      const stat = lstatSync(path);
      if (!stat.isFile() || readFileSync(path, "utf8") !== file.before)
        refuse("it changed while strictgen fix ran", "run strictgen fix again");
      planned.push({ path, name, after: file.after, mode: stat.mode });
    }
  } catch (error) {
    throw writeError(config.root, error);
  }
  const TEMP = ".strictgen-fix";
  const written: string[] = [];
  const renamed: string[] = [];
  try {
    for (const { path, after, mode } of planned) {
      writeFileSync(path + TEMP, after, { flag: "wx" });
      written.push(path + TEMP);
      chmodSync(path + TEMP, mode & 0o7777);
    }
    for (const { path, name } of planned) {
      renameSync(path + TEMP, path);
      renamed.push(name);
    }
  } catch (error) {
    for (const temp of written) rmSync(temp, { force: true });
    if (!isFsError(error)) throw error;
    // Name the file as the schemas folder shows it, not by the path its symlinks resolve to.
    const file = planned.find((p) => error.path === p.path || error.path === p.path + TEMP);
    const temp = file !== undefined && error.path !== file.path;
    const name = file === undefined ? "." : file.name + (temp ? TEMP : "");
    const done = renamed.length === 0 ? "" : `. Already written: ${renamed.join(", ")}`;
    const hint =
      error.code === "EEXIST" && temp
        ? "it is left from an earlier run that stopped; delete it and run strictgen fix --write again"
        : undefined;
    throw new CodegenError(
      name,
      "write-failed",
      `can't write the output: ${fsReason(error)}${done}`,
      hint,
    );
  }
}

/**
 * `strictgen fix`: rewrites the schemas into the supported subset where it can. Prints a unified
 * diff, or with `write` writes the files in place, then lists what it left and the first
 * generation error, if any. Returns 1 when generation still fails, else 0.
 */
export function fixCommand(config: Config, io: Io, write: boolean): number {
  const options = mainOptions(config);
  const result = fixSchemas(readSchemaFiles(config.schemas), {
    targets: options.targets,
    ...(options.idBase === undefined ? {} : { idBase: options.idBase }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.validation === undefined ? {} : { validation: options.validation }),
  });
  const changed = result.files.filter((f) => f.before !== f.after);
  if (write) writeFixed(config, result.files);
  else {
    for (const file of changed) {
      const path = shown(io.cwd, join(config.schemas, file.file));
      for (const line of unifiedDiff(path, file.before, file.after)) io.out(line);
    }
  }
  for (const note of result.notes) io.err(`notice: ${noteText(note)}`);
  const count = changed.length === 1 ? "1 schema file" : `${String(changed.length)} schema files`;
  const summary =
    changed.length === 0
      ? "Nothing to fix."
      : write
        ? `Fixed ${count}.`
        : `strictgen fix --write would change ${count}.`;
  if (result.problem === undefined) {
    (write ? io.out : io.err)(`${summary} The schemas generate cleanly.`);
    return 0;
  }
  io.err(`error: ${result.problem.message}`);
  io.err(
    `${summary} Generation still fails: change the schema by hand where the error points` +
      (changed.length > 0 && !write ? " (in the schemas as fixed)" : "") +
      ", then run strictgen fix again.",
  );
  return 1;
}
