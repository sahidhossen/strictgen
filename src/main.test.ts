import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { EmittedFile } from "./common.js";
import { HEADER } from "./common.js";
import { emitGo, emitGoAttributes, emitGoFixtures, GO_FIXTURES } from "./emit-go.js";
import { emitRust, emitRustFixtures } from "./emit-rust.js";
import { emitTypeScript } from "./emit-ts.js";
import type { MainOptions, OutputFile, Target } from "./main.js";
import { generate, main, targetDirs } from "./main.js";
import { schemaSet } from "./schema.js";

const BASE = "https://example.com/schemas/v1/";

const roots: string[] = [];

function under(dir: string, files: readonly EmittedFile[]): OutputFile[] {
  return files.map((f) => ({ path: `${dir}/${f.name}`, contents: f.contents }));
}

/** Targets like a project would configure them: owned TypeScript and Rust folders, a shared Go one. */
const TARGETS: readonly Target[] = [
  {
    name: "typescript",
    dirs: ["ts/generated"],
    emit: (model) => under("ts/generated", emitTypeScript(model)),
  },
  {
    name: "rust",
    dirs: ["rust/src/generated", "rust/tests/generated"],
    emit: (model) => [
      ...under("rust/src/generated", emitRust(model)),
      { path: "rust/tests/generated/fixtures.rs", contents: emitRustFixtures(model, "my_types") },
    ],
  },
  {
    name: "go",
    dirs: [],
    shared: ["go"],
    emit: (model) => {
      const files = emitGo(model);
      return [
        ...under("go", files),
        { path: `go/${GO_FIXTURES}`, contents: emitGoFixtures(model) },
        {
          path: "go/.gitattributes",
          contents: emitGoAttributes([...files.map((f) => f.name), GO_FIXTURES]),
        },
      ];
    },
  },
];

/** A project root in a temp folder with the given schemas under `schemas/`. */
function repo(schemas: Record<string, object>, base: string = BASE): string {
  const root = mkdtempSync(join(tmpdir(), "strictgen-"));
  roots.push(root);
  mkdirSync(join(root, "schemas"), { recursive: true });
  for (const [name, body] of Object.entries(schemas)) {
    const schema = {
      $id: `${base}${name}.json`,
      title: name,
      description: "A schema.",
      ...body,
    };
    writeFileSync(join(root, "schemas", `${name}.json`), JSON.stringify(schema));
  }
  return root;
}

function run(
  root: string,
  options: Partial<MainOptions> = {},
): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = main(
    { rootDir: root, schemaDir: join(root, "schemas"), targets: TARGETS, ...options },
    (line) => lines.push(line),
  );
  return { code, lines };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const point = {
  type: "object",
  properties: { x: { description: "X.", type: "integer" } },
  required: ["x"],
  unevaluatedProperties: false,
};

describe("main", () => {
  it("writes every target's files, each starting with the generated header", () => {
    const root = repo({ point });
    expect(run(root)).toEqual({ code: 0, lines: ["Generated 11 files for typescript, rust, go."] });
    for (const path of [
      "ts/generated/point.ts",
      "ts/generated/helpers.ts",
      "ts/generated/index.ts",
      "rust/src/generated/mod.rs",
      "rust/src/generated/helpers.rs",
      "rust/src/generated/point.rs",
      "rust/tests/generated/fixtures.rs",
      "go/helpers.go",
      "go/point.go",
      "go/registry_test.go",
    ]) {
      expect(readFileSync(join(root, path), "utf8").startsWith(`${HEADER}\n`)).toBe(true);
    }
    expect(readFileSync(join(root, "rust/tests/generated/fixtures.rs"), "utf8")).toContain(
      '("point", None) => run::<my_types::Point>(json),',
    );
  });

  it("writes byte identical output when run twice", () => {
    const root = repo({ point });
    run(root);
    const first = readFileSync(join(root, "rust/src/generated/mod.rs"), "utf8");
    run(root);
    expect(readFileSync(join(root, "rust/src/generated/mod.rs"), "utf8")).toBe(first);
  });

  it("removes stale files from the folders it owns", () => {
    const root = repo({ point });
    const stale = join(root, "ts/generated/old.ts");
    mkdirSync(join(root, "ts/generated"), { recursive: true });
    writeFileSync(stale, "export {};\n");
    run(root);
    expect(existsSync(stale)).toBe(false);
  });

  it("removes only generated files from a folder it shares with hand written ones", () => {
    const root = repo({ point });
    const dir = join(root, "go");
    mkdirSync(join(dir, "testdata"), { recursive: true });
    const kept = ["decode_test.go", "go.mod", "testdata/old.go"].map((name) => join(dir, name));
    for (const path of kept) writeFileSync(path, `${HEADER}\n`);
    writeFileSync(kept[0] ?? "", "package types\n");
    writeFileSync(kept[1] ?? "", "module example\n");
    const stale = join(dir, "old.go");
    writeFileSync(stale, `${HEADER}\n\npackage types\n`);
    run(root);
    expect(existsSync(stale)).toBe(false);
    for (const path of kept) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(dir, "point.go"))).toBe(true);
  });

  it("returns 1 and logs the schema path for a schema outside the conventions, writing nothing", () => {
    const root = repo({
      point: { type: "object", properties: { x: { type: "null" } }, unevaluatedProperties: false },
    });
    expect(run(root)).toEqual({
      code: 1,
      lines: [
        "point.json#/properties/x/type: unsupported-type: type must be one of object, array, string, integer, number or boolean. Hint: use one of those types, or oneOf for a choice between them",
      ],
    });
    expect(existsSync(join(root, "ts/generated"))).toBe(false);
  });

  it("checks every $id against the idBase option", () => {
    const root = repo({ point }, "https://other.example/v2/");
    const { code, lines } = run(root, { idBase: BASE });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/^point\.json#\/\$id: /);
    expect(run(root, { idBase: "https://other.example/v2/" }).code).toBe(0);
  });

  it("passes the ID rule to the model", () => {
    const root = repo({ common: { $defs: { userId: { type: "string" } } } });
    run(root, { ids: { file: "common", suffix: "Id" } });
    expect(readFileSync(join(root, "rust/src/generated/common.rs"), "utf8")).toContain(
      "pub struct UserId(pub String);",
    );
    run(root);
    expect(readFileSync(join(root, "rust/src/generated/common.rs"), "utf8")).toContain(
      "pub type UserId = String;",
    );
  });

  it("lists the owned and shared folders for scripts", () => {
    expect(targetDirs(TARGETS)).toEqual([
      "ts/generated",
      "rust/src/generated",
      "rust/tests/generated",
      "go",
    ]);
  });
});

describe("generate", () => {
  const schemas = schemaSet({
    point: { $id: `${BASE}point.json`, title: "Point", ...point },
  });

  it("emits only the targets it is given", () => {
    expect(generate(schemas, [])).toEqual([]);
    const ts = TARGETS.filter((t) => t.name === "typescript");
    expect(generate(schemas, ts).map((f) => f.path)).toEqual([
      "ts/generated/point.ts",
      "ts/generated/helpers.ts",
      "ts/generated/index.ts",
    ]);
  });
});
