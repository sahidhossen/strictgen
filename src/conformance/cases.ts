/**
 * The conformance cases and the marks of known differences, read from the `conformance` folder:
 *
 * ```text
 * conformance/
 *   schemas/<name>.json
 *   cases/<Type>/valid/<case>.json            accepted in every mode, with no unknown keys
 *   cases/<Type>/invalid/<case>.json          rejected
 *   cases/<Type>/invalid/<case>.expect.json   {"path": "/x", "code": "too_long"}, the first error
 *   marks.json                                the known differences, each with a reason
 * ```
 *
 * An expectation gives the error of strict mode. When report mode reads the case differently,
 * because the strict error is an unknown key, `report` says how: `{"unknown": ["/x"]}` when it
 * accepts the case with those unknown keys, or `{"path", "code"}` for another first error.
 *
 * Anything else in the folder is a mistake and fails the run, so a misspelled folder never
 * skips a case.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ERROR_CODES } from "../errors.js";
import type { Mode } from "./protocol.js";

/** Ends the file next to an invalid case that holds the error it expects. */
export const EXPECT = ".expect.json";

const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const CODES = new Set(ERROR_CODES.map((c) => c.code));

/** What a decode should give. */
export type Outcome =
  | { readonly accepted: true; readonly unknown: readonly string[] }
  | { readonly accepted: false; readonly path: string; readonly code: string };

export interface Case {
  /** Like `Order/invalid/note-too-long`. */
  readonly id: string;
  readonly type: string;
  readonly valid: boolean;
  readonly bytes: Uint8Array;
  readonly strict: Outcome;
  readonly report: Outcome;
}

/** The outcome a case expects in a mode. */
export function expected(c: Case, mode: Mode): Outcome {
  return mode === "strict" ? c.strict : c.report;
}

/** The cases folder or marks file don't follow the layout. Lists every problem found. */
export class LayoutError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.length === 1 ? (problems[0] ?? "") : `${String(problems.length)} problems:\n${problems.join("\n")}`);
    this.name = "LayoutError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(file: string, shown: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    problems.push(`${shown}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    return undefined;
  }
}

/** An error outcome from `{path, code}`, or a reason it isn't one. */
function errorOutcome(value: Record<string, unknown>, keys: readonly string[]): Outcome | string {
  const { path, code } = value;
  if (typeof path !== "string" || typeof code !== "string") return "path and code must be strings";
  if (path !== "" && !path.startsWith("/")) return `path ${JSON.stringify(path)} is not a JSON Pointer`;
  if (!CODES.has(code)) return `code ${JSON.stringify(code)} is not an error code`;
  const extra = Object.keys(value).filter((k) => !keys.includes(k));
  if (extra.length > 0) return `unexpected key ${extra.map((k) => JSON.stringify(k)).join(", ")}`;
  return { accepted: false, path, code };
}

function expectation(value: unknown): { strict: Outcome; report: Outcome } | string {
  const shape = 'expected {"path": ..., "code": ...}, with an optional "report"';
  if (!isObject(value)) return shape;
  const strict = errorOutcome(value, ["path", "code", "report"]);
  if (typeof strict === "string") return strict;
  if (value.report === undefined) return { strict, report: strict };
  const report = value.report;
  if (!isObject(report)) return 'report must be {"unknown": [...]} or {"path": ..., "code": ...}';
  if ("unknown" in report) {
    const { unknown } = report;
    if (Object.keys(report).length !== 1 || !Array.isArray(unknown) || !unknown.every((p) => typeof p === "string")) {
      return 'report must be {"unknown": [...]} with a list of JSON Pointers';
    }
    if (!unknown.every((p: string) => p.startsWith("/"))) return "every unknown path must be a JSON Pointer to a key";
    return { strict, report: { accepted: true, unknown } };
  }
  const other = errorOutcome(report, ["path", "code"]);
  if (typeof other === "string") return `report: ${other}`;
  return { strict, report: other };
}

function entries(dir: string): string[] {
  return readdirSync(dir).sort();
}

/**
 * Reads every case under `root` (the `cases` folder). `types` are the names of the types a case
 * folder may name.
 */
export function loadCases(root: string, types: ReadonlySet<string>): Case[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new LayoutError([`${root}: no cases folder`]);
  const problems: string[] = [];
  const cases: Case[] = [];
  for (const type of entries(root)) {
    const typeDir = join(root, type);
    if (!statSync(typeDir).isDirectory()) {
      problems.push(`${type}: a file where a type folder should be`);
      continue;
    }
    if (!types.has(type)) problems.push(`${type}: no generated type has this name`);
    for (const kind of entries(typeDir)) {
      const kindDir = join(typeDir, kind);
      if ((kind !== "valid" && kind !== "invalid") || !statSync(kindDir).isDirectory()) {
        problems.push(`${type}/${kind}: only valid and invalid folders belong here`);
        continue;
      }
      const names = new Set(entries(kindDir));
      for (const name of names) {
        const shown = `${type}/${kind}/${name}`;
        const file = join(kindDir, name);
        if (!statSync(file).isFile()) {
          problems.push(`${shown}: only case files belong here`);
          continue;
        }
        if (name.endsWith(EXPECT)) {
          if (kind !== "invalid" || !names.has(`${name.slice(0, -EXPECT.length)}.json`)) {
            problems.push(`${shown}: no invalid case next to it`);
          }
          continue;
        }
        const base = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
        if (base === undefined || !CASE_NAME.test(base)) {
          problems.push(`${shown}: a case is <lowercase-name>.json, in letters, digits and dashes`);
          continue;
        }
        const id = `${type}/${kind}/${base}`;
        const bytes = new Uint8Array(readFileSync(file));
        if (kind === "valid") {
          const outcome: Outcome = { accepted: true, unknown: [] };
          cases.push({ id, type, valid: true, bytes, strict: outcome, report: outcome });
          continue;
        }
        const expectName = `${base}${EXPECT}`;
        if (!names.has(expectName)) {
          problems.push(`${shown}: every invalid case needs ${expectName}`);
          continue;
        }
        const before = problems.length;
        const json = readJson(join(kindDir, expectName), `${type}/${kind}/${expectName}`, problems);
        if (problems.length > before) continue;
        const parsed = expectation(json);
        if (typeof parsed === "string") {
          problems.push(`${type}/${kind}/${expectName}: ${parsed}`);
          continue;
        }
        cases.push({ id, type, valid: false, bytes, ...parsed });
      }
    }
  }
  if (problems.length > 0) throw new LayoutError(problems);
  if (cases.length === 0) throw new LayoutError([`${root}: no cases`]);
  return cases;
}

/**
 * A known difference between the languages, with the reason it is allowed. A marked case still
 * runs, and must still differ in exactly the stated way, so a mark that no longer applies fails.
 *
 * - `ts-unsafe-integer`: TypeScript numbers hold integers exactly only up to 2^53 - 1, where
 *   Rust and Go hold 64 bits. TypeScript must reject the case with `out_of_range_integer` at
 *   `path`; Rust and Go are checked against the expectation and each other as usual.
 * - `number-spelling`: the languages spell a number differently when they encode it again, like
 *   `100.0`, `1e2` and `100`. The re-encoded bytes must differ, and be equal once canonical.
 * - `line-separator-escaping`: Go escapes U+2028 and U+2029 when it encodes, the others don't.
 *   One encoding must hold the escape and another the character, and they must be equal once
 *   canonical.
 */
export type MarkKind = "ts-unsafe-integer" | "number-spelling" | "line-separator-escaping";
export const MARK_KINDS: readonly MarkKind[] = ["ts-unsafe-integer", "number-spelling", "line-separator-escaping"];

export interface Mark {
  readonly case: string;
  readonly kind: MarkKind;
  /** For `ts-unsafe-integer`: where TypeScript fails. */
  readonly path?: string;
  readonly reason: string;
}

/** Reads `marks.json`: `{"marks": [{"case", "kind", "path"?, "reason"}]}`. Each must name a case. */
export function loadMarks(file: string, cases: readonly Case[]): Mark[] {
  if (!existsSync(file)) throw new LayoutError([`${file}: no marks file`]);
  const problems: string[] = [];
  const value = readJson(file, "marks.json", problems);
  if (problems.length > 0) throw new LayoutError(problems);
  if (!isObject(value) || Object.keys(value).join() !== "marks" || !Array.isArray(value.marks)) {
    throw new LayoutError(['marks.json: expected {"marks": [...]}']);
  }
  const ids = new Set(cases.map((c) => c.id));
  const seen = new Set<string>();
  const marks: Mark[] = [];
  value.marks.forEach((entry: unknown, i: number) => {
    const at = `marks.json: mark ${String(i)}`;
    if (!isObject(entry)) {
      problems.push(`${at}: expected an object`);
      return;
    }
    const extra = Object.keys(entry).filter((k) => !["case", "kind", "path", "reason"].includes(k));
    if (extra.length > 0) problems.push(`${at}: unexpected key ${extra.join(", ")}`);
    const { case: id, kind, path, reason } = entry;
    if (typeof id !== "string" || !ids.has(id)) problems.push(`${at}: case ${JSON.stringify(id)} is not a case`);
    if (typeof kind !== "string" || !(MARK_KINDS as readonly string[]).includes(kind)) {
      problems.push(`${at}: kind must be one of ${MARK_KINDS.join(", ")}`);
    }
    if (typeof reason !== "string" || reason.trim() === "") problems.push(`${at}: every mark needs a reason`);
    if (kind === "ts-unsafe-integer") {
      if (typeof path !== "string" || !path.startsWith("/")) problems.push(`${at}: ts-unsafe-integer needs the path TypeScript fails at`);
    } else if (path !== undefined) {
      problems.push(`${at}: only ts-unsafe-integer takes a path`);
    }
    const key = `${String(id)} ${String(kind)}`;
    if (seen.has(key)) problems.push(`${at}: ${String(id)} is marked ${String(kind)} twice`);
    seen.add(key);
    if (typeof id === "string" && typeof kind === "string" && typeof reason === "string") {
      marks.push({ case: id, kind: kind as MarkKind, reason, ...(typeof path === "string" ? { path } : {}) });
    }
  });
  if (problems.length > 0) throw new LayoutError(problems);
  return marks;
}
