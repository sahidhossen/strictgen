import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Random } from "../payloads.js";
import type { Json } from "./canonical.js";
import { JsonNumber, parseJson } from "./canonical.js";
import type { Case } from "./cases.js";
import { MARK_KINDS } from "./cases.js";
import type { Driver } from "./drivers.js";
import { typeScriptDriver } from "./drivers.js";
import { parseFuzzArguments } from "./fuzz-args.js";
import type { FuzzOptions } from "./fuzz.js";
import { asciiJson, bumpManifest, cleanupInput, failureLines, fuzzMarks, runFuzz, runSeed, shrink, signature, treeCandidates } from "./fuzz.js";
import { variantName } from "./protocol.js";
import { writeJson } from "./walk.js";

const ROOT = join(import.meta.dirname, "..", "..");

const fuzzCase = (text: string, valid = true): Case => {
  const outcome = { accepted: true, unknown: [] } as const;
  return { id: "fuzz/0/T/valid", type: "T", valid, bytes: new TextEncoder().encode(text), strict: outcome, report: outcome };
};

describe("fuzz runs", () => {
  it("seed each run from the run seed and its index alone", () => {
    expect(runSeed(1, 5)).toBe(runSeed(1, 5));
    expect(new Set([runSeed(1, 0), runSeed(1, 1), runSeed(2, 0), runSeed(2, 1)]).size).toBe(4);
  });
});

describe("cleanup inputs", () => {
  /** The cleanup step of docs/llm.md, for the test: what the generated helpers do. */
  async function cleanup(): Promise<(text: string) => string> {
    const { TS_CLEANUP } = await import("../cleanup-helpers.js");
    const ts = await import("typescript");
    const js = ts.default.transpileModule(TS_CLEANUP, { compilerOptions: { target: ts.default.ScriptTarget.ES2023, module: ts.default.ModuleKind.ESNext } }).outputText;
    const dir = mkdtempSync(join(tmpdir(), "strictgen-cleanup-"));
    try {
      writeFileSync(join(dir, "cleanup.mjs"), js);
      const module = (await import(join(dir, "cleanup.mjs"))) as { cleanLlmJson: (text: string) => string };
      return module.cleanLlmJson;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("clean back to exactly the payload, with every kind of change made somewhere", async () => {
    const clean = await cleanup();
    const random = new Random(9);
    const payloads = ['{"a":[1,{"b":"x,}]"}],"c":{}}', "[]", '"text"', "12", '{"q":"\\"]"}'];
    const seen = { bom: false, fence: false, comma: false };
    for (let i = 0; i < 400; i++) {
      const text = payloads[i % payloads.length] ?? "";
      const input = cleanupInput(text, random);
      expect(clean(input), JSON.stringify(input)).toBe(text);
      if (input.startsWith("\u{feff}")) seen.bom = true;
      if (input.includes("```")) seen.fence = true;
      if (/,\s*[\]}]/.test(input)) seen.comma = true;
    }
    expect(seen).toEqual({ bom: true, fence: true, comma: true });
  });
});

describe("fuzz marks", () => {
  const kinds = (text: string, valid = true): string[] => fuzzMarks(fuzzCase(text, valid)).map((m) => (m.path === undefined ? m.kind : `${m.kind} ${m.path}`));

  it("apply only where their difference can happen", () => {
    expect(kinds('{"a":"plain","n":12}')).toEqual([]);
    expect(kinds('{"a":"<b>"}')).toEqual(["html-escaping"]);
    expect(kinds(`{"a":"${String.fromCharCode(0x2028)}"}`)).toEqual(["line-separator-escaping"]);
    expect(kinds('{"n":1e-7}')).toEqual(["number-spelling"]);
    expect(kinds('{"n":1.5}')).toEqual(["number-spelling"]);
    expect(kinds('{"n":[1,9007199254740992]}')).toEqual(["ts-unsafe-integer /n/1"]);
    expect(kinds('{"n":-9007199254740992}')).toEqual(["ts-unsafe-integer /n"]);
    expect(kinds('{"n":9007199254740991}')).toEqual([]);
  });

  it("apply to invalid payloads too, which report mode may accept with an unknown key", () => {
    expect(kinds('{"a":"&","x":1}', false)).toEqual(["html-escaping"]);
  });

  it("never apply the kinds the generator's payloads can't need", () => {
    const never = ["string-escaping", "key-order", "ts-no-bytes-api", "go-unmarshal-syntax"];
    expect(MARK_KINDS.filter((k) => !never.includes(k)).sort()).toEqual(["html-escaping", "line-separator-escaping", "number-spelling", "ts-unsafe-integer"]);
  });
});

describe("shrinking", () => {
  const texts = (value: string): string[] => treeCandidates(parseJson(value)).map(writeJson);

  it("removes keys and items, shortens strings and keys, and simplifies numbers, outer values first", () => {
    expect(texts('{"a":[1,2],"b":"xy"}')).toEqual([
      '{"b":"xy"}',
      '{"a":[1,2]}',
      '{"a":[2],"b":"xy"}',
      '{"a":[1],"b":"xy"}',
      '{"a":[0,2],"b":"xy"}',
      '{"a":[1,0],"b":"xy"}',
      '{"a":[1,1],"b":"xy"}',
      '{"":[1,2],"b":"xy"}',
      '{"a":[1,2],"b":""}',
      '{"a":[1,2],"b":"x"}',
      '{"a":[1,2],"b":"y"}',
      '{"a":[1,2],"":"xy"}',
    ]);
    // Zero, one, the integer part, no exponent, a digit fewer in the fraction or the integer part, no sign.
    expect(texts("-12.50e3")).toEqual(["0", "1", "-12", "-12.50", "-12.5", "-1", "12.50e3"]);
    expect(texts("true")).toEqual(["false"]);
  });

  it("keeps every number a JSON number", () => {
    for (const t of texts("[-0.5e-3, 123, 10.25]")) expect(() => parseJson(t)).not.toThrow();
    expect(treeCandidates(new JsonNumber("7") as Json).every((v) => v instanceof JsonNumber)).toBe(true);
  });

  it("keeps a failure only by the fields the languages disagree on", () => {
    const v = { mode: "strict", decoder: "normal", entry: "public" } as const;
    expect(
      signature([
        { case: "c", variant: v, field: "result", values: { rust: "accepted", go: "rejected", expected: "rejected" } },
        { case: "c", variant: v, field: "code", values: { rust: "too_long", go: "too_long", expected: "too_short" } },
      ]),
    ).toEqual(["result"]);
  });
});

describe("shrinking a failure", () => {
  /** Two stand-in languages: one accepts everything, the other rejects any string with a ! in it. */
  const fake = (language: "rust" | "go"): Driver => ({
    language,
    run: (requests) =>
      requests.map((r) => {
        const text = Buffer.from(r.hex, "hex").toString();
        return language === "go" && text.includes("!")
          ? { id: r.id, accepted: false, error: { path: "", code: "wrong_type", expected: null, found: null, message: "wrong type" }, unknown: null, encoded: null, encodeError: null }
          : { id: r.id, accepted: true, error: null, unknown: [], encoded: text, encodeError: null };
      }),
  });
  const start = parseJson('{"a":[1,2,{"b":"xx!yy","d":true}],"c":"zz"}');
  const job = { case: fuzzCase(writeJson(start)), variant: { mode: "strict", decoder: "normal", entry: "public" } as const, marks: [] };
  const space = { kind: "tree", start, render: (c: Json | string) => writeJson(c as Json), normal: true } as const;

  it("keeps the smallest payload that disagrees the same way, the same every time", () => {
    const shrunk = shrink([fake("rust"), fake("go")], job, space);
    expect(shrunk?.text).toBe('{"":[{"":"!"}]}');
    expect(shrunk?.steps).toBeGreaterThan(5);
    expect(signature(shrunk?.rows ?? [])).toEqual(["result"]);
    expect(shrink([fake("rust"), fake("go")], job, space)?.text).toBe(shrunk?.text);
  });

  it("gives up when the languages agree without the expectation", () => {
    expect(shrink([fake("rust"), fake("rust")], job, space)).toBeUndefined();
  });
});

describe("saving a case", () => {
  it("bumps one type's count in manifest.json, keeping its layout", () => {
    const text = '{\n  "types": {\n    "Code": {"valid": 2, "invalid": 5},\n    "Codes": {"valid": 2, "invalid": 4}\n  }\n}\n';
    expect(bumpManifest(text, "Codes", "invalid")).toBe(text.replace('"invalid": 4', '"invalid": 5'));
    expect(bumpManifest(text, "Code", "valid")).toBe(text.replace('"Code": {"valid": 2', '"Code": {"valid": 3'));
    expect(bumpManifest(text, "Other", "valid")).toBeUndefined();
  });
});

describe("the fuzz command line", () => {
  it("takes a seed, a start, runs, languages and the language to save with", () => {
    expect(parseFuzzArguments([])).toEqual({ seed: undefined, start: 0, runs: 1000, languages: ["rust", "go", "ts"], save: undefined });
    expect(parseFuzzArguments(["--seed", "7", "--runs=20", "--start", "3", "--lang", "ts,go", "--save", "go"])).toEqual({
      seed: 7,
      start: 3,
      runs: 20,
      languages: ["go", "ts"],
      save: "go",
    });
  });

  it.each([
    [["--seed", "-1"], "--seed takes an integer from 0 to 4294967295, not -1"],
    [["--seed", "4294967296"], "--seed takes an integer from 0 to 4294967295, not 4294967296"],
    [["--runs", "0"], "--runs takes 1 at least"],
    [["--runs", "1.5"], "--runs takes an integer"],
    [["--lang", "ts"], "--lang needs two languages at least"],
    [["--lang", "ts,java"], "--lang takes rust, go, ts, not java"],
    [["--save"], "--save needs a value"],
    [["--save", "--runs", "3"], "--save needs a value"],
    [["--save", "go,ts"], "--save takes one language"],
    [["--lang", "rust,ts", "--save", "go"], "--save go needs go in --lang"],
    [["--seed", "1", "--seed", "2"], "--seed is given twice"],
    [["--keep"], "unknown argument --keep"],
  ])("refuses %j", (args, why) => {
    expect(parseFuzzArguments(args)).toContain(why);
  });
});

describe("printing", () => {
  it("shows any text as printable ASCII JSON", () => {
    expect(asciiJson(`a"${String.fromCharCode(0x2028)}${String.fromCodePoint(0x1f600)}`)).toBe('"a\\"\\u2028\\ud83d\\ude00"');
  });
});

/** How long a fuzz run over the conformance schemas takes here, generating and loading the TypeScript twice. */
const FUZZ_TIMEOUT = 240_000;

describe("the fuzzer against a deliberately broken emitter", () => {
  // A copy of the conformance folder, with examples/llm beside it, so a saved case lands there.
  const scratch = mkdtempSync(join(tmpdir(), "strictgen-fuzz-test-"));
  const conformance = join(scratch, "conformance");
  cpSync(join(ROOT, "conformance"), conformance, { recursive: true, filter: (src) => !src.includes(`${join("driver", "rust", "target")}`) });
  cpSync(join(ROOT, "examples", "llm"), join(scratch, "examples", "llm"), { recursive: true, filter: (src) => !/[/\\](target|node_modules)$/.test(src) });
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /**
   * Two TypeScript drivers standing in for two languages: the generated code as it is, called
   * rust, and a copy whose count check lets one item, key or character too many through, as an
   * emitter with an off by one would, called ts.
   */
  const drivers =
    (broken: boolean | string): NonNullable<FuzzOptions["drivers"]> =>
    (out, packages): Driver[] => {
      const copy = join(out, "broken");
      cpSync(join(out, "ts"), join(copy, "ts"), { recursive: true });
      if (broken !== false) {
        // Every package, or only the one named.
        for (const p of packages.filter((x) => broken === true || x.name === broken)) {
          const file = join(copy, "ts", p.name, "helpers.ts");
          const text = readFileSync(file, "utf8");
          expect(text).toContain("if (max !== undefined && n > max) {");
          writeFileSync(file, text.replace("if (max !== undefined && n > max) {", "if (max !== undefined && n > max + 1) {"));
        }
      }
      return [{ ...typeScriptDriver(out, packages), language: "rust" }, typeScriptDriver(copy, packages)];
    };
  const options = (broken: boolean | string, save?: "rust"): FuzzOptions => ({
    conformance,
    seed: 3,
    runs: 60,
    batch: 30,
    languages: ["rust", "ts"],
    log: () => undefined,
    drivers: drivers(broken),
    ...(save === undefined ? {} : { save }),
  });

  it("finds the bug, shrinks it the same way every time, and saves it with the right language's answer", { timeout: FUZZ_TIMEOUT }, async () => {
    const first = await runFuzz(options(true));
    const failure = first.failure;
    expect(failure).toBeDefined();
    if (failure?.shrunk === undefined) throw new Error("no shrunk failure");
    // The broken copy accepts what the generator labelled too_long.
    expect(failure.rows.map((r) => r.field)).toContain("result");
    expect(signature(failure.shrunk.rows)).toEqual(signature(failure.rows));
    expect(failure.shrunk.text.length).toBeLessThanOrEqual(new TextDecoder().decode(failure.case.bytes).length);
    const lines = failureLines(3, failure, ["rust", "ts"]).join("\n");
    expect(lines).toContain(`run ${String(failure.run)} of seed 3`);
    expect(lines).toContain("payload (hex):");
    expect(lines).toContain(`pnpm fuzz --seed 3 --start ${String(failure.run)} --runs 1`);

    const again = await runFuzz(options(true, "rust"));
    expect(again.failure?.shrunk?.text).toBe(failure.shrunk.text);
    const saved = again.failure?.saved;
    if (saved === undefined) throw new Error("not saved");
    const [type, kind, name] = saved.split("/");
    expect(kind).toBe("invalid");
    const dir = join(conformance, "cases", type ?? "", "invalid");
    expect(readFileSync(join(dir, name ?? ""), "utf8")).toBe(`${failure.shrunk.payload ?? ""}\n`);
    expect(JSON.parse(readFileSync(join(dir, (name ?? "").replace(/\.json$/, ".expect.json")), "utf8"))).toMatchObject({ code: "too_long" });
    expect(name).toMatch(/^fuzz-[0-9a-f]{12}\.json$/);
    const manifest = readFileSync(join(conformance, "manifest.json"), "utf8");
    expect(manifest).not.toBe(readFileSync(join(ROOT, "conformance", "manifest.json"), "utf8"));

    // Saving the same case again writes nothing.
    const before = readdirSync(dir).length;
    const third = await runFuzz(options(true, "rust"));
    expect(third.failure?.saved).toBeUndefined();
    expect(readdirSync(dir).length).toBe(before);
    expect(existsSync(join(dir, name ?? ""))).toBe(true);
  });

  it("shrinks a failure of the LLM decoders in normal JSON, and saves that", { timeout: FUZZ_TIMEOUT }, async () => {
    // Only the code that reads maps as objects is broken, which only its LLM decoders read.
    const lines: string[] = [];
    // A seed of its own, so it doesn't shrink to the case the test above saved.
    const result = await runFuzz({ ...options("strict_llm_objects", "rust"), runs: 200, batch: 100, seed: 11, log: (l) => void lines.push(l) });
    const failure = result.failure;
    if (failure?.shrunk?.payload === undefined) throw new Error("no shrunk failure in normal JSON");
    expect(variantName(failure.variant)).toBe("strict/llm/objects");
    const saved = failure.saved;
    if (saved === undefined) throw new Error(`not saved: ${lines.join("; ")} ${failure.shrunk.payload} ${failure.shrunk.text}`);
    // The case holds the payload in normal JSON; the suite projects it to the LLM form itself.
    expect(readFileSync(join(conformance, "cases", saved), "utf8")).toBe(`${failure.shrunk.payload}\n`);
  });

  it("passes when nothing is broken", { timeout: FUZZ_TIMEOUT }, async () => {
    const result = await runFuzz({ ...options(false), runs: 30 });
    expect(result.failure).toBeUndefined();
    expect(result.requests).toBeGreaterThan(30 * 10);
  });
});
