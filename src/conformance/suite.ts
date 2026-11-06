/**
 * One conformance run: every case, in every read mode, through every decoder and entry point,
 * through every driver, compared. `main.ts` is its command line; the unit tests run it with
 * TypeScript alone.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Case, Mark } from "./cases.js";
import { checkManifest, loadCases, loadManifest, loadMarks } from "./cases.js";
import type { Disagreement } from "./compare.js";
import { compareRun, usedMarks } from "./compare.js";
import type { Driver } from "./drivers.js";
import { buildGo, buildRust, caseTypes, conformanceModel, generateAll, probeToolchain, typeScriptDriver } from "./drivers.js";
import type { Decoder, Entry, Language, Mode, Request, Result, Variant } from "./protocol.js";
import { DECODERS, ENTRIES, LANGUAGES, MODES } from "./protocol.js";

/** Every combination of the given modes, the decoders and the entry points that run. */
export function variants(
  modes: readonly Mode[],
  decoders: readonly Decoder[] = DECODERS,
  entries: readonly Entry[] = ENTRIES,
): Variant[] {
  return modes.flatMap((mode) => decoders.flatMap((decoder) => entries.map((entry) => ({ mode, decoder, entry }))));
}

/** One request per case and variant, numbered in order. */
export function requestsFor(cases: readonly Case[], list: readonly Variant[]): Request[] {
  return list.flatMap((v, i) =>
    cases.map((c, j) => ({
      id: i * cases.length + j,
      type: c.type,
      ...v,
      hex: Buffer.from(c.bytes).toString("hex"),
    })),
  );
}

export interface CompareAllOptions {
  /**
   * True when every language and every variant ran, so a mark no run needed is known to be
   * unneeded, and fails.
   */
  readonly complete: boolean;
}

/** Every disagreement, given each language's results for {@link requestsFor}'s requests. */
export function compareAll(
  cases: readonly Case[],
  list: readonly Variant[],
  results: Readonly<Partial<Record<Language, readonly Result[]>>>,
  marks: readonly Mark[],
  options: CompareAllOptions,
): Disagreement[] {
  const ran = LANGUAGES.filter((l) => results[l] !== undefined);
  const rows: Disagreement[] = [];
  cases.forEach((c, j) => {
    const own = marks.filter((m) => m.case === c.id);
    const used = new Set<Mark>();
    list.forEach((variant, i) => {
      const id = i * cases.length + j;
      const run = { case: c, variant, results: Object.fromEntries(ran.map((l) => [l, results[l]?.[id]])) };
      rows.push(...compareRun(run, own));
      if (options.complete) for (const m of usedMarks(run, own)) used.add(m);
    });
    if (!options.complete) return;
    for (const m of own) {
      if (!used.has(m)) {
        rows.push({
          case: c.id,
          variant: null,
          field: `mark ${m.kind}`,
          values: { expected: "no run needs this mark: the languages agree without it, so remove it" },
        });
      }
    }
  });
  return rows;
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
  readonly variants: readonly Variant[];
  readonly rows: readonly Disagreement[];
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
    const types = caseTypes(model);
    const names = new Set(types.keys());
    const cases = loadCases(join(options.conformance, "cases"), names);
    checkManifest(loadManifest(join(options.conformance, "manifest.json")), cases, names);
    const marks = loadMarks(join(options.conformance, "marks.json"), cases);
    for (const l of options.languages) if (l !== "ts") log(`${l}: ${probeToolchain(l)}`);
    generateAll(options.conformance, out);
    const drivers: Driver[] = [];
    for (const l of options.languages) {
      await tick();
      if (l === "rust") drivers.push(buildRust(options.conformance, out, [...names].sort()));
      if (l === "go") drivers.push(buildGo(options.conformance, out, types));
      if (l === "ts") drivers.push(await typeScriptDriver(out));
    }
    const list = variants(options.modes);
    const requests = requestsFor(cases, list);
    const results: Partial<Record<Language, Result[]>> = {};
    for (const d of drivers) {
      await tick();
      results[d.language] = d.run(requests);
    }
    const complete = options.languages.length === LANGUAGES.length && options.modes.length === MODES.length;
    const rows = compareAll(cases, list, results, marks, { complete });
    return { cases, marks, variants: list, rows, ...(keep ? { kept: out } : {}) };
  });
}
