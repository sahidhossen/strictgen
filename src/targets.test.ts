import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HEADER } from "./common.js";
import type { Config } from "./config.js";
import { parseConfig } from "./config.js";
import type { OutputFile, Target } from "./main.js";
import { generateProject, main, targetDirs, writeOutput } from "./main.js";
import { CodegenError } from "./schema.js";
import { configTargets, mainOptions } from "./targets.js";

const BASE = "https://example.com/schemas/v1/";

const order = {
  $id: `${BASE}order.json`,
  title: "Order",
  description: "An order.",
  type: "object",
  properties: { total: { description: "The total, in cents.", type: "integer" } },
  required: ["total"],
  unevaluatedProperties: false,
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A project in a temp folder: `schemas/order.json` and a `strictgen.json` with `config`. */
function project(config: object, schemas: Record<string, object> = { order }): Config {
  const root = mkdtempSync(join(tmpdir(), "strictgen-targets-"));
  roots.push(root);
  mkdirSync(join(root, "schemas"));
  for (const [name, schema] of Object.entries(schemas)) {
    writeFileSync(join(root, "schemas", `${name}.json`), JSON.stringify(schema));
  }
  const file = join(root, "strictgen.json");
  writeFileSync(file, JSON.stringify(config));
  return parseConfig(config, file);
}

function files(config: Config): OutputFile[] {
  return generateProject(mainOptions(config));
}

function contents(config: Config, path: string): string {
  return files(config).find((f) => f.path === path)?.contents ?? "";
}

function run(config: Config): { code: number; lines: string[] } {
  const lines: string[] = [];
  const code = main(mainOptions(config), (line) => lines.push(line));
  return { code, lines };
}

const rust = { out: "rust/src/generated" };
const go = { out: "go" };
const typescript = { out: "ts/generated" };

describe("config targets", () => {
  it("generates only the targets the config lists", () => {
    const config = project({ targets: { rust, go } });
    expect(configTargets(config).map((t) => t.name)).toEqual(["rust", "go"]);
    expect(files(config).map((f) => f.path)).toEqual([
      "rust/src/generated/mod.rs",
      "rust/src/generated/helpers.rs",
      "rust/src/generated/order.rs",
      "go/helpers.go",
      "go/order.go",
      "go/.gitattributes",
    ]);
    expect(run(config)).toEqual({ code: 0, lines: ["Generated 6 files for rust, go."] });
    expect(existsSync(join(config.root, "ts"))).toBe(false);
  });

  it("orders the targets TypeScript, Rust, Go whatever the config order", () => {
    const config = project({ targets: { go, rust, typescript } });
    expect(configTargets(config).map((t) => t.name)).toEqual(["typescript", "rust", "go"]);
  });

  it("writes folders relative to the config file", () => {
    const config = project({ targets: { typescript: { out: "./web/../src/types" } } });
    expect(targetDirs(configTargets(config))).toEqual(["src/types"]);
    expect(files(config).map((f) => f.path)).toEqual([
      "src/types/order.ts",
      "src/types/helpers.ts",
      "src/types/index.ts",
    ]);
  });

  it("passes idBase and ids to the generator", () => {
    const common = {
      $id: `${BASE}common.json`,
      title: "Common",
      description: "Shared defs.",
      $defs: { orderId: { description: "An order ID.", type: "string" } },
    };
    const config = project(
      { idBase: BASE, ids: { file: "common", suffix: "Id" }, targets: { rust } },
      { common },
    );
    expect(contents(config, "rust/src/generated/common.rs")).toContain("pub struct OrderId(pub String);");
    const other = project({ idBase: "https://other.example/", targets: { rust } }, { common });
    expect(run(other).code).toBe(1);
  });
});

describe("config header", () => {
  it("starts every file with the default header", () => {
    const config = project({ targets: { rust, go, typescript } });
    for (const file of files(config)) {
      const first = file.path.endsWith(".gitattributes") ? `# ${HEADER.slice(3)}` : HEADER;
      expect(file.contents.startsWith(`${first}\n`), file.path).toBe(true);
    }
  });

  it("starts every file with the configured header", () => {
    const config = project({
      header: "Generated from schemas/, do not edit.",
      targets: { rust: { ...rust, embedSchemas: true, fixtures: { out: "rust/tests/generated", crate: "orders" } }, go: { ...go, fixtures: true }, typescript },
    });
    const all = files(config);
    expect(all).toHaveLength(12);
    for (const file of all) {
      const comment = file.path.endsWith(".gitattributes") ? "#" : "//";
      expect(file.contents.startsWith(`${comment} Generated from schemas/, do not edit.\n`), file.path).toBe(
        true,
      );
    }
  });

  it("removes only the files with the configured header from a shared folder", () => {
    const config = project({ header: "Made by a tool.", targets: { go } });
    const dir = join(config.root, "go");
    mkdirSync(dir);
    writeFileSync(join(dir, "stale.go"), "// Made by a tool.\n\npackage types\n");
    writeFileSync(join(dir, "old_header.go"), `${HEADER}\n\npackage types\n`);
    writeFileSync(join(dir, "go.mod"), "module example.com/orders\n");
    run(config);
    expect(existsSync(join(dir, "stale.go"))).toBe(false);
    expect(existsSync(join(dir, "old_header.go"))).toBe(true);
    expect(existsSync(join(dir, "go.mod"))).toBe(true);
    expect(existsSync(join(dir, "order.go"))).toBe(true);
  });
});

describe("config Rust target", () => {
  it("writes no fixture registry unless asked", () => {
    const config = project({ targets: { rust } });
    expect(targetDirs(configTargets(config))).toEqual(["rust/src/generated"]);
    expect(files(config).some((f) => f.path.includes("registry"))).toBe(false);
  });

  it("writes the fixture registry to its folder, reaching the types by the crate path", () => {
    const config = project({
      targets: { rust: { ...rust, fixtures: { out: "rust/tests/generated", crate: "orders::generated" } } },
    });
    expect(targetDirs(configTargets(config))).toEqual(["rust/src/generated", "rust/tests/generated"]);
    expect(contents(config, "rust/tests/generated/registry.rs")).toContain(
      '("order", None) => run::<orders::generated::Order>(json),',
    );
  });

  it("allows the default lints in mod.rs", () => {
    const mod = contents(project({ targets: { rust } }), "rust/src/generated/mod.rs");
    expect(mod).toContain('#![allow(clippy::doc_markdown, reason = "descriptions come from');
    expect(mod).toContain("#![allow(clippy::enum_variant_names, ");
    expect(mod).toContain("#![allow(clippy::large_enum_variant, ");
  });

  it("allows the configured lints instead, with their reasons escaped", () => {
    const config = project({
      targets: { rust: { ...rust, allow: [{ lint: "clippy::pedantic", reason: 'a "strict" set \\ more' }] } },
    });
    const mod = contents(config, "rust/src/generated/mod.rs");
    expect(mod).toContain('#![allow(clippy::pedantic, reason = "a \\"strict\\" set \\\\ more")]\n');
    expect(mod).not.toContain("clippy::doc_markdown");
    const none = contents(project({ targets: { rust: { ...rust, allow: [] } } }), "rust/src/generated/mod.rs");
    expect(none).not.toContain("#![allow(");
  });

  it("embeds the schemas only when embedSchemas is on", () => {
    const off = project({ targets: { rust } });
    expect(files(off).some((f) => f.path.endsWith("schemas.rs"))).toBe(false);
    expect(contents(off, "rust/src/generated/mod.rs")).not.toContain("mod schemas");
    const on = project({ targets: { rust: { ...rust, embedSchemas: true } } });
    expect(contents(on, "rust/src/generated/mod.rs")).toContain("pub mod schemas;\n");
    const schemas = contents(on, "rust/src/generated/schemas.rs");
    expect(schemas).toContain('    ("order", r#"{"$id":"https://example.com/schemas/v1/order.json",');
    expect(/^[\x09\x0a\x20-\x7e]*$/.test(schemas)).toBe(true);
  });

  it("rejects a schema named like the embedded schemas module", () => {
    const schemas = { ...order, $id: `${BASE}schemas.json` };
    const config = project({ targets: { rust: { ...rust, embedSchemas: true } } }, { schemas });
    expect(run(config)).toEqual({
      code: 1,
      lines: [
        "schemas.json#: reserved-name: schema file schemas clashes with the generated schemas module. Hint: rename the schema file",
      ],
    });
    expect(run(project({ targets: { rust } }, { schemas })).code).toBe(0);
  });
});

describe("config Go target", () => {
  it("writes no fixture registry unless asked, and leaves it out of .gitattributes", () => {
    const config = project({ targets: { go } });
    expect(files(config).map((f) => f.path)).toEqual(["go/helpers.go", "go/order.go", "go/.gitattributes"]);
    const attributes = contents(config, "go/.gitattributes");
    expect(attributes).not.toContain("registry_test.go");
    expect(attributes).toContain("order.go linguist-generated=true\n");
  });

  it("writes registry_test.go in the package folder when fixtures is on", () => {
    const config = project({ targets: { go: { ...go, package: "orders", fixtures: true } } });
    expect(files(config).map((f) => f.path)).toEqual([
      "go/helpers.go",
      "go/order.go",
      "go/registry_test.go",
      "go/.gitattributes",
    ]);
    expect(contents(config, "go/registry_test.go")).toContain("package orders\n");
    expect(contents(config, "go/.gitattributes")).toContain("registry_test.go linguist-generated=true\n");
  });

  it("puts every file in the configured package", () => {
    const config = project({ targets: { go: { ...go, package: "orders" } } });
    for (const file of files(config).filter((f) => f.path.endsWith(".go"))) {
      expect(file.contents, file.path).toMatch(/^\/\/ .*\n\n(\/\/ .*\n\n)?package orders\n/);
    }
  });

  it("clears an owned folder entirely before writing", () => {
    const config = project({ targets: { go: { ...go, shared: false } } });
    expect(configTargets(config)[0]).toMatchObject({ dirs: ["go"] });
    mkdirSync(join(config.root, "go"));
    writeFileSync(join(config.root, "go", "notes.txt"), "hand written\n");
    run(config);
    expect(existsSync(join(config.root, "go", "notes.txt"))).toBe(false);
    expect(readFileSync(join(config.root, "go", "order.go"), "utf8")).toContain("package types\n");
  });

  it("keeps hand written files in a shared folder", () => {
    const config = project({ targets: { go } });
    expect(configTargets(config)[0]).toMatchObject({ dirs: [], shared: ["go"] });
    mkdirSync(join(config.root, "go"));
    writeFileSync(join(config.root, "go", "decode_test.go"), "package types\n");
    run(config);
    expect(existsSync(join(config.root, "go", "decode_test.go"))).toBe(true);
  });
});

describe("writeOutput safety", () => {
  const target = (dir: string): Target => ({ name: "typescript", dirs: [dir], emit: () => [] });

  it("refuses to clear a folder that holds the project, the config file or the schemas, removing nothing", () => {
    const config = project({ targets: { typescript } });
    const parent = join(config.root, "..");
    for (const [dir, protect] of [
      [".", []],
      ["..", []],
      ["SCHEMAS", [config.schemas]],
      [".", [config.file]],
    ] as const) {
      expect(() => writeOutput(config.root, [target(dir)], [], HEADER.slice(3), protect)).toThrow(
        CodegenError,
      );
    }
    expect(existsSync(join(config.root, "strictgen.json"))).toBe(true);
    expect(existsSync(join(config.schemas, "order.json"))).toBe(true);
    expect(existsSync(parent)).toBe(true);
  });

  it("refuses a schemas folder reached through a symlink", () => {
    const config = project({ targets: { typescript } });
    symlinkSync(".", join(config.root, "link"));
    expect(() =>
      writeOutput(config.root, [target("link/schemas")], [], undefined, [config.schemas]),
    ).toThrow("refusing to clear this folder");
    expect(existsSync(join(config.schemas, "order.json"))).toBe(true);
  });

  it("returns 1 from main instead of clearing a protected folder", () => {
    const config = project({ targets: { typescript } });
    const options = { ...mainOptions(config), targets: [target("schemas")] };
    const lines: string[] = [];
    expect(main(options, (line) => lines.push(line))).toBe(1);
    expect(lines[0]).toMatch(/^schemas: output-conflict: refusing to clear this folder: it holds /);
    expect(existsSync(join(config.schemas, "order.json"))).toBe(true);
  });
});

describe("config Go .gitattributes", () => {
  it("won't overwrite a hand written .gitattributes in a shared folder, and writes nothing", () => {
    const config = project({ targets: { go } });
    mkdirSync(join(config.root, "go"));
    writeFileSync(join(config.root, "go", ".gitattributes"), "*.png binary\n");
    writeFileSync(join(config.root, "go", "stale.go"), `${HEADER}\n\npackage types\n`);
    const result = run(config);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(
      /^go\/\.gitattributes: output-conflict: a hand written file is in the way of a generated one, .* Hint: /,
    );
    expect(readFileSync(join(config.root, "go", ".gitattributes"), "utf8")).toBe("*.png binary\n");
    expect(existsSync(join(config.root, "go", "stale.go"))).toBe(true);
    expect(existsSync(join(config.root, "go", "order.go"))).toBe(false);
  });

  it("replaces a generated .gitattributes, and writes one where there is none", () => {
    const config = project({ targets: { go } });
    expect(run(config).code).toBe(0);
    const path = join(config.root, "go", ".gitattributes");
    expect(readFileSync(path, "utf8")).toContain("order.go linguist-generated=true\n");
    expect(run(config).code).toBe(0);
    expect(readFileSync(path, "utf8").startsWith(`# ${HEADER.slice(3)}\n`)).toBe(true);
  });
});

describe("config TypeScript target", () => {
  it("writes to its folder and clears stale files there", () => {
    const config = project({ targets: { typescript } });
    mkdirSync(join(config.root, "ts/generated"), { recursive: true });
    writeFileSync(join(config.root, "ts/generated/old.ts"), "export {};\n");
    expect(run(config).code).toBe(0);
    expect(existsSync(join(config.root, "ts/generated/old.ts"))).toBe(false);
    expect(existsSync(join(config.root, "ts/generated/order.ts"))).toBe(true);
  });
});

describe("reserved names per configured target", () => {
  const self = { ...order, $id: `${BASE}self.json`, title: "Self" };
  const record = { ...order, $id: `${BASE}record.json`, title: "Record" };
  const codeTooDeep = {
    "code-too-deep": { ...order, $id: `${BASE}code-too-deep.json`, title: "CodeTooDeep" },
  };

  it("apply only the lists of the targets the config lists", () => {
    const ts = { typescript: { out: "ts" } };
    const go = { go: { out: "go" } };
    expect(files(project({ targets: { ...ts, ...go } }, { self })).length).toBeGreaterThan(0);
    expect(() => files(project({ targets: { rust } }, { self }))).toThrow("reserved in Rust");
    expect(files(project({ targets: { rust, ...go } }, { record })).length).toBeGreaterThan(0);
    expect(() => files(project({ targets: ts }, { record }))).toThrow("reserved in TypeScript");
    expect(files(project({ targets: { rust, ...ts } }, codeTooDeep)).length).toBeGreaterThan(0);
    expect(() => files(project({ targets: go }, codeTooDeep))).toThrow("reserved in Go");
  });
});
