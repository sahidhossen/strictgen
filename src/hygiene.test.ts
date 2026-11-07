import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "hygiene.sh");
/** Each case starts bash and git a few times. */
const SPAWNS = 20_000;
/** A made-up blocked word, so the test never depends on the real denylist. */
const BLOCKED = "zebracornix";
const scratch = mkdtempSync(join(tmpdir(), "strictgen-hygiene-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a shell command with only PATH and the test denylist, so CI=true never leaks in. */
function sh(command: string, input = "", env: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync("bash", ["-c", command], {
    cwd: ROOT,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HYGIENE_DENYLIST: BLOCKED, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function file(name: string, text: string): string {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
}

describe("hygiene --text", { timeout: SPAWNS }, () => {
  it("checks text on stdin", () => {
    expect(sh(`"${SCRIPT}" --text`, "fix: a title\n\nA body.\n")).toMatchObject({ status: 0, stdout: "hygiene: clean\n" });
    const blocked = sh(`"${SCRIPT}" --text`, `fix: ${BLOCKED.toUpperCase()}\n`);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("blocked word in text");
    const attribution = sh(`"${SCRIPT}" --text`, `body\n\n${"Co-Authored"}-By: someone\n`);
    expect(attribution.status).toBe(1);
    expect(attribution.stderr).toContain("attribution or assistant name in text");
  });

  it("checks the file it is given instead of stdin", () => {
    const clean = file("clean.md", "fix: a title\n");
    const blocked = file("blocked.md", `a ${BLOCKED} here\n`);
    expect(sh(`"${SCRIPT}" --text "${clean}"`, `${BLOCKED}\n`)).toMatchObject({ status: 0, stdout: "hygiene: clean\n" });
    const r = sh(`"${SCRIPT}" --text "${blocked}"`, "clean stdin\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("blocked word in text");
  });

  it("fails on empty text, which means the text never arrived", () => {
    for (const [command, input] of [
      [`"${SCRIPT}" --text`, ""],
      [`"${SCRIPT}" --text`, " \n\t\n"],
      [`"${SCRIPT}" --text "${file("empty.md", "")}"`, "stdin is not read\n"],
      [`"${SCRIPT}" --text "${file("blank.md", "\n\n")}"`, ""],
    ] as const) {
      const r = sh(command, input);
      expect(r.status, command).toBe(1);
      expect(r.stderr, command).toBe("hygiene: the text to check is empty\n");
    }
  });

  it("fails on an unknown argument and a file it can't read", () => {
    const extra = sh(`"${SCRIPT}" --text "${file("a.md", "a\n")}" more`);
    expect(extra.status).toBe(2);
    expect(extra.stderr).toContain("unknown argument more");
    const unknown = sh(`"${SCRIPT}" --txt`);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("unknown argument --txt");
    const missing = sh(`"${SCRIPT}" --text "${join(scratch, "missing.md")}"`);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("can't read");
  });

  it("works as CI's pull request step calls it", () => {
    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const step = workflow
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.includes("scripts/hygiene.sh --text"));
    expect(step).toBeDefined();
    const command = (step ?? "").replace(/^run:\s*/, "");
    expect(sh(command, "", { PR_TITLE: "fix: a title", PR_BODY: "A body." })).toMatchObject({ status: 0, stdout: "hygiene: clean\n" });
    expect(sh(command, "", { PR_TITLE: "fix: a title", PR_BODY: `A ${BLOCKED}.` }).status).toBe(1);
  });
});
