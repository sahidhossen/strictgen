import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { parseArguments } from "./args.js";
import type { Case } from "./cases.js";
import { expected, LayoutError, loadCases, loadMarks } from "./cases.js";
import { DriverError, parseResult, requestLine } from "./protocol.js";

const folders: string[] = [];
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

/** A cases folder with the given files, by path below it. */
function folder(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "strictgen-cases-"));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const TYPES = new Set(["Order", "Line"]);

function problems(files: Readonly<Record<string, string>>): readonly string[] {
  try {
    loadCases(folder(files), TYPES);
  } catch (error) {
    if (error instanceof LayoutError) return error.problems;
    throw error;
  }
  return [];
}

describe("reading the cases folder", () => {
  it("reads valid cases, and invalid ones with their expectation for each mode", () => {
    const cases = loadCases(
      folder({
        "Order/valid/minimal.json": '{"id":"o"}',
        "Order/invalid/no-id.json": "{}",
        "Order/invalid/no-id.expect.json": '{"path": "/id", "code": "missing_key"}',
        "Order/invalid/extra.json": '{"id":"o","x":1}',
        "Order/invalid/extra.expect.json": '{"path": "/x", "code": "unknown_key", "report": {"unknown": ["/x"]}}',
        "Line/invalid/extra-then-short.json": '{"x":1,"n":""}',
        "Line/invalid/extra-then-short.expect.json":
          '{"path": "/x", "code": "unknown_key", "report": {"path": "/n", "code": "too_short"}}',
      }),
      TYPES,
    );
    const by = (id: string): Case => cases.find((c) => c.id === id) ?? expect.fail(id);
    expect(cases.map((c) => c.id)).toEqual([
      "Line/invalid/extra-then-short",
      "Order/invalid/extra",
      "Order/invalid/no-id",
      "Order/valid/minimal",
    ]);
    expect(expected(by("Order/valid/minimal"), "report")).toEqual({ accepted: true, unknown: [] });
    expect(expected(by("Order/invalid/no-id"), "strict")).toEqual({ accepted: false, path: "/id", code: "missing_key" });
    expect(expected(by("Order/invalid/no-id"), "report")).toEqual({ accepted: false, path: "/id", code: "missing_key" });
    expect(expected(by("Order/invalid/extra"), "report")).toEqual({ accepted: true, unknown: ["/x"] });
    expect(expected(by("Line/invalid/extra-then-short"), "report")).toEqual({ accepted: false, path: "/n", code: "too_short" });
    expect(new TextDecoder().decode(by("Order/valid/minimal").bytes)).toBe('{"id":"o"}');
  });

  it("fails on anything outside the layout, naming every problem", () => {
    expect(
      problems({
        "Order/valid/ok.json": "{}",
        "Order/valid/ok.expect.json": '{"path": "", "code": "wrong_type"}',
        "Order/invalid/lonely.expect.json": '{"path": "", "code": "wrong_type"}',
        "Order/invalid/no-expect.json": "{}",
        "Order/vaild/typo.json": "{}",
        "Order/stray.json": "{}",
        "Order/valid/Upper.json": "{}",
        "Order/valid/notes.txt": "",
        "Order/valid/nested/deep.json": "{}",
        "Unknown/valid/x.json": "{}",
        "README.md": "",
      }),
    ).toEqual([
      "Order/invalid/lonely.expect.json: no invalid case next to it",
      "Order/invalid/no-expect.json: every invalid case needs no-expect.expect.json",
      "Order/stray.json: only valid and invalid folders belong here",
      "Order/vaild: only valid and invalid folders belong here",
      "Order/valid/Upper.json: a case is <lowercase-name>.json, in letters, digits and dashes",
      "Order/valid/nested: only case files belong here",
      "Order/valid/notes.txt: a case is <lowercase-name>.json, in letters, digits and dashes",
      "Order/valid/ok.expect.json: no invalid case next to it",
      "README.md: a file where a type folder should be",
      "Unknown: no generated type has this name",
    ]);
  });

  it.each([
    ["not JSON", "{", "Order/invalid/a.expect.json: "],
    ["an array", "[]", 'expected {"path": ..., "code": ...}'],
    ["no code", '{"path": "/a"}', "path and code must be strings"],
    ["a code that isn't one", '{"path": "/a", "code": "too_big"}', 'code "too_big" is not an error code'],
    ["a path that isn't a pointer", '{"path": "a", "code": "too_long"}', 'path "a" is not a JSON Pointer'],
    ["an extra key", '{"path": "", "code": "too_long", "found": "x"}', 'unexpected key "found"'],
    ["a bad report", '{"path": "", "code": "too_long", "report": []}', "report must be"],
    ["a report with both", '{"path": "", "code": "unknown_key", "report": {"unknown": [], "path": ""}}', "report must be"],
    ["a report path list of non-pointers", '{"path": "/x", "code": "unknown_key", "report": {"unknown": ["x"]}}', "JSON Pointer to a key"],
    ["a bad report error", '{"path": "", "code": "too_long", "report": {"path": "", "code": "nope"}}', 'report: code "nope"'],
  ])("fails on an expectation with %s", (_what, text, why) => {
    const found = problems({ "Order/invalid/a.json": "{}", "Order/invalid/a.expect.json": text });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(why);
  });

  it("fails on a missing or empty folder", () => {
    expect(() => loadCases(join(tmpdir(), "strictgen-no-such-folder"), TYPES)).toThrow("no cases folder");
    expect(() => loadCases(folder({}), TYPES)).toThrow("no cases");
  });
});

describe("reading the marks", () => {
  const cases = loadCases(folder({ "Order/valid/big.json": '{"n":9007199254740993}', "Order/valid/n.json": '{"n":1e2}' }), TYPES);
  const marks = (text: string): ReturnType<typeof loadMarks> => {
    const root = folder({ "marks.json": text });
    return loadMarks(join(root, "marks.json"), cases);
  };

  it("reads each mark with its reason", () => {
    expect(
      marks(
        JSON.stringify({
          marks: [
            { case: "Order/valid/big", kind: "ts-unsafe-integer", path: "/n", reason: "TS numbers" },
            { case: "Order/valid/n", kind: "number-spelling", reason: "spelling" },
          ],
        }),
      ),
    ).toEqual([
      { case: "Order/valid/big", kind: "ts-unsafe-integer", path: "/n", reason: "TS numbers" },
      { case: "Order/valid/n", kind: "number-spelling", reason: "spelling" },
    ]);
  });

  it.each([
    [{ case: "Order/valid/none", kind: "number-spelling", reason: "r" }, 'case "Order/valid/none" is not a case'],
    [{ case: "Order/valid/n", kind: "skip", reason: "r" }, "kind must be one of"],
    [{ case: "Order/valid/n", kind: "number-spelling" }, "every mark needs a reason"],
    [{ case: "Order/valid/n", kind: "number-spelling", reason: " " }, "every mark needs a reason"],
    [{ case: "Order/valid/big", kind: "ts-unsafe-integer", reason: "r" }, "needs the path"],
    [{ case: "Order/valid/n", kind: "number-spelling", path: "/n", reason: "r" }, "only ts-unsafe-integer takes a path"],
    [{ case: "Order/valid/n", kind: "number-spelling", reason: "r", note: "x" }, "unexpected key note"],
  ])("fails on %j", (mark, why) => {
    expect(() => marks(JSON.stringify({ marks: [mark] }))).toThrow(why);
  });

  it("fails on the same mark twice, a bad file and a missing file", () => {
    const twice = { case: "Order/valid/n", kind: "number-spelling", reason: "r" };
    expect(() => marks(JSON.stringify({ marks: [twice, twice] }))).toThrow("marked number-spelling twice");
    expect(() => marks('{"marks": {}}')).toThrow('expected {"marks": [...]}');
    expect(() => marks('{"marks": [], "x": 1}')).toThrow('expected {"marks": [...]}');
    expect(() => marks("{")).toThrow("marks.json");
    expect(() => loadMarks(join(tmpdir(), "strictgen-no-marks.json"), cases)).toThrow("no marks file");
  });
});

describe("driver results", () => {
  const ok = { id: 3, accepted: true, error: null, unknown: [], encoded: "{}", encodeError: null };
  const bad = {
    id: 3,
    accepted: false,
    error: { path: "/a", code: "too_long", expected: "at most 1", found: null, message: "/a: too long" },
    unknown: null,
    encoded: null,
    encodeError: null,
  };

  it("reads accepted and rejected results", () => {
    expect(parseResult(JSON.stringify(ok), "go", 3)).toEqual(ok);
    expect(parseResult(JSON.stringify(bad), "go", 3)).toEqual(bad);
    const failed = { ...ok, encoded: null, encodeError: "no" };
    expect(parseResult(JSON.stringify(failed), "go", 3)).toEqual(failed);
  });

  it.each([
    ["not JSON", "{"],
    ["another id", JSON.stringify({ ...ok, id: 4 })],
    ["a missing key", JSON.stringify({ id: 3, accepted: true, error: null, unknown: [], encoded: "{}" })],
    ["an extra key", JSON.stringify({ ...ok, extra: 1 })],
    ["an accepted result with an error", JSON.stringify({ ...ok, error: bad.error })],
    ["an accepted result without unknown paths", JSON.stringify({ ...ok, unknown: null })],
    ["an accepted result with encoded and encodeError", JSON.stringify({ ...ok, encodeError: "x" })],
    ["a rejected result with unknown paths", JSON.stringify({ ...bad, unknown: [] })],
    ["an error without its message", JSON.stringify({ ...bad, error: { ...bad.error, message: undefined } })],
    ["an error with a number for found", JSON.stringify({ ...bad, error: { ...bad.error, found: 1 } })],
  ])("fails on %s", (_what, line) => {
    expect(() => parseResult(line, "rust", 3)).toThrow(DriverError);
  });

  it("writes requests with a fixed key order", () => {
    expect(requestLine({ hex: "7b7d", decoder: "normal", mode: "report", type: "Order", id: 1 })).toBe(
      '{"id":1,"type":"Order","mode":"report","decoder":"normal","hex":"7b7d"}',
    );
  });
});

describe("the command line", () => {
  it("runs both modes and every language by default", () => {
    expect(parseArguments([])).toEqual({ modes: ["strict", "report"], languages: ["rust", "go", "ts"], keep: false });
  });

  it("takes a mode, languages in any order and --keep", () => {
    expect(parseArguments(["--mode", "report", "--lang=ts,rust", "--keep"])).toEqual({
      modes: ["report"],
      languages: ["rust", "ts"],
      keep: true,
    });
    expect(parseArguments(["--mode=both"])).toMatchObject({ modes: ["strict", "report"] });
  });

  it.each([
    [["--mode"], "--mode needs a value"],
    [["--mode", "lax"], "--mode is strict, report or both, not lax"],
    [["--lang", "rust,java"], "--lang takes rust, go, ts, not java"],
    [["--lang="], "--lang needs a value"],
    [["--mode", "strict", "--mode", "report"], "--mode is given twice"],
    [["--keep=yes"], "unknown argument --keep=yes"],
    [["fast"], "unknown argument fast"],
  ])("refuses %j", (args, why) => {
    expect(parseArguments(args)).toBe(why);
  });
});
