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
 *   manifest.json                             how many cases each type has, or why it has none
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
  /**
   * The JSON the decoded value must encode to again, when it isn't the input itself: for an LLM
   * payload, the normal JSON of the same value.
   */
  readonly encodes?: Uint8Array;
  /** The compact form the first error must have, for the shared LLM vectors. */
  readonly compact?: string;
  /** For a cleanup vector: the text the cleanup step must return. */
  readonly cleaned?: string;
  /**
   * The read modes the case has no expectation in, so only the languages are compared with each
   * other there: for the payloads the fuzzer shrinks, whose error nobody knows. LLM decoders
   * read as strict mode.
   */
  readonly unlabelled?: readonly Mode[];
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
 * Marks that take one language out of the comparison, which must then do exactly this:
 *
 * - `ts-unsafe-integer`: TypeScript numbers hold integers exactly only up to 2^53 - 1, where
 *   Rust and Go hold 64 bits. TypeScript must reject the case with `out_of_range_integer` at
 *   `path`, naming its own range.
 * - `ts-no-bytes-api`: the TypeScript decoders take a string, so bytes that aren't UTF-8 never
 *   reach them. TypeScript must reject the case with `invalid_json` at the root.
 * - `go-unmarshal-syntax`: `json.Unmarshal` checks the syntax itself before the generated
 *   decoder runs, so for text that isn't JSON it returns its own `*json.SyntaxError`. Go must do
 *   that through its public entry point in strict mode; its other variants are compared as usual.
 * - `serde-outer-parse`: `serde_json::from_slice` reads the text around a bridged value itself,
 *   and checks its syntax and UTF-8 before the serde bridge gets the value's raw text, so for
 *   text that isn't JSON it returns its own error. Rust must do that, `serde_json.Error` at the
 *   root, through the `serde` entry; its other entries are compared as usual.
 *
 * Marks that allow the bytes each language writes to differ in one way only, once the canonical
 * bytes are equal. Without a mark, the bytes as written must be equal too:
 *
 * - `number-spelling`: a number's spelling, like `150.0`, `1.50E+2` and `150`.
 * - `line-separator-escaping`: U+2028 and U+2029 escaped or written as they are.
 * - `html-escaping`: `<`, `>` and `&` escaped or written as they are.
 * - `string-escaping`: any character of a string or key escaped or written as it is.
 * - `key-order`: the order of an object's keys.
 *
 * Every mark must be needed: a mark whose removal changes nothing in any run fails.
 */
export type MarkKind =
  | "ts-unsafe-integer"
  | "ts-no-bytes-api"
  | "go-unmarshal-syntax"
  | "serde-outer-parse"
  | "number-spelling"
  | "line-separator-escaping"
  | "html-escaping"
  | "string-escaping"
  | "key-order";
export const MARK_KINDS: readonly MarkKind[] = [
  "ts-unsafe-integer",
  "ts-no-bytes-api",
  "go-unmarshal-syntax",
  "serde-outer-parse",
  "number-spelling",
  "line-separator-escaping",
  "html-escaping",
  "string-escaping",
  "key-order",
];

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

/**
 * How many valid and invalid cases each type has, from `manifest.json`, so a case or a type
 * folder that disappears fails the run instead of shrinking it. A type with no cases is listed
 * under `empty` with the reason.
 *
 * `llm` lists the schema files the LLM packages leave out, each with the reason no
 * provider-ready schema can describe a type of it; every other schema file must project under
 * every profile, and every listed one must fail to. `coverage` lists the sides of mapping rules
 * no case can have, like `any/invalid`, each with the reason (see `coverage.ts`).
 */
export interface Manifest {
  readonly types: ReadonlyMap<string, { readonly valid: number; readonly invalid: number }>;
  readonly empty: ReadonlyMap<string, string>;
  readonly llm: ReadonlyMap<string, string>;
  readonly coverage: ReadonlyMap<string, string>;
}

/** A map of names to reasons, from one of the manifest's optional sections. */
function reasons(value: unknown, section: string, problems: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (value === undefined) return out;
  if (!isObject(value)) {
    problems.push(`manifest.json: ${section} must map names to reasons`);
    return out;
  }
  for (const [name, why] of Object.entries(value)) {
    if (typeof why !== "string" || why.trim() === "") problems.push(`manifest.json: ${section} ${name} needs a reason`);
    else out.set(name, why);
  }
  return out;
}

/**
 * Reads `manifest.json`: `{"types": {"Order": {"valid": 1, "invalid": 2}}, "empty": {"Note": "why"},
 * "llm": {"shipment.json": "why"}, "coverage": {"any/invalid": "why"}}`, the last two optional.
 */
export function loadManifest(file: string): Manifest {
  if (!existsSync(file)) throw new LayoutError([`${file}: no manifest file`]);
  const problems: string[] = [];
  const value = readJson(file, "manifest.json", problems);
  if (problems.length > 0) throw new LayoutError(problems);
  const shape =
    'manifest.json: expected {"types": {"<Type>": {"valid": n, "invalid": n}}, "empty": {"<Type>": "<reason>"}}, with optional "llm" and "coverage" reasons';
  const keys = isObject(value) ? Object.keys(value) : [];
  if (
    !isObject(value) ||
    !keys.includes("types") ||
    !keys.includes("empty") ||
    keys.some((k) => !["types", "empty", "llm", "coverage"].includes(k)) ||
    !isObject(value.types) ||
    !isObject(value.empty)
  ) {
    throw new LayoutError([shape]);
  }
  const types = new Map<string, { valid: number; invalid: number }>();
  for (const [type, counts] of Object.entries(value.types)) {
    const ok =
      isObject(counts) &&
      Object.keys(counts).sort().join() === "invalid,valid" &&
      Number.isSafeInteger(counts.valid) &&
      Number.isSafeInteger(counts.invalid) &&
      (counts.valid as number) >= 0 &&
      (counts.invalid as number) >= 0 &&
      (counts.valid as number) + (counts.invalid as number) > 0;
    if (!ok) problems.push(`manifest.json: ${type} needs {"valid": n, "invalid": n}, with at least one case`);
    else types.set(type, { valid: counts.valid as number, invalid: counts.invalid as number });
  }
  const empty = new Map<string, string>();
  for (const [type, why] of Object.entries(value.empty)) {
    if (typeof why !== "string" || why.trim() === "") problems.push(`manifest.json: empty type ${type} needs a reason`);
    else empty.set(type, why);
    if (types.has(type)) problems.push(`manifest.json: ${type} is listed with cases and as empty`);
  }
  const llm = reasons(value.llm, "llm", problems);
  const coverage = reasons(value.coverage, "coverage", problems);
  if (problems.length > 0) throw new LayoutError(problems);
  return { types, empty, llm, coverage };
}

/**
 * Checks the cases against the manifest: every type is listed, with exactly the counts it has.
 * A count that drops means a case disappeared; one that grows means the manifest needs updating.
 */
export function checkManifest(manifest: Manifest, cases: readonly Case[], types: ReadonlySet<string>): void {
  const problems: string[] = [];
  const counts = new Map<string, { valid: number; invalid: number }>();
  for (const c of cases) {
    const n = counts.get(c.type) ?? { valid: 0, invalid: 0 };
    if (c.valid) n.valid++;
    else n.invalid++;
    counts.set(c.type, n);
  }
  for (const type of [...types].sort()) {
    const want = manifest.types.get(type);
    const got = counts.get(type) ?? { valid: 0, invalid: 0 };
    if (want === undefined) {
      if (!manifest.empty.has(type)) {
        problems.push(
          `${type}: not in manifest.json. Add it under "types" with {"valid": ${String(got.valid)}, "invalid": ${String(got.invalid)}}, or under "empty" with the reason it has no cases`,
        );
      } else if (got.valid + got.invalid > 0) {
        problems.push(`${type}: has cases now, so move it from "empty" to "types" in manifest.json`);
      }
      continue;
    }
    for (const kind of ["valid", "invalid"] as const) {
      if (got[kind] < want[kind]) {
        problems.push(`${type}: ${String(got[kind])} ${kind} cases, manifest.json says ${String(want[kind])}: a case or folder disappeared`);
      } else if (got[kind] > want[kind]) {
        problems.push(`${type}: ${String(got[kind])} ${kind} cases, manifest.json says ${String(want[kind])}: update manifest.json`);
      }
    }
  }
  for (const type of [...manifest.types.keys(), ...manifest.empty.keys()].sort()) {
    if (!types.has(type)) problems.push(`manifest.json: ${type} is not a generated type`);
  }
  if (problems.length > 0) throw new LayoutError(problems);
}
