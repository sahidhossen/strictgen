import { describe, expect, it } from "vitest";

import type { Case, Mark, MarkKind } from "./cases.js";
import { MARK_KINDS } from "./cases.js";
import type { Disagreement, Run } from "./compare.js";
import { around, cell, compareRun, firstDifference, table, TS_SAFE_RANGE, usedMarks } from "./compare.js";
import type { ErrorFields, Language, Result, Variant } from "./protocol.js";
import { LANGUAGES, variantName } from "./protocol.js";
import { compareAll, requestsFor, variants } from "./suite.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const LS = String.fromCharCode(0x2028);
const BS = String.fromCharCode(92);

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
const STRICT: Variant = { mode: "strict", decoder: "normal", entry: "public" };
const REPORT: Variant = { mode: "report", decoder: "normal", entry: "public" };

function run(c: Case, results: Partial<Record<Language, Result>>, variant: Variant = STRICT): Run {
  return { case: c, variant, results };
}

const fields = (rows: readonly Disagreement[]): string[] => rows.map((r) => r.field);
const mark = (kind: MarkKind, extra: Partial<Mark> = {}): Mark => ({ case: "Order/valid/a", kind, reason: "why", ...extra });

describe("comparing languages with each other and the expectation", () => {
  it("finds nothing when every language agrees with the expectation, byte for byte", () => {
    const c = validCase('{"id":"o","n":1}');
    expect(compareRun(run(c, every(accepted('{"id":"o","n":1}'))), [])).toEqual([]);
    const bad = invalidCase("{}", "/id", "missing_key");
    expect(compareRun(run(bad, every(rejected({ path: "/id", code: "missing_key" }))), [])).toEqual([]);
  });

  it("reports accept against reject, with the expectation", () => {
    const c = validCase('{"id":"o"}');
    const rows = compareRun(run(c, { rust: accepted('{"id":"o"}'), go: rejected({ path: "/id", code: "too_short" }), ts: accepted('{"id":"o"}') }), []);
    expect(rows[0]).toEqual({
      case: "Order/valid/a",
      variant: STRICT,
      field: "result",
      values: { rust: "accepted", go: "rejected", ts: "accepted", expected: "accepted" },
    });
  });

  it("compares all five error fields across languages, and path and code with the expectation", () => {
    const c = invalidCase("{}", "/id", "missing_key");
    const base = { path: "/id", code: "missing_key" };
    for (const field of ["expected", "found", "message"] as const) {
      const rows = compareRun(run(c, { ...every(rejected(base)), go: rejected({ ...base, [field]: "other" }) }), []);
      expect(fields(rows), field).toEqual([field]);
    }
    const rows = compareRun(run(c, every(rejected({ path: "/name", code: "missing_key", message: "m" }))), []);
    expect(rows).toEqual([
      { case: "Order/invalid/b", variant: STRICT, field: "path", values: { rust: "/name", go: "/name", ts: "/name", expected: "/id" } },
    ]);
    expect(fields(compareRun(run(c, every(rejected({ path: "/id", code: "wrong_type" }))), []))).toEqual(["code"]);
  });

  it("shows an absent expected or found as (none)", () => {
    const c = invalidCase("{}", "/id", "too_long");
    const rows = compareRun(
      run(c, { ...every(rejected({ path: "/id", code: "too_long", expected: "at most 2" })), ts: rejected({ path: "/id", code: "too_long" }) }),
      [],
    );
    expect(rows[0]?.values).toEqual({ rust: "at most 2", go: "at most 2", ts: "(none)" });
  });

  it("compares unknown paths in report mode, in order", () => {
    const c = invalidCase('{"id":"o","x":1,"y":2}', "/x", "unknown_key", { accepted: true, unknown: ["/x", "/y"] });
    expect(compareRun(run(c, every(accepted('{"id":"o"}', ["/x", "/y"])), REPORT), [])).toEqual([]);
    const rows = compareRun(run(c, { ...every(accepted('{"id":"o"}', ["/x", "/y"])), rust: accepted('{"id":"o"}', ["/y", "/x"]) }, REPORT), []);
    expect(rows.map((r) => [r.field, r.values.rust, r.values.expected])).toEqual([["unknown", '["/y","/x"]', '["/x","/y"]']]);
    // In strict mode the same case is the unknown_key error.
    expect(compareRun(run(c, every(rejected({ path: "/x", code: "unknown_key" }))), [])).toEqual([]);
  });

  it("compares the re-encoded bytes once canonical, with each other and the input without its unknown keys", () => {
    const c = validCase('{"id":"o","n":100}');
    const rows = compareRun(run(c, { ...every(accepted('{"id":"o","n":100}')), go: accepted('{"id":"o","n":101}') }), []);
    expect(rows.map((r) => [r.field, r.values.go, r.values.expected])).toEqual([["encoded", '{"id":"o","n":101}', '{"id":"o","n":100}']]);
    // Every language dropping a key the same way is still a disagreement, with the expectation.
    expect(fields(compareRun(run(c, every(accepted('{"id":"o"}'))), []))).toEqual(["encoded"]);
  });

  it("fails a valid case that isn't UTF-8 or canonical JSON, whatever the languages did", () => {
    const notUtf8: Case = { ...validCase("{}"), bytes: new Uint8Array([0x22, 0xff, 0x22]) };
    const rows = compareRun(run(notUtf8, every(accepted('"x"'))), []);
    expect(rows.map((r) => [r.field, r.values.expected])).toEqual([["encoded", "the case is not canonical JSON: The encoded data was not valid for encoding utf-8"]]);
    expect(compareRun(run(validCase('{"a":1,"a":1}'), every(accepted('{"a":1}'))), [])[0]?.values.expected).toBe(
      "the case is not canonical JSON: a duplicate key at offset 7",
    );
  });

  it("keeps 64-bit integers exact when comparing encodings", () => {
    const c = validCase('{"n":9007199254740993}');
    expect(fields(compareRun(run(c, { rust: accepted('{"n":9007199254740993}'), go: accepted('{"n":9007199254740992}') }), []))).toEqual(["encoded"]);
  });

  it("reports an encoder that failed, and output that isn't JSON", () => {
    const c = validCase('{"id":"o"}');
    const failed: Result = { ...accepted(""), encoded: null, encodeError: "no" };
    const rows = compareRun(run(c, { ...every(accepted('{"id":"o"}')), rust: failed, go: accepted('{"id":"o"') }), []);
    expect(rows.map((r) => [r.field, r.values.rust, r.values.go])).toEqual([
      ["encoded", "encode failed: no", "not canonical JSON: a missing comma or closing brace at offset 9"],
    ]);
  });

  it("reports a crash even when every language crashed alike", () => {
    const c = invalidCase("{}", "/id", "missing_key");
    const rows = compareRun(run(c, { ...every(rejected({ path: "/id", code: "missing_key" })), go: rejected({ path: "", code: "crash", message: "boom" }) }), []);
    expect(rows.find((r) => r.field === "crash")?.values).toEqual({ go: "boom" });
    expect(fields(compareRun(run(c, every(rejected({ path: "", code: "crash", message: "boom" }))), []))).toContain("crash");
  });

  it("compares only the languages that ran", () => {
    const c = validCase('{"id":"o"}');
    expect(compareRun(run(c, { ts: accepted('{"id":"o"}') }), [])).toEqual([]);
    expect(fields(compareRun(run(c, { ts: rejected({ path: "", code: "wrong_type" }) }), []))).toEqual(["result"]);
  });
});

describe("the bytes as written", () => {
  const c = validCase('{"n":1.5E+2,"s":"a"}');

  it("must be equal across languages without a mark, even when the canonical bytes are", () => {
    const rows = compareRun(run(c, { rust: accepted('{"n":150.0,"s":"a"}'), go: accepted('{"n":1.5E+2,"s":"a"}'), ts: accepted('{"n":150,"s":"a"}') }), []);
    expect(rows).toEqual([
      { case: "Order/valid/a", variant: STRICT, field: "raw", values: { rust: '{"n":150.0,"s":"a"}', go: '{"n":1.5E+2,"s":"a"}', ts: '{"n":150,"s":"a"}' } },
    ]);
  });

  it("count an integer written as 5.0 or 5e0 as a difference", () => {
    const five = validCase('{"n":5}');
    for (const spelled of ['{"n":5.0}', '{"n":5e0}']) {
      expect(fields(compareRun(run(five, { ...every(accepted('{"n":5}')), rust: accepted(spelled) }), [])), spelled).toEqual(["raw"]);
    }
  });

  it("may differ only in what the case's marks allow", () => {
    const spelled = { rust: accepted('{"n":150.0,"s":"a"}'), go: accepted('{"n":1.5E+2,"s":"a"}'), ts: accepted('{"n":150,"s":"a"}') };
    expect(compareRun(run(c, spelled), [mark("number-spelling")])).toEqual([]);
    // The mark allows number spelling only, not an escape too.
    const escaped = { ...spelled, go: accepted(`{"n":1.5E+2,"s":"${BS}u0061"}`) };
    expect(fields(compareRun(run(c, escaped), [mark("number-spelling")]))).toEqual(["raw"]);
    expect(compareRun(run(c, escaped), [mark("number-spelling"), mark("string-escaping")])).toEqual([]);
  });

  it("allow U+2028 and U+2029 escaped for line-separator-escaping, and nothing else", () => {
    const ls = validCase(`{"s":"${BS}u2028"}`);
    const results = { rust: accepted(`{"s":"${LS}"}`), go: accepted(`{"s":"${BS}u2028"}`), ts: accepted(`{"s":"${LS}"}`) };
    expect(compareRun(run(ls, results), [mark("line-separator-escaping")])).toEqual([]);
    const html = validCase('{"s":"<"}');
    const go = { ...every(accepted('{"s":"<"}')), go: accepted(`{"s":"${BS}u003c"}`) };
    expect(fields(compareRun(run(html, go), [mark("line-separator-escaping")]))).toEqual(["raw"]);
    expect(compareRun(run(html, go), [mark("html-escaping")])).toEqual([]);
  });

  it("allow another key order for key-order", () => {
    const keys = validCase('{"a":1,"b":2}');
    const results = { ...every(accepted('{"a":1,"b":2}')), go: accepted('{"b":2,"a":1}') };
    expect(fields(compareRun(run(keys, results), []))).toEqual(["raw"]);
    expect(compareRun(run(keys, results), [mark("key-order")])).toEqual([]);
  });

  it("never allow whitespace, which isn't a spelling any mark names", () => {
    const results = { ...every(accepted('{"n":150,"s":"a"}')), go: accepted('{"n":150, "s":"a"}') };
    expect(fields(compareRun(run(c, results), MARK_KINDS.filter((k) => !k.startsWith("ts-") && !k.startsWith("go-")).map((k) => mark(k))))).toEqual(["raw"]);
  });
});

describe("marks that take a language out", () => {
  describe("ts-unsafe-integer", () => {
    const c = validCase('{"n":9007199254740993}');
    const m = mark("ts-unsafe-integer", { path: "/n" });
    const unsafe = rejected({ path: "/n", code: "out_of_range_integer", expected: TS_SAFE_RANGE });
    const big = accepted('{"n":9007199254740993}');

    it("takes TypeScript out of the comparison when it rejects at the path with its range", () => {
      expect(compareRun(run(c, { rust: big, go: big, ts: unsafe }), [m])).toEqual([]);
      expect(fields(compareRun(run(c, { rust: big, go: big, ts: unsafe }), []))).toEqual(["result"]);
    });

    it("still compares Rust and Go with each other and the expectation", () => {
      expect(fields(compareRun(run(c, { rust: big, go: accepted('{"n":1}'), ts: unsafe }), [m]))).toEqual(["encoded"]);
    });

    it("fails once TypeScript no longer does exactly what it states", () => {
      for (const ts of [
        big,
        rejected({ path: "/m", code: "out_of_range_integer", expected: TS_SAFE_RANGE }),
        rejected({ path: "/n", code: "wrong_type" }),
        rejected({ path: "/n", code: "out_of_range_integer", expected: "an integer" }),
      ]) {
        const rows = compareRun(run(c, { rust: big, go: big, ts }), [m]);
        expect(fields(rows)).toEqual(["mark ts-unsafe-integer"]);
        expect(rows[0]?.values.expected).toBe(`rejected out_of_range_integer at /n, expected ${TS_SAFE_RANGE}`);
      }
    });
  });

  describe("ts-no-bytes-api", () => {
    const c: Case = { ...invalidCase("", "", "invalid_json"), bytes: new Uint8Array([0xff]) };
    const m = mark("ts-no-bytes-api", { case: c.id });
    const full = rejected({ path: "", code: "invalid_json", found: "invalid UTF-8 at offset 0" });
    const ts = rejected({ path: "", code: "invalid_json", message: "not UTF-8 text" });

    it("holds TypeScript to invalid_json at the root and compares Rust and Go on every field", () => {
      expect(compareRun(run(c, { rust: full, go: full, ts }), [m])).toEqual([]);
      expect(fields(compareRun(run(c, { rust: full, go: full, ts }), []))).toEqual(["found", "message"]);
      expect(fields(compareRun(run(c, { rust: full, go: { ...full, error: { ...full.error!, found: "x" } }, ts }), [m]))).toEqual(["found"]);
      expect(fields(compareRun(run(c, { rust: full, go: full, ts: rejected({ path: "/a", code: "invalid_json" }) }), [m]))).toEqual(["mark ts-no-bytes-api"]);
    });
  });

  describe("go-unmarshal-syntax", () => {
    const c = invalidCase("[1,]", "/1", "invalid_json");
    const m = mark("go-unmarshal-syntax", { case: c.id });
    const shared = rejected({ path: "/1", code: "invalid_json" });
    const go = rejected({ path: "", code: "json.SyntaxError", message: "invalid character ']'" });

    it("applies to Go's public entry point in strict mode only", () => {
      expect(compareRun(run(c, { rust: shared, go, ts: shared }), [m])).toEqual([]);
      for (const variant of [REPORT, { ...STRICT, entry: "registry" as const }]) {
        expect(fields(compareRun(run(c, { rust: shared, go, ts: shared }, variant), [m])), variantName(variant)).toEqual(["path", "code", "message"]);
        expect(compareRun(run(c, every(shared), variant), [m])).toEqual([]);
      }
      expect(fields(compareRun(run(c, every(shared)), [m]))).toEqual(["mark go-unmarshal-syntax"]);
    });
  });

  it("only apply to their own case", () => {
    const other = validCase('{"n":1}', "Order/valid/other");
    const big = accepted('{"n":1}');
    const rows = compareRun(run(other, { rust: big, go: big, ts: rejected({ path: "/n", code: "out_of_range_integer" }) }), [mark("ts-unsafe-integer", { path: "/n" })]);
    expect(fields(rows)).toEqual(["result"]);
  });
});

describe("marks that aren't needed", () => {
  it("are found by removing each one", () => {
    const c = validCase('{"n":1.5E+2}');
    const spelled = { rust: accepted('{"n":150.0}'), go: accepted('{"n":1.5E+2}'), ts: accepted('{"n":150}') };
    const marks = [mark("number-spelling"), mark("line-separator-escaping"), mark("key-order")];
    expect(usedMarks(run(c, spelled), marks).map((m) => m.kind)).toEqual(["number-spelling"]);
    expect(usedMarks(run(c, every(accepted('{"n":150}'))), marks)).toEqual([]);
  });

  it("fail a complete run when no variant needs them, and are left alone otherwise", () => {
    const c = validCase('{"n":1}');
    const list = variants(["strict"]);
    const results = Object.fromEntries(LANGUAGES.map((l) => [l, list.map(() => accepted('{"n":1}'))]));
    const marks = [mark("number-spelling")];
    expect(compareAll([c], list, results, marks, { complete: true })).toEqual([
      {
        case: "Order/valid/a",
        variant: null,
        field: "mark number-spelling",
        values: { expected: "no run needs this mark: the languages agree without it, so remove it" },
      },
    ]);
    expect(compareAll([c], list, results, marks, { complete: false })).toEqual([]);
  });

  it("pass when one variant needs them", () => {
    const c = invalidCase("[1,]", "/1", "invalid_json");
    const list = variants(["strict"]);
    const shared = rejected({ path: "/1", code: "invalid_json" });
    const go = list.map((v) => (v.entry === "public" ? rejected({ path: "", code: "json.SyntaxError" }) : shared));
    const results = { rust: list.map(() => shared), go, ts: list.map(() => shared) };
    expect(compareAll([c], list, results, [mark("go-unmarshal-syntax", { case: c.id })], { complete: true })).toEqual([]);
  });

  it("hold Go to json.Unmarshal's own error only for the normal decoder", () => {
    const c = invalidCase("[1,]", "/1", "invalid_json");
    const llm: Variant = { mode: "strict", decoder: "llm", entry: "public", maps: "both", shape: "entries" };
    const shared = rejected({ path: "/1", code: "invalid_json" });
    const syntax = rejected({ path: "", code: "json.SyntaxError" });
    const marks = [mark("go-unmarshal-syntax", { case: c.id })];
    expect(fields(compareRun(run(c, { rust: shared, go: syntax, ts: shared }, llm), marks))).toEqual(["path", "code", "message"]);
    expect(compareRun(run(c, { rust: shared, go: shared, ts: shared }, llm), marks)).toEqual([]);
  });

  it("covers every kind", () => {
    expect([...MARK_KINDS].sort()).toEqual([
      "go-unmarshal-syntax",
      "html-escaping",
      "key-order",
      "line-separator-escaping",
      "number-spelling",
      "string-escaping",
      "ts-no-bytes-api",
      "ts-unsafe-integer",
    ]);
  });
});

describe("one run over every case", () => {
  it("numbers requests by variant, then case, and puts each result back with its case", () => {
    const cases = [validCase('{"a":1}', "Order/valid/a"), invalidCase("{}", "/id", "missing_key")];
    const list = variants(["strict", "report"]);
    expect(list.map(variantName)).toEqual(["strict", "strict/registry", "report", "report/registry"]);
    const requests = requestsFor(cases, list);
    expect(requests.slice(0, 3).map((r) => [r.id, r.mode, r.entry, r.decoder, r.type, r.hex])).toEqual([
      [0, "strict", "public", "normal", "Order", "7b2261223a317d"],
      [1, "strict", "public", "normal", "Order", "7b7d"],
      [2, "strict", "registry", "normal", "Order", "7b2261223a317d"],
    ]);
    const good = list.flatMap(() => [accepted('{"a":1}'), rejected({ path: "/id", code: "missing_key" })]);
    const results = Object.fromEntries(LANGUAGES.map((l) => [l, good]));
    expect(compareAll(cases, list, results, [], { complete: true })).toEqual([]);
    const swapped = { ...results, go: good.map((r, i) => (i >= 6 ? (good[i % 2 === 0 ? i + 1 : i - 1] as Result) : r)) };
    expect(compareAll(cases, list, swapped, [], { complete: true }).map((r) => [r.case, r.variant && variantName(r.variant)])).toEqual([
      ["Order/valid/a", "report/registry"],
      ["Order/invalid/b", "report/registry"],
    ]);
  });
});

describe("the disagreement table", () => {
  it("has a column per language that ran and the expectation, padded to fit", () => {
    const rows: Disagreement[] = [
      { case: "Order/valid/a", variant: REPORT, field: "result", values: { rust: "accepted", ts: "rejected", expected: "accepted" } },
      { case: "Order/invalid/b", variant: { mode: "strict", decoder: "llm", entry: "registry" }, field: "code", values: { rust: "too_long", ts: "too_short" } },
      { case: "Order/invalid/b", variant: null, field: "mark key-order", values: { expected: "remove it" } },
    ];
    expect(table(rows, ["rust", "ts"])).toEqual([
      "case             variant              field           rust      ts         expected",
      "---------------  -------------------  --------------  --------  ---------  ---------",
      "Order/valid/a    report               result          accepted  rejected   accepted",
      "Order/invalid/b  strict/llm/registry  code            too_long  too_short",
      "Order/invalid/b  -                    mark key-order                       remove it",
    ]);
  });

  it("shows whole documents around their first difference, with the offset", () => {
    const long = `{"id":"${"x".repeat(80)}","n":1}`;
    const rows: Disagreement[] = [
      { case: "Order/valid/a", variant: STRICT, field: "encoded", values: { rust: long, go: long.replace('"n":1', '"n":2'), expected: long } },
    ];
    const at = long.indexOf('"n":1') + 4;
    expect(firstDifference([long, long.replace('"n":1', '"n":2')])).toBe(at);
    const line = table(rows, ["rust", "go"])[2] ?? "";
    expect(line).toContain(`@${String(at)} ...xxxxxx","n":1}`);
    expect(line).toContain(`@${String(at)} ...xxxxxx","n":2}`);
    expect(around("abcdef", 2, 1, 2)).toBe("@2 ...bcd...");
    expect(firstDifference(["ab", "ab"])).toBeUndefined();
    expect(firstDifference(["ab", "abc"])).toBe(2);
  });

  it("shows a character that isn't printable ASCII apart from its escape", () => {
    expect(cell(`a\n${String.fromCodePoint(0xe9, 0x1f600)}${LS}${BS}u2028`)).toBe("a<U+000A><U+00E9><U+1F600><U+2028>\\u2028");
    expect(cell("x".repeat(100), 10)).toBe("xxxxxxx...");
  });
});
