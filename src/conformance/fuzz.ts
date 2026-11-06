/**
 * The differential fuzzer: random payloads through every decoder the proof suite has, compared
 * across the languages. `fuzz-main.ts` is its command line (`pnpm fuzz`).
 *
 * Run `i` of seed `s` is the same on every machine, whatever else runs: it seeds its own
 * payload generator (`payloads.ts`) from `s` and `i`, picks a type of `conformance/schemas`,
 * and makes one valid payload of it, a few of its near misses and one cleanup input:
 *
 * - The valid payload must be accepted in every read mode with no unknown keys, and encode to its
 *   own canonical bytes.
 * - A near miss of the generator's both-mode list must fail with the generator's label (path and
 *   code) in every language and read mode; one of its strict-only list, an unknown key, with the
 *   label in strict mode, and accepted with that key reported in report mode.
 * - All of them run through every variant of the suite (`suiteJobs`): both read modes, both entry
 *   points, code generated with and without `llm`, and the LLM decoders of every map shape, in the
 *   LLM form `llm-cases.ts` projects them to, with the near misses only that form has.
 * - The cleanup input is the valid payload with a byte order mark, white space, a code fence and
 *   trailing commas around and inside it, at random, which the cleanup step must take off again,
 *   giving back exactly the payload.
 *
 * Nobody knows the right answer for a random payload, so the languages agreeing is the oracle,
 * beside the generator's labels. Any difference in the result, the five error fields, the unknown
 * keys, or the canonical or raw bytes fails, unless a mark kind allows it ({@link fuzzMarks}).
 *
 * A failing payload is shrunk ({@link shrink}): keys, items and characters removed and numbers
 * made simpler, while the same fields still disagree, then printed with the seed and the run,
 * and with `save` written as a new case of `conformance/cases`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Model } from "../model.js";
import { GenerateError, PayloadGenerator, Random } from "../payloads.js";
import type { Payload } from "../payloads.js";
import type { Json } from "./canonical.js";
import { CanonicalError, JsonNumber, parseJson } from "./canonical.js";
import type { Case, Mark, Outcome } from "./cases.js";
import { EXPECT, LayoutError } from "./cases.js";
import type { Disagreement, Run } from "./compare.js";
import { compareRun, table } from "./compare.js";
import type { Driver, Package } from "./drivers.js";
import { buildGo, buildRust, caseTypes, conformanceModel, generateAll, probeToolchain, typeScriptDriver } from "./drivers.js";
import { project } from "./llm-cases.js";
import type { Language, Result, Variant } from "./protocol.js";
import { DriverError, LANGUAGES, MODES, packageName, variantName } from "./protocol.js";
import type { Job } from "./suite.js";
import { jobRequests, loadSuite, suiteJobs, vectorMarks, withScratch } from "./suite.js";
import { ModelWalk, segment, writeJson } from "./walk.js";

/** How many near misses of each list a run takes, at most. */
const MISSES = 3;
/** How many runs go to the drivers in one batch. */
export const BATCH = 400;
/** How long one driver may take for one batch. */
const BATCH_TIMEOUT = 120_000;
/** How many shrink steps a failure gets, at most, and how many candidates one step tries. */
const SHRINK_STEPS = 400;
const SHRINK_BATCH = 64;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ACCEPTED: Outcome = { accepted: true, unknown: [] };

/** The variant the cleanup inputs run in: the cleanup step of the code generated for `examples/llm`. */
export const CLEANUP: Variant = { mode: "report", decoder: "cleanup", entry: "public", vectors: true };

/** The seed of run `index`: the run seed and the index, mixed (splitmix32), so neighbouring runs differ. */
export function runSeed(seed: number, index: number): number {
  let z = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

/** A type the fuzzer can't make payloads for, with the generator's reason. */
export interface Unfuzzable {
  readonly type: string;
  readonly reason: string;
}

/**
 * The case types the generator makes payloads for, sorted, and those it can't, like a type
 * with no finite value. Which types fail doesn't depend on the seed (`payloads.ts`).
 */
export function fuzzTypes(model: Model): { types: string[]; unfuzzable: Unfuzzable[] } {
  const types: string[] = [];
  const unfuzzable: Unfuzzable[] = [];
  const generator = new PayloadGenerator(model, { read: MODES });
  for (const type of [...caseTypes(model).keys()].sort()) {
    try {
      generator.nearMisses(type, generator.valid(type));
      types.push(type);
    } catch (error) {
      if (!(error instanceof GenerateError)) throw error;
      unfuzzable.push({ type, reason: error.message });
    }
  }
  return { types, unfuzzable };
}

/** What one run made: its cases, by id, with what each one changed and the payload as a tree. */
export interface FuzzRun {
  readonly index: number;
  readonly type: string;
  readonly cases: readonly Case[];
  readonly cleanup: Case;
  /** For each case, what the generator changed, like `removed the required key "id"`. */
  readonly changes: ReadonlyMap<string, string>;
}

/** The text of a payload the generator made. */
function payloadText(payload: Payload): string {
  return JSON.stringify(payload);
}

/** True for a character outside a string: the offsets of `}` and `]` that end a container. */
function closers(text: string): number[] {
  const out: number[] = [];
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "}" || c === "]") out.push(i);
  }
  return out;
}

const SPACE = [" ", "\t", "\n", "\r"];

function spaces(random: Random, most: number): string {
  let out = "";
  for (let n = random.int(0, most); n > 0; n--) out += random.pick(SPACE);
  return out;
}

/**
 * A cleanup input for `text`, a payload as compact JSON: what the cleanup step must take off
 * (docs/llm.md), chosen at random. A trailing comma goes right before a `}` or `]` outside a
 * string, since white space after it would stay; a code fence's info string is letters only.
 */
export function cleanupInput(text: string, random: Random): string {
  let body = text;
  const at = closers(text).filter(() => random.chance(0.3));
  for (const i of at.reverse()) body = `${body.slice(0, i)},${body.slice(i)}`;
  if (random.chance(0.5)) {
    const info = random.pick(["", "json", "JSON"]);
    const after = random.pick(["", " ", "\t", "\r"]);
    body = `\`\`\`${info}${after}\n${spaces(random, 2)}${body}${spaces(random, 2)}\n${random.pick(["", " ", "\t"])}\`\`\``;
  }
  body = `${spaces(random, 2)}${body}${spaces(random, 2)}`;
  return random.chance(0.4) ? `\u{feff}${body}` : body;
}

/** Run `index` of `seed`, over `types` (from {@link fuzzTypes}). */
export function fuzzRun(model: Model, types: readonly string[], seed: number, index: number): FuzzRun {
  const s = runSeed(seed, index);
  const random = new Random(s);
  const type = random.pick(types);
  const both = new PayloadGenerator(model, { seed: s, read: MODES });
  const strict = new PayloadGenerator(model, { seed: s ^ 0x5bd1e995, read: "strict" });
  const valid = both.valid(type);
  const text = payloadText(valid);
  const id = (what: string): string => `fuzz/${String(index)}/${type}/${what}`;
  const cases: Case[] = [{ id: id("valid"), type, valid: true, bytes: bytes(text), strict: ACCEPTED, report: ACCEPTED }];
  const changes = new Map<string, string>([[id("valid"), "a valid payload"]]);
  const add = (name: string, miss: { payload: Payload; path: string; code: string; change: string }, report?: Outcome): void => {
    const outcome: Outcome = { accepted: false, path: miss.path, code: miss.code };
    cases.push({ id: id(name), type, valid: false, bytes: bytes(payloadText(miss.payload)), strict: outcome, report: report ?? outcome });
    changes.set(id(name), miss.change);
  };
  const misses = both.nearMisses(type, valid);
  random.shuffle(misses).slice(0, MISSES).forEach((m, k) => add(`miss-${String(k)}`, m));
  // Unknown keys fail in strict mode only, so they come from a strict generator. Its label is
  // unknown_key only outside every untagged union (inside one the union fails), so report mode
  // accepts the payload with that one unknown key.
  const seen = new Set(misses.map((m) => `${m.path} ${m.code} ${payloadText(m.payload)}`));
  const unknown = strict.nearMisses(type, valid).filter((m) => m.code === "unknown_key" && !seen.has(`${m.path} ${m.code} ${payloadText(m.payload)}`));
  const extra = unknown.length > 0 ? random.pick(unknown) : undefined;
  if (extra !== undefined) add("unknown", extra, { accepted: true, unknown: [extra.path] });
  const cleanup: Case = {
    id: id("cleanup"),
    type: "",
    valid: true,
    bytes: bytes(cleanupInput(text, random)),
    strict: ACCEPTED,
    report: ACCEPTED,
    cleaned: text,
  };
  changes.set(cleanup.id, "a valid payload with a byte order mark, white space, a code fence or trailing commas around it, at random");
  return { index, type, cases, cleanup, changes };
}

/** The largest integer every language holds exactly. */
const SAFE = 2n ** 53n - 1n;

/** The path of the first integer of a tree beyond what a TypeScript number holds exactly, if any. */
function unsafeInteger(value: Json, path = ""): string | undefined {
  if (value instanceof JsonNumber) {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value.raw)) return undefined;
    const n = BigInt(value.raw);
    return n > SAFE || n < -SAFE ? path : undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = unsafeInteger(value[i] ?? null, `${path}${segment(i)}`);
      if (found !== undefined) return found;
    }
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      const found = unsafeInteger(v, `${path}${segment(k)}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** True when a tree holds a number spelled with a fraction or an exponent. */
function spelledNumber(value: Json): boolean {
  if (value instanceof JsonNumber) return /[.eE]/.test(value.raw);
  if (Array.isArray(value)) return value.some(spelledNumber);
  if (value instanceof Map) return [...value.values()].some(spelledNumber);
  return false;
}

function tree(c: Case): Json | undefined {
  try {
    return parseJson(TEXT.decode(c.bytes));
  } catch (error) {
    if (error instanceof CanonicalError || error instanceof TypeError) return undefined;
    throw error;
  }
}

/**
 * The marks a fuzz case carries, from its payload alone, since it has no entry in marks.json.
 * Each kind applies only where its difference can happen, and a marked language must still do
 * exactly what the kind states (`compare.ts`); unlike the marks of the corpus, a fuzz mark need
 * not change anything, since most payloads that could differ don't. The kinds that allow raw
 * bytes to differ only matter once a value is accepted and encoded again, and an invalid payload
 * may be accepted too, in report mode, with its unknown key:
 *
 * - `html-escaping` and `line-separator-escaping`: a payload with `<`, `>` or `&`, or with
 *   U+2028 or U+2029, which Go's encoder escapes (as for the shared vectors, `vectorMarks`).
 * - `number-spelling`: a payload with a number spelled with a fraction or an exponent, like
 *   `1e-7`, which Go writes as it read it and Rust and TypeScript in their own spelling.
 * - `ts-unsafe-integer`: an integer beyond 2^53 - 1 either way, at the first such path, which
 *   TypeScript must reject with out_of_range_integer there.
 *
 * The other kinds (string-escaping, key-order, ts-no-bytes-api, go-unmarshal-syntax,
 * serde-outer-parse) never apply: the generator's payloads are UTF-8 JSON text, with no value of
 * `any` type spelled with escapes.
 */
export function fuzzMarks(c: Case): Mark[] {
  const out = vectorMarks({ ...c, valid: true });
  const value = tree(c);
  if (value === undefined) return out;
  if (spelledNumber(value)) {
    out.push({ case: c.id, kind: "number-spelling", reason: "A fraction or an exponent is spelled by each language its own way: Go as it read it, Rust and TypeScript in their own spelling." });
  }
  const unsafe = unsafeInteger(value);
  if (unsafe !== undefined) {
    out.push({ case: c.id, kind: "ts-unsafe-integer", path: unsafe, reason: "A TypeScript number holds integers exactly only up to 2^53 - 1, where Rust and Go hold 64 bits." });
  }
  return out;
}

/** Every job of a batch of runs: the suite's variants for the cases, and the cleanup step for the cleanup inputs. */
export function fuzzJobs(runs: readonly FuzzRun[], packages: readonly Package[]): { jobs: Job[]; marks: Mark[] } {
  const cases = runs.flatMap((r) => r.cases);
  const marks = cases.flatMap(fuzzMarks);
  const jobs = suiteJobs({ cases, marks, packages, modes: MODES });
  for (const r of runs) jobs.push({ case: r.cleanup, variant: CLEANUP, marks: [] });
  return { jobs, marks };
}

/** Each language's results for a list of jobs, from its driver. */
function runJobs(drivers: readonly Driver[], jobs: readonly Job[]): Partial<Record<Language, readonly Result[]>> {
  const requests = jobRequests(jobs);
  const results: Partial<Record<Language, readonly Result[]>> = {};
  for (const d of drivers) results[d.language] = d.run(requests);
  return results;
}

/** The rows of one job, given each language's result for it. */
function jobRows(job: Job, results: Readonly<Partial<Record<Language, Result>>>): Disagreement[] {
  const run: Run = { case: job.case, variant: job.variant, results };
  return compareRun(run, job.marks);
}

/**
 * What a shrunk payload must keep: each field the languages disagree on among themselves, with
 * how they split on it, like `result: go | rust,ts`, so a step where another language goes
 * wrong instead doesn't count as the same failure.
 */
export function signature(rows: readonly Disagreement[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const groups = new Map<string, string[]>();
    for (const l of LANGUAGES) {
      const v = r.values[l];
      if (v !== undefined) groups.set(v, [...(groups.get(v) ?? []), l]);
    }
    if (groups.size < 2) continue;
    out.add(`${r.field}: ${[...groups.values()].map((ls) => ls.join(",")).sort().join(" | ")}`);
  }
  return [...out].sort();
}

/** How a candidate of the shrinker becomes the input of the failing variant. */
export interface Space {
  /** A JSON tree, or the text itself when the input isn't JSON. */
  readonly kind: "tree" | "text";
  readonly start: Json | string;
  /** The input bytes of a candidate. */
  readonly render: (candidate: Json | string) => string;
  /** True when the candidate is a payload of the type in normal JSON, which can become a case. */
  readonly normal: boolean;
}

/** The size the shrinker brings down: shorter text, then text that sorts first. */
function smaller(a: string, b: string): boolean {
  return a.length < b.length || (a.length === b.length && a < b);
}

/** Simpler spellings of a number: zero, one, its integer part, one digit fewer. */
function simplerNumbers(raw: string): string[] {
  const out = ["0", "1"];
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(raw);
  if (m !== null) {
    const [, sign, int = "", frac, exp] = m;
    if (frac !== undefined || exp !== undefined) out.push(`${sign ?? ""}${int}`);
    if (exp !== undefined) out.push(`${sign ?? ""}${int}${frac === undefined ? "" : `.${frac}`}`);
    if (frac !== undefined && frac.length > 1) out.push(`${sign ?? ""}${int}.${frac.slice(0, -1)}`);
    if (int.length > 1) out.push(`${sign ?? ""}${int.slice(0, -1)}`);
    if (sign === "-") out.push(raw.slice(1));
  }
  return [...new Set(out)].filter((n) => n !== raw);
}

/** Shorter strings: empty, either half, and, for short strings, each code point left out. */
function shorterStrings(text: string): string[] {
  const points = [...text];
  if (points.length === 0) return [];
  const half = Math.floor(points.length / 2);
  const out = ["", points.slice(0, half).join(""), points.slice(half).join("")];
  if (points.length <= 24) for (let i = 0; i < points.length; i++) out.push([...points.slice(0, i), ...points.slice(i + 1)].join(""));
  return [...new Set(out)].filter((s) => s !== text);
}

/** Every one-step simplification of a tree, outer values first: a key, an item, characters, a number. */
export function treeCandidates(value: Json): Json[] {
  const out: Json[] = [];
  const visit = (v: Json, replace: (next: Json | undefined) => Json): void => {
    if (v instanceof Map) {
      for (const k of v.keys()) {
        out.push(replace(new Map([...v].filter(([x]) => x !== k))));
      }
      for (const [k, child] of v) {
        visit(child, (next) => replace(new Map([...v].flatMap(([x, y]) => (x !== k ? [[x, y] as const] : next === undefined ? [] : [[x, next] as const])))));
        // A key can be shorter too.
        for (const shorter of shorterStrings(k)) {
          if (!v.has(shorter)) out.push(replace(new Map([...v].map(([x, y]) => [x === k ? shorter : x, y]))));
        }
      }
    } else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) out.push(replace(v.filter((_, j) => j !== i)));
      v.forEach((child, i) => visit(child, (next) => replace(v.flatMap((y, j) => (j !== i ? [y] : next === undefined ? [] : [next])))));
    } else if (typeof v === "string") {
      for (const s of shorterStrings(v)) out.push(replace(s));
    } else if (v instanceof JsonNumber) {
      for (const n of simplerNumbers(v.raw)) out.push(replace(new JsonNumber(n)));
    } else if (v === true) {
      out.push(replace(false));
    }
  };
  visit(value, (next) => next ?? null);
  return out;
}

/** Every one-step shortening of a text: either half, then each character left out. */
function textCandidates(text: string): string[] {
  const half = Math.floor(text.length / 2);
  const out = [text.slice(0, half), text.slice(half)];
  for (let i = 0; i < text.length && i < 512; i++) out.push(text.slice(0, i) + text.slice(i + 1));
  return out;
}

/** The result of shrinking: the input, the rows it gives and how many steps it took. */
export interface Shrunk {
  /** The input of the failing variant, like the LLM form of the payload. */
  readonly text: string;
  readonly normal: boolean;
  /** The payload in normal JSON, which the input is or is projected from, when it is one. */
  readonly payload?: string;
  readonly job: Job;
  readonly rows: readonly Disagreement[];
  readonly steps: number;
}

/** A case of the shrinker: no expectation in any mode, the marks its payload carries. */
function shrinkJob(job: Job, text: string): Job {
  const c: Case = { id: job.case.id, type: job.case.type, valid: false, bytes: bytes(text), strict: ACCEPTED, report: ACCEPTED, unlabelled: MODES };
  return { case: c, variant: job.variant, marks: fuzzMarks(c) };
}

/** Result `i` of every language. */
function resultsAt(all: Partial<Record<Language, readonly Result[]>>, i: number): Partial<Record<Language, Result>> {
  const out: Partial<Record<Language, Result>> = {};
  for (const l of LANGUAGES) {
    const r = all[l]?.[i];
    if (r !== undefined) out[l] = r;
  }
  return out;
}

/**
 * Shrinks the input of a failing job: the smallest input, by {@link smaller}, whose languages
 * still disagree on the same fields, with no expectation, found by trying every one-step
 * simplification of the current input in a fixed order, a batch at a time through the drivers,
 * and taking the first that keeps them. The same failure always shrinks the same way. Returns
 * undefined when the languages agree on the input without its expectation.
 */
export function shrink(drivers: readonly Driver[], job: Job, space: Space): Shrunk | undefined {
  let current = space.start;
  let text = space.render(current);
  let best = shrinkJob(job, text);
  let rows = jobRows(best, resultsAt(runJobs(drivers, [best]), 0));
  const key = signature(rows).join(",");
  if (key === "") return undefined;
  let steps = 0;
  for (; steps < SHRINK_STEPS; steps++) {
    const all: (Json | string)[] = space.kind === "text" ? textCandidates(current as string) : treeCandidates(current as Json);
    const seen = new Set<string>();
    const candidates: (readonly [Json | string, string])[] = [];
    for (const c of all) {
      const t = space.render(c);
      if (!smaller(t, text) || seen.has(t)) continue;
      seen.add(t);
      candidates.push([c, t]);
    }
    let found = false;
    for (let from = 0; from < candidates.length && !found; from += SHRINK_BATCH) {
      const slice = candidates.slice(from, from + SHRINK_BATCH);
      const jobs = slice.map(([, t]) => shrinkJob(job, t));
      const results = runJobs(drivers, jobs);
      for (let i = 0; i < jobs.length && !found; i++) {
        const candidateRows = jobRows(jobs[i] as Job, resultsAt(results, i));
        if (signature(candidateRows).join(",") !== key) continue;
        [current, text] = slice[i] as readonly [Json | string, string];
        best = jobs[i] as Job;
        rows = candidateRows;
        found = true;
      }
    }
    if (!found) break;
  }
  return { text, normal: space.normal, job: best, rows, steps, ...(space.normal ? { payload: writeJson(current as Json) } : {}) };
}

/** How the input of a job is shrunk: in normal JSON when it is a projection of a fuzz payload. */
function spaceOf(job: Job, sources: ReadonlyMap<string, Json>, packages: readonly Package[]): Space {
  const source = sources.get(job.case.id);
  if (source !== undefined && job.variant.decoder !== "cleanup") {
    if (job.variant.decoder === "normal") return { kind: "tree", start: source, render: (c) => writeJson(c as Json), normal: true };
    const pkg = packages.find((p) => p.name === packageName(job.variant));
    const shape = job.variant.shape;
    if (pkg !== undefined && shape !== undefined) {
      const walk = new ModelWalk(pkg.model);
      return { kind: "tree", start: source, render: (c) => writeJson(project(walk, job.case.type, c as Json, shape).payload), normal: true };
    }
  }
  const text = TEXT.decode(job.case.bytes);
  if (job.variant.decoder !== "cleanup") {
    try {
      return { kind: "tree", start: parseJson(text), render: (c) => writeJson(c as Json), normal: false };
    } catch (error) {
      if (!(error instanceof CanonicalError)) throw error;
    }
  }
  return { kind: "text", start: text, render: (c) => c as string, normal: false };
}

/** A text as one line of printable ASCII JSON: every other character as a \u escape. */
export function asciiJson(text: string): string {
  const json = JSON.stringify(text);
  let out = "";
  // By UTF-16 unit, so an astral character shows as its two escapes.
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i);
    out += code >= 0x20 && code < 0x7f ? json.charAt(i) : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

export interface FuzzOptions {
  /** The `conformance` folder. */
  readonly conformance: string;
  readonly seed: number;
  /** The first run, so one failing run of a long one can run alone. */
  readonly start?: number;
  readonly runs: number;
  readonly languages: readonly Language[];
  /** Write the shrunk case into `conformance/cases`, with the result of this language as its expectation. */
  readonly save?: Language;
  readonly log: (line: string) => void;
  /** Runs per batch. */
  readonly batch?: number;
  /**
   * Test only: changes the generated code under the scratch folder before the drivers build,
   * like an emitter with a bug would, so the fuzzer can be tested against one.
   */
  readonly patch?: (out: string) => void;
  /** Test only: builds the drivers instead of the real ones. */
  readonly drivers?: (out: string, packages: readonly Package[]) => Driver[];
}

export interface FuzzFailure {
  readonly run: number;
  readonly type: string;
  readonly variant: Variant;
  /** The case as it failed. */
  readonly case: Case;
  readonly change: string;
  readonly rows: readonly Disagreement[];
  readonly shrunk?: Shrunk;
  /** Where the case was saved, when it was. */
  readonly saved?: string;
}

export interface FuzzResult {
  readonly runs: number;
  readonly requests: number;
  readonly unfuzzable: readonly Unfuzzable[];
  readonly failure?: FuzzFailure;
}

/**
 * Runs `runs` fuzz runs from `start`, batch by batch, through the drivers of the languages
 * asked for, and stops at the first batch with a disagreement: its first failing job is shrunk
 * and returned, and saved when `save` names the language whose answer is right.
 */
export async function runFuzz(options: FuzzOptions): Promise<FuzzResult> {
  const { log } = options;
  const start = options.start ?? 0;
  const per = options.batch ?? BATCH;
  return withScratch(false, async (out) => {
    const model = conformanceModel(options.conformance, out);
    const { manifest } = loadSuite(options.conformance, model);
    for (const l of options.languages) if (l !== "ts" && options.drivers === undefined) log(`${l}: ${probeToolchain(l)}`);
    const packages = generateAll(options.conformance, out, new Set(manifest.llm.keys()));
    options.patch?.(out);
    const drivers =
      options.drivers?.(out, packages) ??
      options.languages.map((l) =>
        l === "rust" ? buildRust(options.conformance, out, packages) : l === "go" ? buildGo(options.conformance, out, packages) : typeScriptDriver(out, packages, BATCH_TIMEOUT),
      );
    if (drivers.length < 2) throw new DriverError("the fuzzer compares languages, so it needs two of them at least");
    const { types, unfuzzable } = fuzzTypes(model);
    if (types.length === 0) throw new LayoutError(["no type of conformance/schemas has payloads the generator can make"]);
    let requests = 0;
    for (let from = start; from < start + options.runs; from += per) {
      await Promise.resolve();
      const to = Math.min(start + options.runs, from + per);
      const runs: FuzzRun[] = [];
      for (let i = from; i < to; i++) runs.push(fuzzRun(model, types, options.seed, i));
      const { jobs } = fuzzJobs(runs, packages);
      requests += jobs.length;
      const results = runJobs(drivers, jobs);
      const failing = jobs.findIndex((job, i) => jobRows(job, Object.fromEntries(Object.entries(results).map(([l, rs]) => [l, rs[i]]))).length > 0);
      if (failing < 0) {
        log(`runs ${String(from)} to ${String(to - 1)}: ${String(jobs.length)} requests per language agree`);
        continue;
      }
      const job = jobs[failing] as Job;
      const rows = jobRows(job, Object.fromEntries(Object.entries(results).map(([l, rs]) => [l, rs[failing]])));
      const run = runs.find((r) => job.case.id.startsWith(`fuzz/${String(r.index)}/`)) ?? runs[0];
      if (run === undefined) throw new Error("no run for the failing job");
      const base = job.case.id.replace(/ \(llm: .*$/, "");
      const change = run.changes.get(base) ?? "";
      const failure: FuzzFailure = { run: run.index, type: run.type, variant: job.variant, case: job.case, change: job.case.id === base ? change : `${change}, then in the LLM form: ${job.case.id.slice(base.length + 2, -1)}`, rows };
      const sources = new Map<string, Json>();
      for (const c of run.cases) {
        const t = tree(c);
        if (t !== undefined) sources.set(c.id, t);
      }
      const shrunk = shrink(drivers, job, spaceOf(job, sources, packages));
      if (shrunk === undefined) return { runs: to - start, requests, unfuzzable, failure };
      const saved = options.save === undefined ? undefined : saveCase(options, drivers, packages, shrunk, log);
      return { runs: to - start, requests, unfuzzable, failure: { ...failure, shrunk, ...(saved === undefined ? {} : { saved }) } };
    }
    return { runs: options.runs, requests, unfuzzable };
  });
}

/** Why a shrunk case can't be saved, or undefined when it can. */
function unsavable(shrunk: Shrunk, trusted: Language, marks: readonly Mark[], strict: Result | undefined, report: Result | undefined): string | undefined {
  if (!shrunk.normal || shrunk.payload === undefined) return "the failing input is not a payload of the type in normal JSON (an LLM-only near miss or a cleanup input), which conformance/cases can't hold; add it to the vectors by hand";
  if (marks.length > 0) return `the payload needs the marks ${marks.map((m) => m.kind).join(", ")}, which a saved case must carry in marks.json only where needed; add it by hand`;
  if (strict === undefined || report === undefined) return `${trusted} did not run`;
  for (const r of [strict, report]) if (r.error?.code === "crash") return `${trusted} crashed, so its answer can't be the expectation`;
  if (strict.accepted && (!report.accepted || (report.unknown ?? []).length > 0)) return `${trusted} accepts it in strict mode but not the same way in report mode`;
  return undefined;
}

/** One language's answer for a case, in one line. */
function answer(r: Result | undefined): string {
  if (r === undefined) return "no result";
  if (r.accepted) return `accepted, unknown ${JSON.stringify(r.unknown ?? [])}`;
  return `rejected ${r.error?.code ?? ""} at ${r.error?.path === "" ? "the root" : (r.error?.path ?? "")}`;
}

/** The expect file of an invalid case, from the trusted language's results. */
function expectFile(strict: Result, report: Result): string {
  const e = strict.error;
  if (e === null) throw new Error("no error");
  const r = report.error;
  const value: Record<string, unknown> = { path: e.path, code: e.code };
  if (report.accepted) value.report = { unknown: report.unknown ?? [] };
  else if (r !== null && (r.path !== e.path || r.code !== e.code)) value.report = { path: r.path, code: r.code };
  return `${JSON.stringify(value)}\n`;
}

/** Bumps one type's count in manifest.json's text, keeping its layout, or undefined when it has no line to bump. */
export function bumpManifest(text: string, type: string, kind: "valid" | "invalid"): string | undefined {
  const line = new RegExp(`^(\\s*"${type}": \\{"valid": )(\\d+)(, "invalid": )(\\d+)(\\})`, "m");
  const m = line.exec(text);
  if (m === null) return undefined;
  const valid = Number(m[2]) + (kind === "valid" ? 1 : 0);
  const invalid = Number(m[4]) + (kind === "invalid" ? 1 : 0);
  return text.replace(line, `$1${String(valid)}$3${String(invalid)}$5`);
}

/**
 * Writes a shrunk case into `conformance/cases/<Type>/{valid,invalid}/fuzz-<hash>.json`, with the
 * expect file of an invalid one and the manifest count, the expectation taken from the language
 * `options.save` names: the one the spec says is right, which the caller decides. When that
 * answer can't be the expectation, it prints why and writes nothing.
 */
function saveCase(options: FuzzOptions, drivers: readonly Driver[], packages: readonly Package[], shrunk: Shrunk, log: (line: string) => void): string | undefined {
  const trusted = options.save;
  if (trusted === undefined) return undefined;
  const type = shrunk.job.case.type;
  const payload = shrunk.payload ?? shrunk.text;
  const c: Case = { id: shrunk.job.case.id, type, valid: true, bytes: bytes(payload), strict: ACCEPTED, report: ACCEPTED };
  const marks = fuzzMarks(c);
  const jobs: Job[] = (["strict", "report"] as const).map((mode) => ({ case: c, variant: { mode, decoder: "normal", entry: "public" }, marks: [] }));
  // Every language's answer, so the saved one can be read beside the others.
  const answers = new Map(drivers.map((d) => [d.language, d.run(jobRequests(jobs))] as const));
  const [strict, report] = answers.get(trusted) ?? [];
  for (const l of LANGUAGES) {
    const a = answers.get(l);
    if (a !== undefined) log(`  ${l}${l === trusted ? " (saved)" : ""}: strict ${answer(a[0])}, report ${answer(a[1])}`);
  }
  const why = unsavable(shrunk, trusted, marks, strict, report);
  const fail = (reason: string): undefined => {
    log(`not saved: ${reason}`);
    return undefined;
  };
  if (why !== undefined || strict === undefined || report === undefined) return fail(why ?? `${trusted} did not run`);
  const kind = strict.accepted ? "valid" : "invalid";
  const name = `fuzz-${createHash("sha256").update(payload).digest("hex").slice(0, 12)}`;
  const dir = join(options.conformance, "cases", type, kind);
  const file = join(dir, `${name}.json`);
  if (existsSync(file)) return fail(`${type}/${kind}/${name}.json is there already`);
  const manifestFile = join(options.conformance, "manifest.json");
  const manifest = bumpManifest(readFileSync(manifestFile, "utf8"), type, kind);
  if (manifest === undefined) return fail(`${type} has no line of counts in manifest.json to update`);
  if (!packages.some((p) => p.types.has(type))) return fail(`${type} is not a case type`);
  const expect = kind === "invalid" ? expectFile(strict, report) : undefined;
  // Everything that can fail has: write.
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${payload}\n`);
  if (expect !== undefined) writeFileSync(join(dir, `${name}${EXPECT}`), expect);
  writeFileSync(manifestFile, manifest);
  log(`saved ${type}/${kind}/${name}.json with ${trusted}'s answer${expect === undefined ? "" : `: ${expect.trim()}`}`);
  return `${type}/${kind}/${name}.json`;
}

/** The lines that describe a failure: the seed, the run, the payload before and after shrinking, and the table. */
export function failureLines(seed: number, failure: FuzzFailure, languages: readonly Language[]): string[] {
  const text = TEXT.decode(failure.case.bytes);
  const out = [
    `fuzz: disagreement in run ${String(failure.run)} of seed ${String(seed)}: ${failure.type}, ${variantName(failure.variant)}`,
    `  made: ${failure.change}`,
    `  payload (json): ${asciiJson(text)}`,
    `  payload (hex):  ${Buffer.from(failure.case.bytes).toString("hex")}`,
    "",
    ...table(failure.rows, languages),
  ];
  const s = failure.shrunk;
  if (s === undefined) {
    out.push("", "every language agrees with the others but not with the generator's label, so there is nothing to shrink: check the label against docs/error-codes.md");
  } else {
    out.push(
      "",
      `shrunk in ${String(s.steps)} steps, ${s.payload === undefined ? "as the input of this variant" : "as a payload in normal JSON"}:`,
      ...(s.payload !== undefined && s.payload !== s.text ? [`  payload (json): ${asciiJson(s.payload)}`, `  as read here:   ${asciiJson(s.text)}`] : [`  payload (json): ${asciiJson(s.text)}`]),
      `  input (hex):    ${Buffer.from(s.text).toString("hex")}`,
      "",
      ...table(s.rows, languages),
    );
  }
  out.push("", `run it alone: pnpm fuzz --seed ${String(seed)} --start ${String(failure.run)} --runs 1`);
  return out;
}

/** The languages of a run, for the table. */
export function ranLanguages(languages: readonly Language[]): Language[] {
  return LANGUAGES.filter((l) => languages.includes(l));
}
