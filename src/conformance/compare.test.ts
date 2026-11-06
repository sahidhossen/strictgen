import { describe, expect, it } from "vitest";

import type { Case, Mark, MarkKind } from "./cases.js";
import { MARK_KINDS } from "./cases.js";
import type { Disagreement, Run } from "./compare.js";
import { cell, compareRun, table, TS_SAFE_RANGE } from "./compare.js";
import type { ErrorFields, Language, Result } from "./protocol.js";
import { LANGUAGES } from "./protocol.js";
import { compareAll, requestsFor, variants } from "./suite.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function validCase(text: string, id = "Order/valid/a"): Case {
  return { id, type: "Order", valid: true, bytes: bytes(text), strict: { accepted: true, unknown: [] }, report: { accepted: true, unknown: [] } };
}

function invalidCase(text: string, path: string, code: string, report?: Case["report"]): Case {
  const strict = { accepted: false as const, path, code };
  return { id: "Order/invalid/b", type: "Order", valid: false, bytes: bytes(text), strict, report: report ?? strict };
}

const accepted = (encoded: string, unknown: string[] = []): Result => ({
  id: 0,
  accepted: true,
  error: null,
  unknown,
  encoded,
  encodeError: null,
});

const rejected = (fields: Partial<ErrorFields> & { path: string; code: string }): Result => ({
  id: 0,
  accepted: false,
  error: { expected: null, found: null, message: `${fields.path}: ${fields.code}`, ...fields },
  unknown: null,
  encoded: null,
  encodeError: null,
});

const every = (result: Result): Record<Language, Result> => ({ rust: result, go: result, ts: result });

function run(c: Case, results: Partial<Record<Language, Result>>, mode: Run["mode"] = "strict"): Run {
  return { case: c, mode, decoder: "normal", results };
}

const fields = (rows: readonly Disagreement[]): string[] => rows.map((r) => r.field);
const all = { allLanguages: true };

describe("comparing languages with each other and the expectation", () => {
  it("finds nothing when every language agrees with the expectation", () => {
    const c = validCase('{"id":"o","n":1.0}');
    expect(compareRun(run(c, { rust: accepted('{"n":1.0,"id":"o"}'), go: accepted('{"id":"o","n":1}'), ts: accepted('{"id":"o","n":1}') }), [], all)).toEqual([]);
    const bad = invalidCase("{}", "/id", "missing_key");
    expect(compareRun(run(bad, every(rejected({ path: "/id", code: "missing_key" }))), [], all)).toEqual([]);
  });

  it("reports accept against reject, with the expectation", () => {
    const c = validCase('{"id":"o"}');
    const rows = compareRun(run(c, { rust: accepted('{"id":"o"}'), go: rejected({ path: "/id", code: "too_short" }), ts: accepted('{"id":"o"}') }), [], all);
    expect(rows[0]).toEqual({
      case: "Order/valid/a",
      mode: "strict",
      decoder: "normal",
      field: "result",
      values: { rust: "accepted", go: "rejected", ts: "accepted", expected: "accepted" },
    });
  });

  it("compares all five error fields across languages, and path and code with the expectation", () => {
    const c = invalidCase("{}", "/id", "missing_key");
    const base = { path: "/id", code: "missing_key" };
    for (const field of ["expected", "found", "message"] as const) {
      const rows = compareRun(run(c, { ...every(rejected(base)), go: rejected({ ...base, [field]: "other" }) }), [], all);
      expect(fields(rows), field).toEqual([field]);
    }
    const rows = compareRun(run(c, every(rejected({ path: "/name", code: "missing_key", message: "m" }))), [], all);
    expect(rows).toEqual([
      {
        case: "Order/invalid/b",
        mode: "strict",
        decoder: "normal",
        field: "path",
        values: { rust: "/name", go: "/name", ts: "/name", expected: "/id" },
      },
    ]);
    expect(fields(compareRun(run(c, every(rejected({ path: "/id", code: "wrong_type" }))), [], all))).toEqual(["code"]);
  });

  it("shows an absent expected or found as (none)", () => {
    const c = invalidCase("{}", "/id", "too_long");
    const rows = compareRun(
      run(c, { ...every(rejected({ path: "/id", code: "too_long", expected: "at most 2" })), ts: rejected({ path: "/id", code: "too_long" }) }),
      [],
      all,
    );
    expect(rows[0]?.values).toEqual({ rust: "at most 2", go: "at most 2", ts: "(none)" });
  });

  it("compares unknown paths in report mode, in order", () => {
    const c = invalidCase('{"id":"o","x":1,"y":2}', "/x", "unknown_key", { accepted: true, unknown: ["/x", "/y"] });
    expect(compareRun(run(c, every(accepted('{"id":"o"}', ["/x", "/y"])), "report"), [], all)).toEqual([]);
    const rows = compareRun(run(c, { ...every(accepted('{"id":"o"}', ["/x", "/y"])), rust: accepted('{"id":"o"}', ["/y", "/x"]) }, "report"), [], all);
    expect(rows.map((r) => [r.field, r.values.rust, r.values.expected])).toEqual([["unknown", '["/y","/x"]', '["/x","/y"]']]);
    // In strict mode the same case is the unknown_key error.
    expect(compareRun(run(c, every(rejected({ path: "/x", code: "unknown_key" }))), [], all)).toEqual([]);
  });

  it("compares the re-encoded bytes once canonical, and with the input without its unknown keys", () => {
    const c = validCase('{"id":"o","n":1e2,"s":"\\u00e9"}');
    const same = ['{"s":"\u00e9","n":100.0,"id":"o"}', '{"id":"o","n":1e2,"s":"\\u00e9"}', '{"id":"o","n":100,"s":"\u00e9"}'];
    expect(compareRun(run(c, { rust: accepted(same[0] ?? ""), go: accepted(same[1] ?? ""), ts: accepted(same[2] ?? "") }), [], all)).toEqual([]);
    const rows = compareRun(run(c, { ...every(accepted(same[2] ?? "")), go: accepted('{"id":"o","n":101,"s":"\u00e9"}') }), [], all);
    expect(rows.map((r) => [r.field, r.values.go, r.values.expected])).toEqual([["encoded", '{"id":"o","n":101,"s":"\u00e9"}', '{"id":"o","n":100,"s":"\u00e9"}']]);
    // Every language dropping a key the same way is still a disagreement, with the expectation.
    expect(fields(compareRun(run(c, every(accepted('{"id":"o","n":100}'))), [], all))).toEqual(["encoded"]);
  });

  it("fails a valid case that isn't UTF-8 or canonical JSON, whatever the languages did", () => {
    const notUtf8: Case = { ...validCase("{}"), bytes: new Uint8Array([0x22, 0xff, 0x22]) };
    const rows = compareRun(run(notUtf8, every(accepted('"x"'))), [], all);
    expect(rows.map((r) => [r.field, r.values.expected])).toEqual([["encoded", "the case is not canonical JSON: The encoded data was not valid for encoding utf-8"]]);
    expect(compareRun(run(validCase('{"a":1,"a":1}'), every(accepted('{"a":1}'))), [], all)[0]?.values.expected).toBe(
      "the case is not canonical JSON: a duplicate key at offset 7",
    );
  });

  it("keeps 64-bit integers exact when comparing encodings", () => {
    const c = validCase('{"n":9007199254740993}');
    expect(fields(compareRun(run(c, { rust: accepted('{"n":9007199254740993}'), go: accepted('{"n":9007199254740992}') }), [], all))).toEqual(["encoded"]);
  });

  it("reports an encoder that failed, and output that isn't JSON", () => {
    const c = validCase('{"id":"o"}');
    const failed: Result = { ...accepted(""), encoded: null, encodeError: "no" };
    const rows = compareRun(run(c, { ...every(accepted('{"id":"o"}')), rust: failed, go: accepted('{"id":"o"') }), [], all);
    expect(rows.map((r) => [r.field, r.values.rust, r.values.go])).toEqual([
      ["encoded", "encode failed: no", "not canonical JSON: a missing comma or closing brace at offset 9"],
    ]);
  });

  it("reports a crash even when every language crashed alike", () => {
    const c = invalidCase("{}", "/id", "missing_key");
    const rows = compareRun(run(c, { ...every(rejected({ path: "/id", code: "missing_key" })), go: rejected({ path: "", code: "crash", message: "boom" }) }), [], all);
    expect(rows.find((r) => r.field === "crash")?.values).toEqual({ go: "boom" });
    expect(fields(compareRun(run(c, every(rejected({ path: "", code: "crash", message: "boom" }))), [], all))).toContain("crash");
  });

  it("compares only the languages that ran", () => {
    const c = validCase('{"id":"o"}');
    expect(compareRun(run(c, { ts: accepted('{"id":"o"}') }), [], { allLanguages: false })).toEqual([]);
    expect(fields(compareRun(run(c, { ts: rejected({ path: "", code: "wrong_type" }) }), [], { allLanguages: false }))).toEqual(["result"]);
  });
});

describe("marked differences", () => {
  const mark = (kind: MarkKind, extra: Partial<Mark> = {}): Mark => ({ case: "Order/valid/a", kind, reason: "why", ...extra });

  it("knows every kind", () => {
    expect([...MARK_KINDS].sort()).toEqual(["line-separator-escaping", "number-spelling", "ts-unsafe-integer"]);
  });

  describe("ts-unsafe-integer", () => {
    const c = validCase('{"n":9007199254740993}');
    const m = mark("ts-unsafe-integer", { path: "/n" });
    const unsafe = rejected({ path: "/n", code: "out_of_range_integer", expected: TS_SAFE_RANGE });
    const big = accepted('{"n":9007199254740993}');

    it("takes TypeScript out of the comparison when it rejects at the path with its range", () => {
      expect(compareRun(run(c, { rust: big, go: big, ts: unsafe }), [m], all)).toEqual([]);
      // Without the mark the same results disagree.
      expect(fields(compareRun(run(c, { rust: big, go: big, ts: unsafe }), [], all))).toEqual(["result"]);
    });

    it("still compares Rust and Go with each other and the expectation", () => {
      expect(fields(compareRun(run(c, { rust: big, go: accepted('{"n":1}'), ts: unsafe }), [m], all))).toEqual(["encoded"]);
    });

    it("fails once TypeScript no longer differs in the stated way", () => {
      for (const ts of [big, rejected({ path: "/m", code: "out_of_range_integer", expected: TS_SAFE_RANGE }), rejected({ path: "/n", code: "wrong_type" }), rejected({ path: "/n", code: "out_of_range_integer", expected: "an integer" })]) {
        const rows = compareRun(run(c, { rust: big, go: big, ts }), [m], all);
        expect(fields(rows)).toEqual(["mark ts-unsafe-integer"]);
        expect(rows[0]?.values.expected).toBe(`rejected out_of_range_integer at /n, expected ${TS_SAFE_RANGE}`);
      }
    });

    it("is checked whenever TypeScript ran, and only then", () => {
      expect(compareRun(run(c, { ts: big }), [m], { allLanguages: false }).map((r) => r.field)).toEqual(["mark ts-unsafe-integer"]);
      expect(compareRun(run(c, { rust: big }), [m], { allLanguages: false })).toEqual([]);
    });
  });

  describe("number-spelling", () => {
    const c = validCase('{"n":1.50E+2}');
    const m = mark("number-spelling");

    it("passes when the bytes differ and are equal once canonical", () => {
      expect(compareRun(run(c, { rust: accepted('{"n":150.0}'), go: accepted('{"n":1.50E+2}'), ts: accepted('{"n":150}') }), [m], all)).toEqual([]);
    });

    it("fails once every language writes the same bytes", () => {
      expect(fields(compareRun(run(c, every(accepted('{"n":150}'))), [m], all))).toEqual(["mark number-spelling"]);
    });

    it("fails when a language rejects the case", () => {
      const rows = compareRun(run(c, { rust: accepted('{"n":150.0}'), go: accepted('{"n":1.50E+2}'), ts: rejected({ path: "/n", code: "wrong_type" }) }), [m], all);
      expect(fields(rows)).toContain("mark number-spelling");
    });

    it("is not checked unless every language ran", () => {
      expect(compareRun(run(c, { ts: accepted('{"n":150}') }), [m], { allLanguages: false })).toEqual([]);
    });
  });

  describe("line-separator-escaping", () => {
    const ls = String.fromCharCode(0x2028);
    const escaped = `${String.fromCharCode(92)}u2028`;
    const c = validCase(`{"s":"${escaped}"}`);
    const m = mark("line-separator-escaping");

    it("passes when one language escapes the character and another writes it", () => {
      expect(compareRun(run(c, { rust: accepted(`{"s":"${ls}"}`), go: accepted(`{"s":"${escaped}"}`), ts: accepted(`{"s":"${ls}"}`) }), [m], all)).toEqual([]);
    });

    it("fails once no language escapes it, or every one does", () => {
      expect(fields(compareRun(run(c, every(accepted(`{"s":"${ls}"}`))), [m], all))).toEqual(["mark line-separator-escaping"]);
      expect(fields(compareRun(run(c, every(accepted(`{"s":"${escaped}"}`))), [m], all))).toEqual(["mark line-separator-escaping"]);
    });

    it("fails when the bytes differ some other way", () => {
      const rows = compareRun(run(c, { rust: accepted(`{"s":"${ls}"}`), go: accepted(`{ "s":"${ls}"}`), ts: accepted(`{"s":"${ls}"}`) }), [m], all);
      expect(fields(rows)).toEqual(["mark line-separator-escaping"]);
    });
  });

  it("only applies to its own case", () => {
    const other = validCase('{"n":1}', "Order/valid/other");
    const big = accepted('{"n":1}');
    const rows = compareRun(run(other, { rust: big, go: big, ts: rejected({ path: "/n", code: "out_of_range_integer" }) }), [mark("ts-unsafe-integer", { path: "/n" })], all);
    expect(fields(rows)).toEqual(["result"]);
  });
});

describe("one run over every case", () => {
  it("numbers requests by variant, then case, and puts each result back with its case", () => {
    const cases = [validCase('{"a":1}', "Order/valid/a"), invalidCase("{}", "/id", "missing_key")];
    const list = variants(["strict", "report"]);
    expect(list).toEqual([
      { mode: "strict", decoder: "normal" },
      { mode: "report", decoder: "normal" },
    ]);
    const requests = requestsFor(cases, list);
    expect(requests.map((r) => [r.id, r.mode, r.type, r.hex])).toEqual([
      [0, "strict", "Order", "7b2261223a317d"],
      [1, "strict", "Order", "7b7d"],
      [2, "report", "Order", "7b2261223a317d"],
      [3, "report", "Order", "7b7d"],
    ]);
    const good = [accepted('{"a":1}'), rejected({ path: "/id", code: "missing_key" }), accepted('{"a":1}'), rejected({ path: "/id", code: "missing_key" })];
    const results = Object.fromEntries(LANGUAGES.map((l) => [l, good]));
    expect(compareAll(cases, list, results, [])).toEqual([]);
    const swapped = { ...results, go: [good[0], good[1], good[3], good[2]] as Result[] };
    expect(compareAll(cases, list, swapped, []).map((r) => [r.case, r.mode])).toEqual([
      ["Order/valid/a", "report"],
      ["Order/invalid/b", "report"],
    ]);
  });
});

describe("the disagreement table", () => {
  it("has a column per language that ran and the expectation, padded to fit", () => {
    const rows: Disagreement[] = [
      { case: "Order/valid/a", mode: "report", decoder: "normal", field: "result", values: { rust: "accepted", ts: "rejected", expected: "accepted" } },
      { case: "Order/invalid/b", mode: "strict", decoder: "llm", field: "code", values: { rust: "too_long", ts: "too_short" } },
    ];
    expect(table(rows, ["rust", "ts"])).toEqual([
      "case             mode        field   rust      ts         expected",
      "---------------  ----------  ------  --------  ---------  --------",
      "Order/valid/a    report      result  accepted  rejected   accepted",
      "Order/invalid/b  strict/llm  code    too_long  too_short",
    ]);
  });

  it("escapes what isn't printable ASCII and cuts long values", () => {
    expect(cell(`a\n${String.fromCodePoint(0xe9, 0x1f600)}`)).toBe("a\\u000a\\u00e9\\u{1f600}");
    expect(cell("x".repeat(100), 10)).toBe("xxxxxxx...");
  });
});
