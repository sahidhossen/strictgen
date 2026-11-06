/** The command line of `pnpm conformance`. */

import type { Language, Mode } from "./protocol.js";
import { LANGUAGES, MODES } from "./protocol.js";

export const USAGE = `usage: pnpm conformance [--mode strict|report|both] [--lang rust,go,ts] [--keep] [--coverage]

  --mode      the read modes to run, both by default
  --lang      the languages to run, all three by default. Leaving one out is the only way to run
              without its toolchain: a missing toolchain is an error
  --keep      keep the temporary folder with the generated code and drivers, and print its path
  --coverage  print how many cases cover each mapping rule and error code, and run nothing`;

export interface Arguments {
  readonly modes: readonly Mode[];
  readonly languages: readonly Language[];
  readonly keep: boolean;
  readonly coverage: boolean;
}

/** The parsed arguments, or a usage error. */
export function parseArguments(args: readonly string[]): Arguments | string {
  let modes: readonly Mode[] = MODES;
  let languages: readonly Language[] = LANGUAGES;
  let keep = false;
  let coverage = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (seen.has(name)) return `${name} is given twice`;
    seen.add(name);
    if (name === "--keep" && inline === undefined) {
      keep = true;
      continue;
    }
    if (name === "--coverage" && inline === undefined) {
      coverage = true;
      continue;
    }
    if (name !== "--mode" && name !== "--lang") return `unknown argument ${arg}`;
    const value = inline ?? args[++i];
    if (value === undefined || value === "") return `${name} needs a value`;
    if (name === "--mode") {
      if (value !== "both" && !(MODES as readonly string[]).includes(value)) return `--mode is strict, report or both, not ${value}`;
      modes = value === "both" ? MODES : [value as Mode];
      continue;
    }
    const list = value.split(",");
    const bad = list.find((l) => !(LANGUAGES as readonly string[]).includes(l));
    if (bad !== undefined) return `--lang takes ${LANGUAGES.join(", ")}, not ${bad}`;
    languages = LANGUAGES.filter((l) => list.includes(l));
  }
  return { modes, languages, keep, coverage };
}
