/**
 * Compares what every language did with one case against the others and against the case's
 * expectation. Any difference becomes a row of the disagreement table; there is no skip. A
 * difference is allowed only where the case carries a mark that explains it, and the marked
 * language must then do exactly what the mark states.
 */

import type { RespellOptions } from "./canonical.js";
import { CanonicalError, canonicalize, parseJson, respell, serialize, withoutMembers } from "./canonical.js";
import type { Case, Mark, MarkKind, Outcome } from "./cases.js";
import { expected } from "./cases.js";
import type { ErrorFields, Language, Result, Variant } from "./protocol.js";
import { CRASH, GO_SYNTAX_ERROR, LANGUAGES, SERDE_ERROR, variantName } from "./protocol.js";
import { compactOf, parseCompact } from "./vectors.js";

/** What every language that ran did with one case, in one variant. */
export interface Run {
  readonly case: Case;
  readonly variant: Variant;
  readonly results: Readonly<Partial<Record<Language, Result>>>;
}

/** A column of the table: a language, or what the case expects. */
export type Column = Language | "expected";

/** One row of the table: a field the languages, or a language and the expectation, disagree on. */
export interface Disagreement {
  readonly case: string;
  /** The variant the row is about, or null for a row about the whole case, like an unneeded mark. */
  readonly variant: Variant | null;
  readonly field: string;
  readonly values: Readonly<Partial<Record<Column, string>>>;
}

/** Canonical JSON with 64-bit integers kept exact, so no difference hides behind double rounding. */
const CANONICAL = { exactIntegers: true } as const;
const ERROR_FIELDS = ["path", "code", "expected", "found", "message"] as const satisfies readonly (keyof ErrorFields)[];
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const NONE = "(none)";

/** The range TypeScript names in the expected field of out_of_range_integer. */
export const TS_SAFE_RANGE = "an integer from -9007199254740991 to 9007199254740991";

/**
 * The marks that take one language out of the comparison, with the language, the variants they
 * apply in, and what that language must do instead.
 */
const EXCLUSIONS: Readonly<
  Partial<
    Record<
      MarkKind,
      { language: Language; applies: (v: Variant) => boolean; stated: (m: Mark) => string }
    >
  >
> = {
  "ts-unsafe-integer": {
    language: "ts",
    applies: () => true,
    stated: (m) => `rejected out_of_range_integer at ${m.path ?? ""}, expected ${TS_SAFE_RANGE}`,
  },
  "ts-no-bytes-api": { language: "ts", applies: () => true, stated: () => "rejected invalid_json at the root" },
  "go-unmarshal-syntax": {
    language: "go",
    applies: (v) => v.decoder === "normal" && v.mode === "strict" && v.entry === "public",
    stated: () => `rejected ${GO_SYNTAX_ERROR} at the root`,
  },
  "serde-outer-parse": {
    language: "rust",
    applies: (v) => v.entry === "serde",
    stated: () => `rejected ${SERDE_ERROR} at the root, with serde_json's own message`,
  },
};

/**
 * True when a serde error's message is a strict decoder's compact form, with or without the
 * position serde_json adds, like `/id missing_key at line 1 column 9`. The bridge writes those, so
 * on a case where serde_json refuses the text itself, such a message is a bridge bug the mark must
 * not hide.
 */
export function bridgeMessage(message: string): boolean {
  return parseCompact(message.replace(/ at line \d+ column \d+$/, "")) !== undefined;
}

/** The code a marked language must reject with at the root, for the marks that state one. */
const ROOT_CODES: Readonly<Partial<Record<MarkKind, string>>> = {
  "ts-no-bytes-api": "invalid_json",
  "go-unmarshal-syntax": GO_SYNTAX_ERROR,
  "serde-outer-parse": SERDE_ERROR,
};

/** The spellings each raw-bytes mark allows to differ. */
const RESPELLINGS: Readonly<Partial<Record<MarkKind, RespellOptions>>> = {
  "number-spelling": { numbers: true },
  "key-order": { keyOrder: true },
};

/** The respelling every one of `kinds` allows, together. */
function respelling(kinds: readonly MarkKind[]): RespellOptions {
  const options = kinds.flatMap((k) => (RESPELLINGS[k] === undefined ? [] : [RESPELLINGS[k]]));
  return {
    numbers: options.some((o) => o.numbers === true),
    keyOrder: options.some((o) => o.keyOrder === true),
  };
}

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
    return serialize(withoutMembers(parseJson(UTF8.decode(c.encodes ?? c.bytes)), outcome.unknown), CANONICAL);
  } catch (error) {
    return `the case is not canonical JSON: ${reason(error)}`;
  }
}

function describe(result: Result): string {
  if (result.accepted) return "accepted";
  const error = result.error;
  if (error === null) return "rejected";
  const at = error.path === "" ? "the root" : error.path;
  return `rejected ${error.code} at ${at}${error.expected === null ? "" : `, expected ${error.expected}`}`;
}

/** What a marked language must do, when it does something else. */
function statedFailure(mark: Mark, result: Result): string | undefined {
  const stated = EXCLUSIONS[mark.kind]?.stated(mark);
  if (stated === undefined) return undefined;
  if (mark.kind === "ts-unsafe-integer") return describe(result) === stated ? undefined : stated;
  const ok = !result.accepted && result.error?.path === "" && result.error.code === ROOT_CODES[mark.kind];
  if (ok && mark.kind === "serde-outer-parse" && bridgeMessage(result.error?.message ?? "")) return stated;
  return ok ? undefined : stated;
}

/** The rows for one run, with `marks` the marks of its case. */
export function compareRun(run: Run, marks: readonly Mark[]): Disagreement[] {
  const rows: Disagreement[] = [];
  const own = marks.filter((m) => m.case === run.case.id);
  const ran = LANGUAGES.filter((l) => run.results[l] !== undefined);
  const excluded = new Set(
    own.flatMap((m) => {
      const e = EXCLUSIONS[m.kind];
      return e !== undefined && e.applies(run.variant) ? [e.language] : [];
    }),
  );
  const compared = ran.filter((l) => !excluded.has(l));
  const result = (l: Language): Result => {
    const r = run.results[l];
    if (r === undefined) throw new Error(`no ${l} result`);
    return r;
  };
  const row = (field: string, values: Partial<Record<Column, string>>): void => {
    rows.push({ case: run.case.id, variant: run.variant, field, values });
  };
  const add = (field: string, values: readonly (readonly [Column, string])[]): void => {
    if (!values.some(([column]) => column !== "expected")) return;
    if (new Set(values.map(([, v]) => v)).size <= 1) return;
    row(field, Object.fromEntries(values));
  };
  // LLM decoders are strict in every read mode.
  const labelMode = run.variant.decoder === "llm" ? "strict" : run.variant.mode;
  const want = (run.case.unlabelled ?? []).includes(labelMode) ? undefined : expected(run.case, labelMode);

  // A decoder that threw or panicked is a bug, even when every language crashed alike.
  for (const l of ran) {
    const error = result(l).error;
    if (error?.code === CRASH) row("crash", { [l]: error.message });
  }

  // The cleanup step returns text, which must be exactly the vector's output in every language.
  if (run.variant.decoder === "cleanup") {
    add("result", [
      ...compared.map((l) => [l, result(l).accepted ? "accepted" : "rejected"] as const),
      ...(want === undefined ? [] : [["expected", "accepted"] as const]),
    ]);
    add("cleaned", [
      ...compared.flatMap((l) => (result(l).accepted ? [[l, result(l).encoded ?? NONE] as const] : [])),
      ...(want === undefined ? [] : [["expected", run.case.cleaned ?? NONE] as const]),
    ]);
    return rows;
  }

  add("result", [
    ...compared.map((l) => [l, result(l).accepted ? "accepted" : "rejected"] as const),
    ...(want === undefined ? [] : [["expected", want.accepted ? "accepted" : "rejected"] as const]),
  ]);

  const rejecting = compared.filter((l) => !result(l).accepted);
  for (const field of ERROR_FIELDS) {
    add(field, [
      ...rejecting.map((l) => [l, result(l).error?.[field] ?? NONE] as const),
      ...(want !== undefined && !want.accepted && (field === "path" || field === "code") ? [["expected", want[field]] as const] : []),
    ]);
  }

  if (run.case.compact !== undefined) {
    add("compact", [
      ...rejecting.flatMap((l) => {
        const e = result(l).error;
        return e === null ? [] : [[l, compactOf(e)] as const];
      }),
      ["expected", run.case.compact],
    ]);
  }

  const accepting = compared.filter((l) => result(l).accepted);
  add("unknown", [
    ...accepting.map((l) => [l, JSON.stringify(result(l).unknown)] as const),
    ...(want?.accepted === true ? [["expected", JSON.stringify(want.unknown)] as const] : []),
  ]);
  const before = rows.length;
  add("encoded", [
    ...accepting.map((l) => [l, canonicalEncoding(result(l))] as const),
    ...(want?.accepted === true ? [["expected", expectedEncoding(run.case, want)] as const] : []),
  ]);

  // Once the canonical bytes agree, the bytes as written must agree too, but for the spellings
  // the case's marks allow.
  const raw = accepting.flatMap((l) => {
    const e = result(l).encoded;
    return e === null ? [] : [[l, e] as const];
  });
  if (rows.length === before && raw.length > 1 && new Set(raw.map(([, e]) => e)).size > 1) {
    const allowed = respelling(own.map((m) => m.kind));
    const respelled = raw.map(([, e]) => respell(e, allowed) ?? e);
    if (new Set(respelled).size > 1) row("raw", Object.fromEntries(raw));
  }

  for (const mark of own) {
    const exclusion = EXCLUSIONS[mark.kind];
    if (exclusion === undefined || !exclusion.applies(run.variant)) continue;
    const marked = run.results[exclusion.language];
    if (marked === undefined) continue;
    const stated = statedFailure(mark, marked);
    if (stated !== undefined) row(`mark ${mark.kind}`, { [exclusion.language]: describe(marked), expected: stated });
  }
  return rows;
}

const rowKey = (r: Disagreement): string => JSON.stringify([r.variant, r.field, r.values]);

/**
 * The marks of a run that change its rows: without one of them, the run would disagree
 * somewhere it doesn't now. A mark no run needs explains nothing, and fails.
 */
export function usedMarks(run: Run, marks: readonly Mark[]): Mark[] {
  const own = marks.filter((m) => m.case === run.case.id);
  const now = new Set(compareRun(run, own).map(rowKey));
  return own.filter((m) => {
    const without = compareRun(
      run,
      own.filter((x) => x !== m),
    );
    return without.some((r) => !now.has(rowKey(r)));
  });
}

/** The first offset where the values differ, or undefined when they are all equal. */
export function firstDifference(values: readonly string[]): number | undefined {
  if (new Set(values).size <= 1) return undefined;
  const shortest = Math.min(...values.map((v) => v.length));
  for (let i = 0; i < shortest; i++) {
    const c = values[0]?.[i];
    if (values.some((v) => v[i] !== c)) return i;
  }
  return shortest;
}

/** A value as one line of printable ASCII, at most `width` characters. */
export function cell(value: string, width = 60): string {
  let out = "";
  for (const c of value) {
    const code = c.codePointAt(0) ?? 0;
    // A character that isn't printable ASCII shows as <U+2028>, never as a JSON escape, so a
    // character and its escape look different.
    out += code >= 0x20 && code < 0x7f ? c : `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
  }
  return out.length <= width ? out : `${out.slice(0, width - 3)}...`;
}

/** The text around `offset`, as `@offset ...text...`, for a value that is long. */
export function around(value: string, offset: number, before = 12, after = 28): string {
  const start = Math.max(0, offset - before);
  const end = Math.min(value.length, offset + after);
  return `@${String(offset)} ${start > 0 ? "..." : ""}${cell(value.slice(start, end), Number.MAX_SAFE_INTEGER)}${end < value.length ? "..." : ""}`;
}

/** The fields whose values are whole JSON documents, shown around their first difference. */
const DOCUMENTS = new Set(["encoded", "raw", "cleaned"]);

/** The disagreement table: one row per field that differs, with a column per language and the expectation. */
export function table(rows: readonly Disagreement[], languages: readonly Language[]): string[] {
  const columns: Column[] = [...languages, "expected"];
  const header = ["case", "variant", "field", ...columns];
  const lines = rows.map((r) => {
    const present = columns.flatMap((c) => (r.values[c] === undefined ? [] : [r.values[c] ?? ""]));
    const offset = DOCUMENTS.has(r.field) ? firstDifference(present) : undefined;
    return [
      r.case,
      r.variant === null ? "-" : variantName(r.variant),
      r.field,
      ...columns.map((c) => {
        const v = r.values[c];
        if (v === undefined) return "";
        return offset === undefined ? cell(v) : around(v, offset);
      }),
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? "").length)));
  const format = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [format(header), format(widths.map((w) => "-".repeat(w))), ...lines.map(format)];
}
