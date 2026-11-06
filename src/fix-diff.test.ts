import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { unifiedDiff } from "./fix-diff.js";

const lines = (n: number): string =>
  Array.from({ length: n }, (_, i) => `line ${String(i + 1)}\n`).join("");

describe("unifiedDiff", () => {
  it("is empty for equal texts", () => {
    expect(unifiedDiff("a.json", "x\n", "x\n")).toEqual([]);
  });

  it("shows a change with three lines of context", () => {
    const before = lines(10);
    const after = before.replace("line 5\n", "line five\n");
    expect(unifiedDiff("schemas/a.json", before, after)).toEqual([
      "--- a/schemas/a.json",
      "+++ b/schemas/a.json",
      "@@ -2,7 +2,7 @@",
      " line 2",
      " line 3",
      " line 4",
      "-line 5",
      "+line five",
      " line 6",
      " line 7",
      " line 8",
    ]);
  });

  it("splits changes far apart into hunks, and joins close ones", () => {
    const before = lines(20);
    const after = before.replace("line 2\n", "two\n").replace("line 18\n", "");
    const diff = unifiedDiff("a.json", before, after);
    expect(diff.filter((l) => l.startsWith("@@"))).toEqual([
      "@@ -1,5 +1,5 @@",
      "@@ -15,6 +15,5 @@",
    ]);
    const close = before.replace("line 2\n", "two\n").replace("line 8\n", "eight\n");
    expect(unifiedDiff("a.json", before, close).filter((l) => l.startsWith("@@"))).toEqual([
      "@@ -1,11 +1,11 @@",
    ]);
  });

  it("adds lines at the end and into an empty file", () => {
    expect(unifiedDiff("a.json", "a\n", "a\nb\n")).toEqual([
      "--- a/a.json",
      "+++ b/a.json",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
    ]);
    expect(unifiedDiff("a.json", "", "a\n")).toEqual([
      "--- a/a.json",
      "+++ b/a.json",
      "@@ -0,0 +1 @@",
      "+a",
    ]);
  });

  it("marks a last line without a newline", () => {
    expect(unifiedDiff("a.json", "a\nb", "a\nb\n")).toEqual([
      "--- a/a.json",
      "+++ b/a.json",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+b",
    ]);
  });

  it("finds a short script through many lines", () => {
    const before = lines(3000);
    const after = before.replace("line 1500\n", "").replace("line 10\n", "line 10\nnew\n");
    const diff = unifiedDiff("a.json", before, after);
    expect(diff.filter((l) => /^[-+][^-+]/.test(l))).toEqual(["+new", "-line 1500"]);
  });

  it("gives patches that a patch tool applies, for many random edits", () => {
    // A seeded generator, so a failure repeats.
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const NL = String.fromCharCode(10);
    const end = (lines: readonly string[], final: boolean): string =>
      lines.length === 0 ? "" : `${lines.join(NL)}${final ? NL : ""}`;
    const dir = mkdtempSync(join(tmpdir(), "strictgen-diff-"));
    try {
      for (let round = 0; round < 40; round++) {
        const before = Array.from({ length: next(30) }, () => `v${String(next(6))}`);
        const after = before.flatMap((line) => {
          const roll = next(10);
          if (roll === 0) return [];
          if (roll === 1) return [line, `n${String(next(6))}`];
          if (roll === 2) return [`c${String(next(6))}`];
          return [line];
        });
        const a = end(before, next(4) !== 0);
        const b = end(after, next(4) !== 0);
        writeFileSync(join(dir, "f.json"), a);
        const patch = unifiedDiff("f.json", a, b);
        if (patch.length === 0) {
          expect(a).toBe(b);
          continue;
        }
        writeFileSync(join(dir, "p.diff"), end(patch, true));
        const tool = ["git", "apply", "p.diff"];
        const applied = spawnSync(tool[0] ?? "", tool.slice(1), { cwd: dir, encoding: "utf8" });
        expect([round, applied.status, applied.stderr]).toEqual([round, 0, ""]);
        expect(readFileSync(join(dir, "f.json"), "utf8")).toBe(b);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
