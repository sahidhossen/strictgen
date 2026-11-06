/**
 * Compares what every language did with one case against the others and against the case's
 * expectation, and checks that each marked difference still differs in exactly the stated way.
 * Any difference becomes a row of the disagreement table; there is no skip.
 */

import { CanonicalError, canonicalize, parseJson, serialize, withoutMembers } from "./canonical.js";
import type { Case, Mark, Outcome } from "./cases.js";
import { expected } from "./cases.js";
import type { Decoder, ErrorFields, Language, Mode, Result } from "./protocol.js";
import { CRASH, LANGUAGES } from "./protocol.js";

/** What every language that ran did with one case, in one mode and through one decoder. */
export interface Run {
  readonly case: Case;
  readonly mode: Mode;
  readonly decoder: Decoder;
  readonly results: Readonly<Partial<Record<Language, Result>>>;
}

/** A column of the table: a language, or what the case expects. */
export type Column = Language | "expected";

/** One row of the table: a field the languages, or a language and the expectation, disagree on. */
export interface Disagreement {
  readonly case: string;
  readonly mode: Mode;
  readonly decoder: Decoder;
  readonly field: string;
  readonly values: Readonly<Partial<Record<Column, string>>>;
}

export interface CompareOptions {
  /**
   * True when every language ran. The spelling and escaping marks compare one language's bytes
   * with another's, so they are checked only then.
   */
  readonly allLanguages: boolean;
}

/** Canonical JSON with 64-bit integers kept exact, so no difference hides behind double rounding. */
const CANONICAL = { exactIntegers: true } as const;
const ERROR_FIELDS = ["path", "code", "expected", "found", "message"] as const satisfies readonly (keyof ErrorFields)[];
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NONE = "(none)";
/** U+2028 or U+2029 as characters, not escapes. */
const LINE_SEPARATORS = /[\u2028\u2029]/;

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The canonical form of what a language encoded, or why there is none. */
function canonicalEncoding(result: Result): string {
  if (result.encoded === null) return `encode failed: ${result.encodeError ?? ""}`;
  try {
    return canonicalize(result.encoded, CANONICAL);
  } catch (error) {
    if (!(error instanceof CanonicalError)) throw error;
    return `not canonical JSON: ${error.message}`;
  }
}

/** The canonical form a case should encode to again: its input without the unknown keys. */
function expectedEncoding(c: Case, outcome: Outcome & { accepted: true }): string {
  try {
    return serialize(withoutMembers(parseJson(UTF8.decode(c.bytes)), outcome.unknown), CANONICAL);
  } catch (error) {
    return `the case is not canonical JSON: ${reason(error)}`;
  }
}

/** The range TypeScript names in the expected field of out_of_range_integer. */
export const TS_SAFE_RANGE = "an integer from -9007199254740991 to 9007199254740991";

function describe(result: Result): string {
  if (result.accepted) return "accepted";
  const error = result.error;
  if (error === null) return "rejected";
  const at = error.path === "" ? "the root" : error.path;
  return `rejected ${error.code} at ${at}${error.expected === null ? "" : `, expected ${error.expected}`}`;
}

/** The rows for one run. */
export function compareRun(run: Run, marks: readonly Mark[], options: CompareOptions): Disagreement[] {
  const rows: Disagreement[] = [];
  const own = marks.filter((m) => m.case === run.case.id);
  const unsafe = own.find((m) => m.kind === "ts-unsafe-integer");
  const ran = LANGUAGES.filter((l) => run.results[l] !== undefined);
  // TypeScript's side of a ts-unsafe-integer case is checked by its mark instead.
  const compared = ran.filter((l) => !(unsafe !== undefined && l === "ts"));
  const result = (l: Language): Result => {
    const r = run.results[l];
    if (r === undefined) throw new Error(`no ${l} result`);
    return r;
  };
  const add = (field: string, values: readonly (readonly [Column, string])[]): void => {
    if (!values.some(([column]) => column !== "expected")) return;
    if (new Set(values.map(([, v]) => v)).size <= 1) return;
    rows.push({ case: run.case.id, mode: run.mode, decoder: run.decoder, field, values: Object.fromEntries(values) });
  };
  const want = expected(run.case, run.mode);

  // A decoder that threw or panicked is a bug, even when every language crashed alike.
  for (const l of ran) {
    const error = result(l).error;
    if (error?.code === CRASH) {
      rows.push({ case: run.case.id, mode: run.mode, decoder: run.decoder, field: "crash", values: { [l]: error.message } });
    }
  }

  add("result", [
    ...compared.map((l) => [l, result(l).accepted ? "accepted" : "rejected"] as const),
    ["expected", want.accepted ? "accepted" : "rejected"],
  ]);

  const rejecting = compared.filter((l) => !result(l).accepted);
  for (const field of ERROR_FIELDS) {
    add(field, [
      ...rejecting.map((l) => [l, result(l).error?.[field] ?? NONE] as const),
      ...(!want.accepted && (field === "path" || field === "code") ? [["expected", want[field]] as const] : []),
    ]);
  }

  const accepting = compared.filter((l) => result(l).accepted);
  add("unknown", [
    ...accepting.map((l) => [l, JSON.stringify(result(l).unknown)] as const),
    ...(want.accepted ? [["expected", JSON.stringify(want.unknown)] as const] : []),
  ]);
  add("encoded", [
    ...accepting.map((l) => [l, canonicalEncoding(result(l))] as const),
    ...(want.accepted ? [["expected", expectedEncoding(run.case, want)] as const] : []),
  ]);

  for (const mark of own) {
    const field = `mark ${mark.kind}`;
    if (mark.kind === "ts-unsafe-integer") {
      const ts = run.results.ts;
      if (ts === undefined) continue;
      const stated = `rejected out_of_range_integer at ${mark.path ?? ""}, expected ${TS_SAFE_RANGE}`;
      if (describe(ts) !== stated) {
        rows.push({ case: run.case.id, mode: run.mode, decoder: run.decoder, field, values: { ts: describe(ts), expected: stated } });
      }
      continue;
    }
    if (!options.allLanguages) continue;
    const raw = compared.map((l) => [l, result(l).encoded] as const);
    const encodings = raw.flatMap(([, e]) => (e === null ? [] : [e]));
    let differs = encodings.length === compared.length && new Set(encodings).size > 1;
    if (mark.kind === "line-separator-escaping") {
      differs &&=
        encodings.some((e) => /\\u202[89]/i.test(e)) && encodings.some((e) => LINE_SEPARATORS.test(e));
    }
    if (!differs) {
      rows.push({
        case: run.case.id,
        mode: run.mode,
        decoder: run.decoder,
        field,
        values: {
          ...Object.fromEntries(raw.map(([l, e]) => [l, e ?? describe(result(l))])),
          expected:
            mark.kind === "number-spelling"
              ? "accepted, bytes differ"
              : "accepted, one escapes U+2028 or U+2029 and another doesn't",
        },
      });
    }
  }
  return rows;
}

/** A value as one line of printable ASCII, at most `width` characters. */
export function cell(value: string, width = 60): string {
  let out = "";
  for (const c of value) {
    const code = c.codePointAt(0) ?? 0;
    out +=
      code >= 0x20 && code < 0x7f
        ? c
        : code > 0xffff
          ? `\\u{${code.toString(16)}}`
          : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out.length <= width ? out : `${out.slice(0, width - 3)}...`;
}

/** The disagreement table: one row per field that differs, with a column per language and the expectation. */
export function table(rows: readonly Disagreement[], languages: readonly Language[]): string[] {
  const columns: Column[] = [...languages, "expected"];
  const header = ["case", "mode", "field", ...columns];
  const lines = rows.map((r) => [
    r.case,
    r.decoder === "normal" ? r.mode : `${r.mode}/${r.decoder}`,
    r.field,
    ...columns.map((c) => cell(r.values[c] ?? "")),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? "").length)));
  const format = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [format(header), format(widths.map((w) => "-".repeat(w))), ...lines.map(format)];
}
