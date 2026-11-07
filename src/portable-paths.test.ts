import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Device names Windows reserves, in any case and with any extension: `nul.json` can't be checked out. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
/** Characters a Windows file name can't hold: `<>:"|?*`, a backslash and control characters. */
const FORBIDDEN = /[<>:"|?*\\\u0000-\u001f]/;

/** Why `path` (with `/` separators) can't be checked out on Windows, or undefined when it can. */
function windowsProblem(path: string): string | undefined {
  for (const part of path.split("/")) {
    if (RESERVED.test(part)) return `${part} is a reserved device name on Windows`;
    if (FORBIDDEN.test(part)) return `${part} has a character Windows can't hold in a file name`;
    if (/[. ]$/.test(part)) return `${part} ends in a dot or a space, which Windows drops`;
  }
  return undefined;
}

describe("portable paths", () => {
  it("finds the names Windows can't hold", () => {
    for (const bad of ["nul.json", "a/NUL.expect.json", "Con", "x/aux.tar.gz", "COM1.txt", "lpt9", "a<b", "a:b", 'a"b', "a|b", "a?b", "a*b", "a\\b", "a\u0001b", "dot.", "space ", "dir./x"]) {
      expect(windowsProblem(bad), bad).toBeDefined();
    }
    for (const good of ["nul-character.json", "null.json", "console.ts", "com10.json", "lpt.json", "auxiliary/x", "a.b.c", ".gitignore"]) {
      expect(windowsProblem(good), good).toBeUndefined();
    }
  });

  it("holds for every tracked file, so the repository checks out on Windows", () => {
    const r = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
    expect(r.status).toBe(0);
    const files = r.stdout.split("\0").filter((f) => f !== "");
    expect(files.length).toBeGreaterThan(100);
    const problems = files.flatMap((f) => {
      const p = windowsProblem(f);
      return p === undefined ? [] : [`${f}: ${p}`];
    });
    expect(problems).toEqual([]);
  });
});
