import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Case, Manifest } from "./cases.js";
import { LayoutError } from "./cases.js";
import { compareRun } from "./compare.js";
import { conformanceModel } from "./drivers.js";
import type { Language, Result, Variant } from "./protocol.js";
import { checkLlmExclusions, llmExclusions } from "./suite.js";
import { compactOf, loadCleanupVectors, loadLlmVectors, parseCompact } from "./vectors.js";

const ROOT = join(import.meta.dirname, "..", "..");
const CONFORMANCE = join(ROOT, "conformance");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "strictgen-vectors-"));
  dirs.push(dir);
  return dir;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the compact form of an error", () => {
  it.each([
    ["missing_key", { path: "", code: "missing_key" }],
    ['wrong_type, expected an object, found "paid"', { path: "", code: "wrong_type" }],
    ["/labels/0/key duplicate_key, found \"a\"", { path: "/labels/0/key", code: "duplicate_key" }],
    // A key may hold a space; the path ends before the code.
    ["/a b/c too_long, expected at most 3 characters, found 4 characters", { path: "/a b/c", code: "too_long" }],
    ["/x unknown_key", { path: "/x", code: "unknown_key" }],
  ])("%s", (compact, want) => {
    expect(parseCompact(compact)).toEqual(want);
  });

  it("is refused when it names no code", () => {
    expect(parseCompact("/x nothing")).toBeUndefined();
    expect(parseCompact("too_longer")).toBeUndefined();
  });

  it("is written from the fields as every language writes it", () => {
    expect(compactOf({ path: "", code: "missing_key", expected: null, found: null })).toBe("missing_key");
    expect(compactOf({ path: "/a", code: "too_small", expected: ">= 0", found: "-5" })).toBe("/a too_small, expected >= 0, found -5");
    expect(compactOf({ path: "/a", code: "bad_tag", expected: null, found: '"x"' })).toBe('/a bad_tag, found "x"');
  });
});

describe("the shared vectors of examples/llm", () => {
  it("load as cases, the normal JSON of each valid one too", () => {
    const { llm, normal } = loadLlmVectors(join(ROOT, "examples", "llm"));
    expect(llm.length).toBeGreaterThan(1000);
    expect(normal.length).toBe(llm.filter((c) => c.valid).length);
    expect(llm.every((c) => (c.valid ? c.encodes !== undefined : c.compact !== undefined))).toBe(true);
    const cleanup = loadCleanupVectors(join(ROOT, "examples", "llm"));
    expect(cleanup.length).toBeGreaterThan(60);
    expect(cleanup.every((c) => typeof c.cleaned === "string")).toBe(true);
  });

  it("fail the run when a vector is broken", () => {
    const dir = scratch();
    const lone = String.fromCharCode(0xd800);
    writeFileSync(
      join(dir, "llm-vectors.json"),
      JSON.stringify([
        { name: "a", type: "T", llm: "{}" },
        { name: "b", type: "T", llm: "{}", error: "/x nothing" },
        { name: "c", type: "T", llm: `"${lone}"`, json: "1" },
      ]),
    );
    expect(() => loadLlmVectors(dir)).toThrow(LayoutError);
    expect(() => loadLlmVectors(dir)).toThrow(/vector 0: needs json for a valid vector[\s\S]*vector 1: "\/x nothing" is not the compact form[\s\S]*vector 2: text with a lone surrogate/);
    writeFileSync(join(dir, "cleanup-vectors.json"), JSON.stringify([{ name: "a", input: "x" }, { name: "b", input: "x", output: "y", extra: 1 }]));
    expect(() => loadCleanupVectors(dir)).toThrow(/vector 0: needs exactly a name, an input and an output[\s\S]*vector 1/);
    writeFileSync(join(dir, "cleanup-vectors.json"), "[]");
    expect(() => loadCleanupVectors(dir)).toThrow("expected a list of vectors");
  });
});

describe("comparing the cleanup step and the compact form", () => {
  const cleanup: Variant = { mode: "report", decoder: "cleanup", entry: "public", vectors: true };
  const text = (encoded: string): Result => ({ id: 0, accepted: true, error: null, unknown: [], encoded, encodeError: null });
  const c: Case = {
    id: "examples/llm/cleanup-vectors.json/0",
    type: "",
    valid: true,
    bytes: bytes("```json\n{}\n```"),
    strict: { accepted: true, unknown: [] },
    report: { accepted: true, unknown: [] },
    cleaned: "{}",
  };

  it("holds every language to the exact output", () => {
    const every = (r: Result): Record<Language, Result> => ({ rust: r, go: r, ts: r });
    expect(compareRun({ case: c, variant: cleanup, results: every(text("{}")) }, [])).toEqual([]);
    const rows = compareRun({ case: c, variant: cleanup, results: { ...every(text("{}")), go: text("{ }") } }, []);
    expect(rows.map((r) => [r.field, r.values])).toEqual([["cleaned", { rust: "{}", go: "{ }", ts: "{}", expected: "{}" }]]);
  });

  it("holds every language to a vector's compact form, and to the strict error in report mode", () => {
    const llm: Variant = { mode: "report", decoder: "llm", entry: "public", vectors: true };
    const v: Case = {
      id: "examples/llm/llm-vectors.json/0",
      type: "T",
      valid: false,
      bytes: bytes("{}"),
      strict: { accepted: false, path: "/value", code: "missing_key" },
      report: { accepted: true, unknown: [] },
      compact: "/value missing_key",
    };
    const error = (found: string | null): Result => ({
      id: 0,
      accepted: false,
      error: { path: "/value", code: "missing_key", expected: null, found, message: "/value: missing key" },
      unknown: null,
      encoded: null,
      encodeError: null,
    });
    expect(compareRun({ case: v, variant: llm, results: { rust: error(null), go: error(null), ts: error(null) } }, [])).toEqual([]);
    const rows = compareRun({ case: v, variant: llm, results: { rust: error("x"), go: error("x"), ts: error("x") } }, []);
    expect(rows.map((r) => r.field)).toEqual(["compact"]);
  });

  it("checks the LLM value against the normal JSON of the case, not the payload", () => {
    const llm: Variant = { mode: "strict", decoder: "llm", entry: "public", maps: "both", shape: "entries" };
    const { cleaned: _, ...rest } = c;
    const v: Case = { ...rest, id: "Order/valid/a", type: "Order", bytes: bytes('{"m":[{"key":"a","value":1}]}'), encodes: bytes('{"m":{"a":1}}') };
    const r = text('{"m":{"a":1}}');
    expect(compareRun({ case: v, variant: llm, results: { rust: r, go: r, ts: r } }, [])).toEqual([]);
    const wrong = text('{"m":[{"key":"a","value":1}]}');
    expect(compareRun({ case: v, variant: llm, results: { rust: wrong, go: wrong, ts: wrong } }, []).map((x) => x.field)).toEqual(["encoded"]);
  });
});

describe("the schema files the LLM packages leave out", () => {
  const manifest = (llm: Record<string, string>): Manifest => ({ types: new Map(), empty: new Map(), llm: new Map(Object.entries(llm)), coverage: new Map() });

  it("are the ones whose types no provider-ready schema can describe", () => {
    const model = conformanceModel(CONFORMANCE, scratch());
    expect([...llmExclusions(CONFORMANCE, model).keys()]).toEqual(["bundle.json", "promotion.json", "shipment.json", "shop-order.json"]);
  });

  it("must all be listed in the manifest with a reason, and only they", () => {
    const dir = scratch();
    cpSync(join(CONFORMANCE, "schemas"), join(dir, "schemas"), { recursive: true });
    const model = conformanceModel(dir, scratch());
    const all = { "bundle.json": "x", "promotion.json": "x", "shipment.json": "x", "shop-order.json": "x" };
    expect(() => checkLlmExclusions(dir, model, manifest(all))).not.toThrow();
    expect(() => checkLlmExclusions(dir, model, manifest({ "bundle.json": "x", "promotion.json": "x", "shipment.json": "x" }))).toThrow(
      /shop-order\.json: no LLM decoder can be generated \(.*\), so list it under "llm" in manifest\.json with the reason/,
    );
    expect(() => checkLlmExclusions(dir, model, manifest({ ...all, "order.json": "x" }))).toThrow(
      "manifest.json: llm order.json projects under every profile now, so remove it",
    );
    expect(() => checkLlmExclusions(dir, model, manifest({ ...all, "gone.json": "x" }))).toThrow("manifest.json: llm gone.json is not a schema file");
  });
});

describe("the script that writes generated cases", () => {
  it("has written every case it makes, as committed", () => {
    const script = join(ROOT, "scripts", "conformance-cases.mjs");
    expect(() => execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});
