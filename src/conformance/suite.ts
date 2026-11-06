/**
 * One conformance run: every case, in every read mode and through every decoder, through every
 * driver, compared. `main.ts` is its command line; the unit tests run it with TypeScript alone.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Case, Mark } from "./cases.js";
import { loadCases, loadMarks } from "./cases.js";
import type { Disagreement } from "./compare.js";
import { compareRun } from "./compare.js";
import type { Driver } from "./drivers.js";
import { buildGo, buildRust, caseTypes, conformanceModel, generateAll, probeToolchain, typeScriptDriver } from "./drivers.js";
import type { Decoder, Language, Mode, Request, Result } from "./protocol.js";
import { DECODERS, LANGUAGES } from "./protocol.js";

/** One read mode through one decoder. */
export interface Variant {
  readonly mode: Mode;
  readonly decoder: Decoder;
}

/** Every pair of the given modes and the decoders that run. */
export function variants(modes: readonly Mode[], decoders: readonly Decoder[] = DECODERS): Variant[] {
  return modes.flatMap((mode) => decoders.map((decoder) => ({ mode, decoder })));
}

/** One request per case and variant, numbered in order. */
export function requestsFor(cases: readonly Case[], list: readonly Variant[]): Request[] {
  return list.flatMap((v, i) =>
    cases.map((c, j) => ({
      id: i * cases.length + j,
      type: c.type,
      mode: v.mode,
      decoder: v.decoder,
      hex: Buffer.from(c.bytes).toString("hex"),
    })),
  );
}

/** Every disagreement, given each language's results for {@link requestsFor}'s requests. */
export function compareAll(
  cases: readonly Case[],
  list: readonly Variant[],
  results: Readonly<Partial<Record<Language, readonly Result[]>>>,
  marks: readonly Mark[],
): Disagreement[] {
  const ran = LANGUAGES.filter((l) => results[l] !== undefined);
  const rows: Disagreement[] = [];
  list.forEach((v, i) => {
    cases.forEach((c, j) => {
      const id = i * cases.length + j;
      const own = Object.fromEntries(ran.map((l) => [l, results[l]?.[id]]));
      rows.push(
        ...compareRun({ case: c, mode: v.mode, decoder: v.decoder, results: own }, marks, {
          allLanguages: ran.length === LANGUAGES.length,
        }),
      );
    });
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

/** Removes a folder only when it is one this run made with mkdtemp in the system temp folder. */
export function removeScratch(dir: string): void {
  const real = realpathSync(dir);
  if (dirname(real) !== realpathSync(tmpdir()) || !basename(real).startsWith("strictgen-conformance-")) {
    throw new Error(`refusing to remove ${dir}: not a conformance scratch folder`);
  }
  rmSync(real, { recursive: true, force: true });
}

/**
 * Generates every language, builds the drivers of the languages asked for, runs every case
 * through them and compares. Throws a LayoutError, ToolchainError or DriverError when the run
 * can't happen at all.
 */
export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const log = options.log ?? (() => undefined);
  const out = mkdtempSync(join(tmpdir(), "strictgen-conformance-"));
  try {
    const model = conformanceModel(options.conformance, out);
    const types = caseTypes(model);
    const cases = loadCases(join(options.conformance, "cases"), new Set(types.keys()));
    const marks = loadMarks(join(options.conformance, "marks.json"), cases);
    for (const l of options.languages) if (l !== "ts") log(`${l}: ${probeToolchain(l)}`);
    generateAll(options.conformance, out);
    const names = [...types.keys()].sort();
    const drivers: Driver[] = [];
    for (const l of options.languages) {
      if (l === "rust") drivers.push(buildRust(options.conformance, out, names));
      if (l === "go") drivers.push(buildGo(options.conformance, out, types));
      if (l === "ts") drivers.push(await typeScriptDriver(out));
    }
    const list = variants(options.modes);
    const requests = requestsFor(cases, list);
    const results = Object.fromEntries(drivers.map((d) => [d.language, d.run(requests)]));
    const rows = compareAll(cases, list, results, marks);
    return { cases, marks, variants: list, rows, ...(options.keep === true ? { kept: out } : {}) };
  } finally {
    if (options.keep !== true) removeScratch(out);
  }
}
