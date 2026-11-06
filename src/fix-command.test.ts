import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run } from "./run.js";

const BASE = "https://example.com/schemas/v1/";

/** An order with an open object, laid out with tabs and no final newline. */
const OPEN = `{\n\t"$id": "${BASE}order.json",\n\t"title": "Order",\n\t"type": "object",\n\t"properties": {\n\t\t"total": { "type": "integer" }\n\t}\n}`;
const CLOSED = `{\n\t"$id": "${BASE}order.json",\n\t"title": "Order",\n\t"type": "object",\n\t"properties": {\n\t\t"total": { "type": "integer" }\n\t},\n\t"additionalProperties": false\n}`;
/** A user schema already in the subset, written compactly. */
const USER = `{"$id":"${BASE}user.json","title":"User","type":"string"}`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(schemas: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "strictgen-fix-"));
  roots.push(root);
  mkdirSync(join(root, "schemas"));
  for (const [name, text] of Object.entries(schemas))
    writeFileSync(join(root, "schemas", name), text);
  writeFileSync(
    join(root, "strictgen.json"),
    JSON.stringify({ targets: { typescript: { out: "ts" } } }),
  );
  return root;
}

function cli(root: string, ...args: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(["fix", ...args], {
    cwd: root,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

const read = (root: string, name: string): string =>
  readFileSync(join(root, "schemas", name), "utf8");

describe("strictgen fix", () => {
  it("prints a unified diff and changes nothing on disk", () => {
    const root = project({ "order.json": OPEN, "user.json": USER });
    const { code, out, err } = cli(root);
    expect(code).toBe(EXIT_OK);
    expect(out).toEqual([
      "--- a/schemas/order.json",
      "+++ b/schemas/order.json",
      "@@ -4,5 +4,6 @@",
      ' \t"type": "object",',
      ' \t"properties": {',
      ' \t\t"total": { "type": "integer" }',
      "-\t}",
      "+\t},",
      '+\t"additionalProperties": false',
      " }",
      "\\ No newline at end of file",
    ]);
    expect(err).toEqual([
      "strictgen fix --write would change 1 schema file. The schemas generate cleanly.",
    ]);
    expect(read(root, "order.json")).toBe(OPEN);
  });

  it("writes in place with --write, keeping the formatting and leaving other files untouched", () => {
    const root = project({ "order.json": OPEN, "user.json": USER });
    chmodSync(join(root, "schemas", "order.json"), 0o600);
    const userTime = statSync(join(root, "schemas", "user.json")).mtimeMs;
    const { code, out } = cli(root, "--write");
    expect(code).toBe(EXIT_OK);
    expect(out).toEqual(["Fixed 1 schema file. The schemas generate cleanly."]);
    expect(read(root, "order.json")).toBe(CLOSED);
    expect(statSync(join(root, "schemas", "order.json")).mode & 0o777).toBe(0o600);
    expect(read(root, "user.json")).toBe(USER);
    expect(statSync(join(root, "schemas", "user.json")).mtimeMs).toBe(userTime);
    expect(readdirSync(join(root, "schemas")).sort()).toEqual(["order.json", "user.json"]);
    const again = cli(root);
    expect(again).toEqual({
      code: EXIT_OK,
      out: [],
      err: ["Nothing to fix. The schemas generate cleanly."],
    });
  });

  it("exits 1 and lists what is left, with --write too", () => {
    const meta = `{"$id":"${BASE}order.json","title":"Order","type":"object","properties":{"meta":{"type":"object"}}}`;
    const root = project({ "order.json": meta });
    const { code, err } = cli(root, "--write");
    expect(code).toBe(EXIT_FAILED);
    expect(err).toEqual([
      'notice: order.json#/properties/meta: close-objects: an object with no properties stays open, since closing it would allow only {}. Hint: list its keys in "properties", or give "additionalProperties" the schema of its values to make it a map',
      'error: order.json#/properties/meta: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false',
      "Fixed 1 schema file. Generation still fails: change the schema by hand where the error points, then run strictgen fix again.",
    ]);
    expect(read(root, "order.json")).toContain(
      '"properties": {"meta":{"type":"object"}},\n  "additionalProperties": false\n}',
    );
  });

  it("says pointers refer to the fixed schemas when it only prints a diff", () => {
    const root = project({
      "order.json": `{"$id":"${BASE}order.json","title":"Order","type":"object","properties":{"a":{"type":"null"}}}`,
    });
    const { code, err } = cli(root);
    expect(code).toBe(EXIT_FAILED);
    expect(err.at(-1)).toContain("(in the schemas as fixed)");
  });

  it("exits 1 on a schema that isn't valid JSON or UTF-8, and writes nothing", () => {
    const root = project({ "order.json": OPEN, "user.json": "{ nope" });
    expect(cli(root, "--write")).toMatchObject({
      code: EXIT_FAILED,
      err: [
        expect.stringMatching(
          /^error: user\.json: invalid-json: not valid JSON: unexpected character/,
        ),
      ],
    });
    expect(read(root, "order.json")).toBe(OPEN);
    writeFileSync(join(root, "schemas", "user.json"), Buffer.from([0x7b, 0xff, 0x7d]));
    expect(cli(root).err).toEqual(["error: user.json: invalid-json: not valid UTF-8"]);
  });

  it("refuses to write through a symlink to a file outside the schemas folder", () => {
    const root = project({ "user.json": USER });
    const outside = join(root, "order.json");
    writeFileSync(outside, OPEN);
    symlinkSync(outside, join(root, "schemas", "order.json"));
    const { code, err } = cli(root, "--write");
    expect(code).toBe(EXIT_FAILED);
    expect(err).toEqual([
      "error: schemas/order.json: output-conflict: refusing to write it: it is a symlink to a file outside the schemas folder. Hint: replace the symlink with the file it points at",
    ]);
    expect(readFileSync(outside, "utf8")).toBe(OPEN);
  });

  it("writes through a symlink that stays inside the schemas folder", () => {
    const root = project({ "real.txt": OPEN });
    symlinkSync(join(root, "schemas", "real.txt"), join(root, "schemas", "order.json"));
    expect(cli(root, "--write").code).toBe(EXIT_OK);
    expect(read(root, "real.txt")).toBe(CLOSED);
  });

  it("fails cleanly when the schemas folder is missing, and leaves no temporary file on a write error", () => {
    const root = project({});
    rmSync(join(root, "schemas"), { recursive: true });
    expect(cli(root)).toMatchObject({
      code: EXIT_FAILED,
      err: [expect.stringMatching(/can't read the schemas folder/)],
    });
    const other = project({ "order.json": OPEN });
    writeFileSync(join(other, "schemas", "order.json.strictgen-fix"), "in the way");
    const { code, err } = cli(other, "--write");
    expect(code).toBe(EXIT_FAILED);
    expect(err).toEqual([
      expect.stringMatching(
        /^error: schemas\/order\.json\.strictgen-fix: write-failed: can't write the output: already exists \(EEXIST\)$/,
      ),
    ]);
    expect(read(other, "order.json")).toBe(OPEN);
    expect(existsSync(join(other, "schemas", "order.json.strictgen-fix"))).toBe(true);
  });

  it("rejects --write on another command, and shows its help", () => {
    const root = project({ "order.json": OPEN });
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd: root,
      env: {},
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
    };
    expect(run(["generate", "--write"], io)).toBe(EXIT_USAGE);
    expect(err[0]).toBe("error: --write only applies to strictgen fix");
    expect(run(["fix", "--help"], io)).toBe(EXIT_OK);
    expect(out[0]).toBe(
      "strictgen fix: Rewrite the schemas into the supported subset, as a diff or in place",
    );
    expect(run(["fix", "extra"], io)).toBe(EXIT_USAGE);
  });
});
