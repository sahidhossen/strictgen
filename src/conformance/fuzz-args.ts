/** The command line of `pnpm fuzz`. */

import type { Language } from "./protocol.js";
import { LANGUAGES } from "./protocol.js";

export const FUZZ_USAGE = `usage: pnpm fuzz [--seed n] [--start n] [--runs n] [--lang rust,go,ts] [--save <language>]

  --seed   the seed, an integer from 0 to 4294967295; random, and printed, by default
  --start  the first run, 0 by default, to run one failing run of a long run alone
  --runs   how many runs, 1000 by default; each is one valid payload of a random type, a few of
           its near misses and a cleanup input, through every decoder
  --lang   the languages, all three by default; two at least, since they are compared
  --save   write the shrunk failing case into conformance/cases, with the answer of this
           language as its expectation: the language the spec says is right`;

export interface FuzzArguments {
  readonly seed: number | undefined;
  readonly start: number;
  readonly runs: number;
  readonly languages: readonly Language[];
  readonly save: Language | undefined;
}

function integer(name: string, value: string, max: number): number | string {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || Number(value) > max) return `${name} takes an integer from 0 to ${String(max)}, not ${value}`;
  return Number(value);
}

/** The parsed arguments, or a usage error. */
export function parseFuzzArguments(args: readonly string[]): FuzzArguments | string {
  let seed: number | undefined;
  let start = 0;
  let runs = 1000;
  let languages: readonly Language[] = LANGUAGES;
  let save: Language | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!["--seed", "--start", "--runs", "--lang", "--save"].includes(name)) return `unknown argument ${arg}`;
    if (seen.has(name)) return `${name} is given twice`;
    seen.add(name);
    const value = inline ?? args[++i];
    if (value === undefined || value === "" || value.startsWith("--")) return `${name} needs a value`;
    if (name === "--lang" || name === "--save") {
      const list = value.split(",");
      const bad = list.find((l) => !(LANGUAGES as readonly string[]).includes(l));
      if (bad !== undefined) return `${name} takes ${LANGUAGES.join(", ")}, not ${bad}`;
      if (name === "--save") {
        if (list.length !== 1) return "--save takes one language";
        save = list[0] as Language;
      } else {
        languages = LANGUAGES.filter((l) => list.includes(l));
        if (languages.length < 2) return "--lang needs two languages at least, since the fuzzer compares them";
      }
      continue;
    }
    const n = integer(name, value, name === "--seed" ? 0xffffffff : Number.MAX_SAFE_INTEGER);
    if (typeof n === "string") return n;
    if (name === "--seed") seed = n;
    else if (name === "--start") start = n;
    else if (n === 0) return "--runs takes 1 at least";
    else runs = n;
  }
  if (save !== undefined && !languages.includes(save)) return `--save ${save} needs ${save} in --lang`;
  return { seed, start, runs, languages, save };
}
