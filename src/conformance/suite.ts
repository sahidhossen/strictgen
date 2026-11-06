/**
 * One conformance run: every case, in every read mode, through every decoder and entry point,
 * through every driver, compared. `main.ts` is its command line; the unit tests run it with
 * TypeScript alone.
 *
 * A run is a list of jobs, each a case read in one variant. The normal decoders read every case
 * in both read modes, through the public entry points and the fixture registry, in code
 * generated without `llm`, and through the public entry points in code generated with it. The
 * LLM decoders read every case in the LLM form (`llm-cases.ts`) of each map shape, in both read
 * modes, from code that reads both shapes and from code that reads one. The shared vectors of
 * `examples/llm` run in report mode (`vectors.ts`).
 */

import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { llmTypes } from "../llm-decoders.js";
import { builtinProfile } from "../llm-profile.js";
import { projectType } from "../llm-project.js";
import type { Model } from "../model.js";
import type { Case, Manifest, Mark } from "./cases.js";
import { checkManifest, LayoutError, loadCases, loadManifest, loadMarks } from "./cases.js";
import type { Disagreement } from "./compare.js";
import { compareRun, usedMarks } from "./compare.js";
import type { Coverage } from "./coverage.js";
import { coverage, coverageGaps } from "./coverage.js";
import type { Driver, Package } from "./drivers.js";
import {
  buildGo,
  buildRust,
  caseTypes,
  conformanceModel,
  generateAll,
  MAPS_PROFILES,
  probeToolchain,
  typeScriptDriver,
  vectorsFolder,
} from "./drivers.js";
import type { Skipped } from "./llm-cases.js";
import { llmCases } from "./llm-cases.js";
import type { Decoder, Entry, Language, Mode, Request, Result, Shape, Variant } from "./protocol.js";
import { ENTRIES, LANGUAGES, MODES, packageName } from "./protocol.js";
import { loadCleanupVectors, loadLlmVectors } from "./vectors.js";

/** Every combination of the given modes, decoders and entry points, for code generated without `llm`. */
export function variants(
  modes: readonly Mode[],
  decoders: readonly Decoder[] = ["normal"],
  entries: readonly Entry[] = ENTRIES,
): Variant[] {
  return modes.flatMap((mode) => decoders.flatMap((decoder) => entries.map((entry) => ({ mode, decoder, entry }))));
}

/** One case read in one variant, with the marks that apply. */
export interface Job {
  readonly case: Case;
  readonly variant: Variant;
  /** The case's marks, with paths moved into the payload for an LLM form. */
  readonly marks: readonly Mark[];
  /** The marks of `marks` that were moved, by the mark of the case they stand for. */
  readonly origin?: ReadonlyMap<Mark, Mark>;
}

/** Every case in every variant, variant by variant, with each case's own marks. */
export function gridJobs(cases: readonly Case[], list: readonly Variant[], marks: readonly Mark[] = []): Job[] {
  return list.flatMap((variant) => cases.map((c) => ({ case: c, variant, marks: marks.filter((m) => m.case === c.id) })));
}

/** One request per job, numbered in order. */
export function jobRequests(jobs: readonly Job[]): Request[] {
  return jobs.map((j, id) => {
    const { mode, decoder, entry } = j.variant;
    return { id, type: j.case.type, mode, decoder, entry, package: packageName(j.variant), hex: Buffer.from(j.case.bytes).toString("hex") };
  });
}

/** One request per case and variant, numbered in order. */
export function requestsFor(cases: readonly Case[], list: readonly Variant[]): Request[] {
  return jobRequests(gridJobs(cases, list));
}

export interface CompareAllOptions {
  /**
   * True when every language and every variant ran, so a mark no run needed is known to be
   * unneeded, and fails.
   */
  readonly complete: boolean;
}

/** Every disagreement, given each language's results for {@link jobRequests}'s requests. */
export function compareJobs(
  jobs: readonly Job[],
  results: Readonly<Partial<Record<Language, readonly Result[]>>>,
  marks: readonly Mark[],
  options: CompareAllOptions,
): Disagreement[] {
  const ran = LANGUAGES.filter((l) => results[l] !== undefined);
  const rows: Disagreement[] = [];
  const used = new Set<Mark>();
  jobs.forEach((job, id) => {
    const run = { case: job.case, variant: job.variant, results: Object.fromEntries(ran.map((l) => [l, results[l]?.[id]])) };
    rows.push(...compareRun(run, job.marks));
    if (options.complete) for (const m of usedMarks(run, job.marks)) used.add(job.origin?.get(m) ?? m);
  });
  if (!options.complete) return rows;
  for (const m of marks) {
    if (!used.has(m)) {
      rows.push({
        case: m.case,
        variant: null,
        field: `mark ${m.kind}`,
        values: { expected: "no run needs this mark: the languages agree without it, so remove it" },
      });
    }
  }
  return rows;
}

/** Every disagreement, given each language's results for {@link requestsFor}'s requests. */
export function compareAll(
  cases: readonly Case[],
  list: readonly Variant[],
  results: Readonly<Partial<Record<Language, readonly Result[]>>>,
  marks: readonly Mark[],
  options: CompareAllOptions,
): Disagreement[] {
  const ids = new Set(cases.map((c) => c.id));
  return compareJobs(gridJobs(cases, list, marks), results, marks.filter((m) => ids.has(m.case)), options);
}

/** The schema files of the conformance folder whose types the LLM packages can't take, with why. */
export function llmExclusions(conformance: string, model: Model): Map<string, string> {
  const failing = new Map<string, string>();
  const files = readdirSync(join(conformance, "schemas")).filter((n) => n.endsWith(".json")).sort();
  for (const file of files) {
    const schema = file.slice(0, -".json".length);
    for (const decl of llmTypes(model).filter((d) => d.schema === schema)) {
      for (const name of MAPS_PROFILES.both) {
        if (failing.has(file)) break;
        try {
          projectType(model, decl.name, builtinProfile(name));
        } catch (error) {
          failing.set(file, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }
  return failing;
}

/** Checks the manifest's `llm` list against the schema files that can't be projected: both ways. */
export function checkLlmExclusions(conformance: string, model: Model, manifest: Manifest): void {
  const failing = llmExclusions(conformance, model);
  const problems: string[] = [];
  for (const [file, why] of failing) {
    if (!manifest.llm.has(file)) problems.push(`${file}: no LLM decoder can be generated (${why}), so list it under "llm" in manifest.json with the reason`);
  }
  for (const file of manifest.llm.keys()) {
    if (!failing.has(file)) problems.push(`manifest.json: llm ${file} ${readdirSync(join(conformance, "schemas")).includes(file) ? "projects under every profile now, so remove it" : "is not a schema file"}`);
  }
  if (problems.length > 0) throw new LayoutError(problems);
}

/** The shapes an LLM payload gives its maps in, in the order variants run. */
const SHAPES: readonly Shape[] = ["entries", "objects"];

export interface JobOptions {
  readonly cases: readonly Case[];
  readonly marks: readonly Mark[];
  readonly packages: readonly Package[];
  readonly modes: readonly Mode[];
  /** The `examples/llm` folder, for its shared vectors. */
  readonly vectors: string;
  /** Collects why a case doesn't run through the LLM decoders. */
  readonly skipped?: Skipped;
}

/**
 * The marks a shared vector carries, worked out from its text since the vectors are generated:
 * Go's encoder escapes `<`, `>` and `&`, and U+2028 and U+2029, where Rust and TypeScript write
 * them. An invalid vector, or one without such a character, carries none, and each one must
 * still be needed.
 */
export function vectorMarks(c: Case): Mark[] {
  // Only a value that decodes is written again.
  if (!c.valid) return [];
  const text = new TextDecoder().decode(c.encodes ?? c.bytes);
  const out: Mark[] = [];
  if (/[<>&]/.test(text)) {
    out.push({ case: c.id, kind: "html-escaping", reason: "Go's json.Marshal escapes <, > and &, which Rust and TypeScript write as they are." });
  }
  if (/[\u2028\u2029]/.test(text)) {
    out.push({ case: c.id, kind: "line-separator-escaping", reason: "Go's encoder escapes U+2028 and U+2029, which Rust and TypeScript write as they are." });
  }
  return out;
}

/** Every job of a run, in a fixed order. */
export function suiteJobs(options: JobOptions): Job[] {
  const { cases, marks, packages, modes } = options;
  const own = (c: Case): Mark[] => marks.filter((m) => m.case === c.id);
  const pkg = (v: Variant): Package => {
    const found = packages.find((p) => p.name === packageName(v));
    if (found === undefined) throw new Error(`no package ${packageName(v)}`);
    return found;
  };
  const jobs: Job[] = [];
  const add = (variant: Variant, list: readonly Case[], marksOf: (c: Case) => Mark[] = own): void => {
    for (const c of list) jobs.push({ case: c, variant, marks: marksOf(c) });
  };
  for (const mode of modes) for (const entry of ENTRIES) add({ mode, decoder: "normal", entry }, cases);
  for (const mode of modes) {
    const variant: Variant = { mode, decoder: "normal", entry: "public", maps: "both" };
    const types = pkg(variant).types;
    add(variant, cases.filter((c) => types.has(c.type)));
  }
  const llm = (variant: Variant & { shape: Shape }, otherShape: boolean): void => {
    const p = pkg(variant);
    const readsEntries = variant.maps !== "objects";
    for (const j of llmCases(p.model, cases, marks, new Set(p.types.keys()), { shape: variant.shape, readsEntries, otherShape }, options.skipped)) {
      jobs.push({ case: j.case, variant, marks: j.marks, origin: j.origin });
    }
  };
  for (const mode of modes) for (const shape of SHAPES) llm({ mode, decoder: "llm", entry: "public", maps: "both", shape }, false);
  if (modes.includes("strict")) {
    llm({ mode: "strict", decoder: "llm", entry: "public", maps: "entries", shape: "entries" }, true);
    llm({ mode: "strict", decoder: "llm", entry: "public", maps: "objects", shape: "objects" }, true);
  }
  if (modes.includes("report")) {
    const vectors = loadLlmVectors(options.vectors);
    add({ mode: "report", decoder: "llm", entry: "public", vectors: true }, vectors.llm, vectorMarks);
    add({ mode: "report", decoder: "normal", entry: "public", vectors: true }, vectors.normal, vectorMarks);
    add({ mode: "report", decoder: "cleanup", entry: "public", vectors: true }, loadCleanupVectors(options.vectors));
  }
  return jobs;
}

/** Reads the cases, marks and manifest, and checks the manifest, the LLM list and the coverage. */
export function loadSuite(conformance: string, model: Model): { cases: Case[]; marks: Mark[]; manifest: Manifest; coverage: Coverage } {
  const names = new Set(caseTypes(model).keys());
  const cases = loadCases(join(conformance, "cases"), names);
  const manifest = loadManifest(join(conformance, "manifest.json"));
  checkManifest(manifest, cases, names);
  const marks = loadMarks(join(conformance, "marks.json"), cases);
  const report = coverage(model, cases);
  const gaps = coverageGaps(report, manifest.coverage);
  if (gaps.length > 0) throw new LayoutError(gaps);
  checkLlmExclusions(conformance, model, manifest);
  return { cases, marks, manifest, coverage: report };
}

export interface SuiteOptions {
  /** The `conformance` folder. */
  readonly conformance: string;
  readonly modes: readonly Mode[];
  readonly languages: readonly Language[];
  /** Keeps the temporary folder, for a look at the generated code. */
  readonly keep?: boolean;
  /** Progress lines, like the toolchain versions. */
  readonly log?: (line: string) => void;
}

export interface SuiteResult {
  readonly cases: readonly Case[];
  readonly marks: readonly Mark[];
  readonly jobs: readonly Job[];
  /** The variants that ran, in order. */
  readonly variants: readonly Variant[];
  readonly rows: readonly Disagreement[];
  /** Why cases don't run through the LLM decoders, by case id. */
  readonly skipped: ReadonlyMap<string, string>;
  readonly coverage: Coverage;
  /** The temporary folder, when it was kept. */
  readonly kept?: string;
}

const SCRATCH_PREFIX = "strictgen-conformance-";

/** Removes a folder only when it is one this run made with mkdtemp in the system temp folder. */
export function removeScratch(dir: string): void {
  const real = realpathSync(dir);
  if (dirname(real) !== realpathSync(tmpdir()) || !basename(real).startsWith(SCRATCH_PREFIX)) {
    throw new Error(`refusing to remove ${dir}: not a conformance scratch folder`);
  }
  rmSync(real, { recursive: true, force: true });
}

/**
 * Lets Node run a signal handler. The builds and drivers run synchronously, so a signal that
 * arrives meanwhile is handled only once the run gives the event loop a turn.
 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The exit codes a shell gives a process stopped by these signals. */
const SIGNALS = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Runs `body` with a new scratch folder in the system temp folder, and removes the folder
 * afterwards unless `keep` is set: when `body` returns, when it throws, and on Ctrl-C or a kill,
 * which then exit as the signal would. An error removing the folder never hides the error that
 * stopped `body`.
 */
export async function withScratch<T>(keep: boolean, body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const onSignal = (signal: keyof typeof SIGNALS): void => {
    if (!keep) {
      try {
        removeScratch(dir);
      } catch {
        // Exiting anyway: the signal wins over a folder left behind.
      }
    }
    process.exit(SIGNALS[signal]);
  };
  // One handler per signal, since a listener is not always told which signal it got.
  const handlers = (Object.keys(SIGNALS) as (keyof typeof SIGNALS)[]).map(
    (signal) => [signal, (): void => onSignal(signal)] as const,
  );
  for (const [signal, handler] of handlers) process.once(signal, handler);
  let failed = false;
  try {
    return await body(dir);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // A signal that came during the last step is handled here, before the handlers go.
    await tick();
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (!keep) {
      try {
        removeScratch(dir);
      } catch (error) {
        if (!failed) throw error;
      }
    }
  }
}


/**
 * Generates every language, builds the drivers of the languages asked for, runs every case
 * through them and compares. Throws a LayoutError, ToolchainError or DriverError when the run
 * can't happen at all.
 */
export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const log = options.log ?? (() => undefined);
  const keep = options.keep === true;
  return withScratch(keep, async (out) => {
    const model = conformanceModel(options.conformance, out);
    const { cases, marks, manifest, coverage: report } = loadSuite(options.conformance, model);
    for (const l of options.languages) if (l !== "ts") log(`${l}: ${probeToolchain(l)}`);
    const packages = generateAll(options.conformance, out, new Set(manifest.llm.keys()));
    const skipped: Skipped = new Map();
    const jobs = suiteJobs({ cases, marks, packages, modes: options.modes, vectors: vectorsFolder(options.conformance), skipped });
    const drivers: Driver[] = [];
    for (const l of options.languages) {
      await tick();
      if (l === "rust") drivers.push(buildRust(options.conformance, out, packages));
      if (l === "go") drivers.push(buildGo(options.conformance, out, packages));
      if (l === "ts") drivers.push(await typeScriptDriver(out, packages));
    }
    const requests = jobRequests(jobs);
    const results: Partial<Record<Language, Result[]>> = {};
    for (const d of drivers) {
      await tick();
      results[d.language] = d.run(requests);
    }
    const complete = options.languages.length === LANGUAGES.length && options.modes.length === MODES.length;
    // The marks worked out for the shared vectors must be needed too.
    const derived = jobs.flatMap((j) => (j.variant.vectors === true ? j.marks : []));
    const rows = compareJobs(jobs, results, [...marks, ...derived], { complete });
    const seen = new Set<string>();
    const list = jobs.flatMap((j) => {
      const key = JSON.stringify(j.variant);
      if (seen.has(key)) return [];
      seen.add(key);
      return [j.variant];
    });
    return { cases, marks, jobs, variants: list, rows, skipped, coverage: report, ...(keep ? { kept: out } : {}) };
  });
}
