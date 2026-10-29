import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_HEADER } from "./common.js";
import type { Config } from "./config.js";
import { ConfigError, loadConfig, parseConfig } from "./config.js";
import { DEFAULT_ALLOW } from "./emit-rust.js";

const ROOT = join(tmpdir(), "project");
const FILE = join(ROOT, "strictgen.json");

const SCHEMA = JSON.parse(
  readFileSync(new URL("../strictgen.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(SCHEMA);

function parse(value: unknown): Config {
  return parseConfig(value, FILE, "strictgen.json");
}

/** The error parsing `value` gives. */
function failure(value: unknown): ConfigError {
  try {
    parse(value);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

/** A config that sets every option, so the schema and the loader are compared on all of them. */
const FULL = {
  $schema: "./node_modules/strictgen/strictgen.schema.json",
  schemas: "./contracts",
  idBase: "https://example.com/schemas/v1/",
  ids: { file: "common", suffix: "Id" },
  header: "Generated, do not edit.",
  validation: false,
  targets: {
    rust: {
      out: "rust/orders/src/generated",
      fixtures: { out: "rust/orders/tests/generated", crate: "my_types" },
      allow: [{ lint: "clippy::doc_markdown", reason: "keys come without backticks" }],
      embedSchemas: true,
      read: "report",
    },
    go: { out: "go/types", package: "orders", shared: false, fixtures: true, read: "strict" },
    typescript: { out: "src/generated", decoders: false, read: "report" },
  },
  llm: { profiles: ["openai", "anthropic"], out: "llm", cleanup: true },
  docs: { out: "docs/types", format: "markdown" },
  format: { rust: "none", go: "none", typescript: "none" },
};

const ts = { typescript: { out: "src/generated" } };

describe("config defaults", () => {
  it("fills every option a minimal config leaves out", () => {
    expect(parse({ targets: ts })).toEqual({
      file: FILE,
      root: ROOT,
      schemas: join(ROOT, "schemas"),
      header: DEFAULT_HEADER,
      validation: true,
      targets: {
        typescript: { out: join(ROOT, "src/generated"), decoders: true, read: "strict" },
      },
      format: { rust: "rustfmt", go: "gofmt", typescript: "none" },
    });
  });

  it("gives Rust no fixture registry, no embedded schemas and the default lint allows", () => {
    expect(parse({ targets: { rust: { out: "gen" } } }).targets.rust).toEqual({
      out: join(ROOT, "gen"),
      allow: DEFAULT_ALLOW,
      embedSchemas: false,
      read: "strict",
    });
    expect(parse({ targets: { rust: { out: "gen", fixtures: false } } }).targets.rust).not.toHaveProperty(
      "fixtures",
    );
  });

  it("puts Go in the package types, in a shared folder, without a fixture registry", () => {
    expect(parse({ targets: { go: { out: "go" } } }).targets.go).toEqual({
      out: join(ROOT, "go"),
      package: "types",
      shared: true,
      fixtures: false,
      read: "strict",
    });
  });

  it("fills the options of later phases", () => {
    const config = parse({ targets: ts, llm: { profiles: ["openai"], out: "llm" }, docs: { out: "d" } });
    expect(config.llm).toEqual({ profiles: ["openai"], out: join(ROOT, "llm"), cleanup: false });
    expect(config.docs).toEqual({ out: join(ROOT, "d"), format: "markdown" });
  });

  it("keeps every option a full config sets", () => {
    const config = parse(FULL);
    expect(config.idBase).toBe("https://example.com/schemas/v1/");
    expect(config.ids).toEqual({ file: "common", suffix: "Id" });
    expect(config.header).toBe("Generated, do not edit.");
    expect(config.validation).toBe(false);
    expect(config.targets.rust).toEqual({
      out: join(ROOT, "rust/orders/src/generated"),
      fixtures: { out: join(ROOT, "rust/orders/tests/generated"), crate: "my_types" },
      allow: [{ lint: "clippy::doc_markdown", reason: "keys come without backticks" }],
      embedSchemas: true,
      read: "report",
    });
    expect(config.targets.go).toEqual({
      out: join(ROOT, "go/types"),
      package: "orders",
      shared: false,
      fixtures: true,
      read: "strict",
    });
    expect(config.targets.typescript).toEqual({
      out: join(ROOT, "src/generated"),
      decoders: false,
      read: "report",
    });
    expect(config.format).toEqual({ rust: "none", go: "none", typescript: "none" });
  });

  it("matches the defaults strictgen.schema.json documents", () => {
    const props = SCHEMA.properties as Record<string, { default?: unknown }>;
    const defs = SCHEMA.$defs as Record<string, { properties: Record<string, { default?: unknown }> }>;
    const config = parse({ targets: { rust: { out: "r" }, go: { out: "g" }, ...ts } });
    expect(join(ROOT, props.schemas?.default as string)).toBe(config.schemas);
    expect(props.header?.default).toBe(config.header);
    expect(props.validation?.default).toBe(config.validation);
    const format = (props.format as { properties: Record<string, { default: unknown }> }).properties;
    expect(Object.fromEntries(Object.entries(format).map(([k, v]) => [k, v.default]))).toEqual(
      config.format,
    );
    const rust = defs.rust?.properties ?? {};
    expect(rust.allow?.default).toEqual(config.targets.rust?.allow);
    expect(rust.embedSchemas?.default).toBe(config.targets.rust?.embedSchemas);
    expect(rust.fixtures?.default).toBe(false);
    const go = defs.go?.properties ?? {};
    expect(go.package?.default).toBe(config.targets.go?.package);
    expect(go.shared?.default).toBe(config.targets.go?.shared);
    expect(go.fixtures?.default).toBe(config.targets.go?.fixtures);
    expect(defs.typescript?.properties.decoders?.default).toBe(config.targets.typescript?.decoders);
    expect((defs.read as { default?: unknown } | undefined)?.default).toBe("strict");
  });
});

describe("config paths", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(config: unknown, at = "strictgen.json"): string {
    const dir = mkdtempSync(join(tmpdir(), "strictgen-config-"));
    dirs.push(dir);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, at), typeof config === "string" ? config : JSON.stringify(config));
    return dir;
  }

  it("reads strictgen.json from the working folder by default", () => {
    const dir = project({ targets: ts });
    const config = loadConfig(undefined, dir);
    expect(config.file).toBe(join(dir, "strictgen.json"));
    expect(config.targets.typescript?.out).toBe(join(dir, "src/generated"));
  });

  it("resolves paths against the folder of an explicit config file, not the working folder", () => {
    const dir = project({ schemas: "../schemas", targets: { go: { out: "../go" } } }, "nested/sg.json");
    const config = loadConfig("nested/sg.json", dir);
    expect(config.root).toBe(join(dir, "nested"));
    expect(config.schemas).toBe(join(dir, "schemas"));
    expect(config.targets.go?.out).toBe(join(dir, "go"));
  });

  it("keeps absolute paths", () => {
    const out = join(tmpdir(), "elsewhere", "gen");
    expect(parse({ targets: { typescript: { out } } }).targets.typescript?.out).toBe(out);
  });

  it("names a missing file", () => {
    const dir = project({ targets: ts });
    expect(() => loadConfig("missing.json", dir)).toThrow("missing.json: config file not found");
  });

  it("names a file that is not JSON", () => {
    const dir = project("{ targets: }");
    expect(() => loadConfig(undefined, dir)).toThrow(/^strictgen\.json: not valid JSON: /);
  });
});

describe("config folder safety", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project folder `proj` with `schemas/` and a config, inside a temp folder. */
  function project(config: object, setup?: (dir: string) => void): string {
    const parent = mkdtempSync(join(tmpdir(), "strictgen-safety-"));
    dirs.push(parent);
    const dir = join(parent, "proj");
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "strictgen.json"), JSON.stringify(config));
    setup?.(dir);
    return dir;
  }

  function problem(dir: string): string {
    try {
      loadConfig(undefined, dir);
    } catch (error) {
      if (error instanceof ConfigError) return `${error.option}: ${error.problem}`;
      throw error;
    }
    return "accepted";
  }

  it("rejects the project folder spelled in another case, from its parent", () => {
    const dir = project({ targets: { typescript: { out: "../PROJ" } } });
    expect(problem(dir)).toBe(
      "targets.typescript.out: holds the config file, and the folder is cleared before writing",
    );
  });

  it("rejects the schemas folder spelled in another case", () => {
    const dir = project({ targets: { typescript: { out: "Schemas" } } });
    expect(problem(dir)).toBe(
      "targets.typescript.out: holds the schemas folder, and the folder is cleared before writing",
    );
  });

  it("rejects the schemas folder reached through a symlink", () => {
    const dir = project({ targets: { typescript: { out: "link/schemas" } } }, (d) => {
      symlinkSync(".", join(d, "link"));
    });
    expect(problem(dir)).toBe(
      "targets.typescript.out: holds the schemas folder, and the folder is cleared before writing",
    );
    const direct = project({ targets: { typescript: { out: "lnk" } } }, (d) => {
      symlinkSync("schemas", join(d, "lnk"));
    });
    expect(problem(direct)).toContain("holds the schemas folder");
  });

  it("rejects two targets whose folders differ only in case, or by a trailing slash", () => {
    expect(problem(project({ targets: { typescript: { out: "gen" }, rust: { out: "GEN" } } }))).toBe(
      "targets.typescript.out: is the same folder as targets.rust.out",
    );
    expect(problem(project({ targets: { typescript: { out: "g" }, rust: { out: "g/" } } }))).toBe(
      "targets.typescript.out: is the same folder as targets.rust.out",
    );
  });
});

/** Config, option path and problem for every validation error the loader reports. */
const INVALID: readonly (readonly [string, unknown, string, string])[] = [
  ["not an object", [], "", "the config must be a JSON object"],
  ["no targets", {}, "targets", "is required"],
  ["empty targets", { targets: {} }, "targets", "lists no target"],
  ["unknown target", { targets: { java: { out: "j" } } }, "targets.java", "unknown option"],
  ["unknown top-level option", { targets: ts, output: "x" }, "output", "unknown option"],
  ["$schema not a string", { $schema: 1, targets: ts }, "$schema", "must be a string"],
  ["schemas not a string", { schemas: 1, targets: ts }, "schemas", "must be a string"],
  ["empty schemas", { schemas: "", targets: ts }, "schemas", "must not be empty"],
  ["idBase without a separator", { idBase: "https://x", targets: ts }, "idBase", "ends in / or #"],
  ["ids not an object", { ids: "common", targets: ts }, "ids", "must be an object"],
  ["ids without suffix", { ids: { file: "common" }, targets: ts }, "ids.suffix", "is required"],
  ["ids with an extra key", { ids: { file: "a", suffix: "Id", x: 1 }, targets: ts }, "ids.x", "unknown option"],
  ["empty header", { header: "", targets: ts }, "header", "must not be empty"],
  ["two-line header", { header: "a\nb", targets: ts }, "header", "one line"],
  ["validation not a boolean", { validation: "yes", targets: ts }, "validation", "true or false"],
  ["target not an object", { targets: { typescript: "src" } }, "targets.typescript", "must be an object"],
  ["target without out", { targets: { typescript: {} } }, "targets.typescript.out", "is required"],
  ["out not a string", { targets: { typescript: { out: 1 } } }, "targets.typescript.out", "must be a string"],
  ["decoders not a boolean", { targets: { typescript: { out: "t", decoders: 1 } } }, "targets.typescript.decoders", "true or false"],
  ["unknown read mode", { targets: { typescript: { out: "t", read: "loose" } } }, "targets.typescript.read", 'must be one of "strict", "report"'],
  ["unknown Rust option", { targets: { rust: { out: "r", clippy: [] } } }, "targets.rust.clippy", "unknown option"],
  ["fixtures true", { targets: { rust: { out: "r", fixtures: true } } }, "targets.rust.fixtures", "must be false or an object"],
  ["fixtures without crate", { targets: { rust: { out: "r", fixtures: { out: "t" } } } }, "targets.rust.fixtures.crate", "is required"],
  ["fixtures with a bad crate path", { targets: { rust: { out: "r", fixtures: { out: "t", crate: "my-types" } } } }, "targets.rust.fixtures.crate", "is not a Rust path"],
  ["allow not an array", { targets: { rust: { out: "r", allow: "clippy::all" } } }, "targets.rust.allow", "must be an array"],
  ["allow without reason", { targets: { rust: { out: "r", allow: [{ lint: "dead_code" }] } } }, "targets.rust.allow[0].reason", "is required"],
  ["allow with a bad lint", { targets: { rust: { out: "r", allow: [{ lint: "Clippy::X", reason: "r" }] } } }, "targets.rust.allow[0].lint", "is not a lint name"],
  ["allow with a two-line reason", { targets: { rust: { out: "r", allow: [{ lint: "dead_code", reason: "a\nb" }] } } }, "targets.rust.allow[0].reason", "one line"],
  ["embedSchemas not a boolean", { targets: { rust: { out: "r", embedSchemas: "no" } } }, "targets.rust.embedSchemas", "true or false"],
  ["Go package with a dash", { targets: { go: { out: "g", package: "my-types" } } }, "targets.go.package", "is not a Go identifier"],
  ["Go package starting with a digit", { targets: { go: { out: "g", package: "2types" } } }, "targets.go.package", "is not a Go identifier"],
  ["Go package that is a keyword", { targets: { go: { out: "g", package: "type" } } }, "targets.go.package", "can't name a Go package"],
  ["Go package _", { targets: { go: { out: "g", package: "_" } } }, "targets.go.package", "can't name a Go package"],
  ["Go fixtures not a boolean", { targets: { go: { out: "g", fixtures: { out: "t" } } } }, "targets.go.fixtures", "true or false"],
  ["shared not a boolean", { targets: { go: { out: "g", shared: "yes" } } }, "targets.go.shared", "true or false"],
  ["llm without profiles", { targets: ts, llm: { out: "llm" } }, "llm.profiles", "is required"],
  ["llm with no profile", { targets: ts, llm: { profiles: [], out: "llm" } }, "llm.profiles", "at least one"],
  ["llm with a bad profile", { targets: ts, llm: { profiles: ["Open AI"], out: "llm" } }, "llm.profiles[0]", "is not a profile name"],
  ["llm with a profile twice", { targets: ts, llm: { profiles: ["openai", "openai"], out: "llm" } }, "llm.profiles", "listed twice"],
  ["llm cleanup not a boolean", { targets: ts, llm: { profiles: ["openai"], out: "llm", cleanup: 1 } }, "llm.cleanup", "true or false"],
  ["docs without out", { targets: ts, docs: {} }, "docs.out", "is required"],
  ["unknown docs format", { targets: ts, docs: { out: "d", format: "html" } }, "docs.format", "must be one of"],
  ["unknown formatter", { targets: ts, format: { go: "goimports" } }, "format.go", "must be one of"],
  ["unknown format option", { targets: ts, format: { java: "none" } }, "format.java", "unknown option"],
];

/** Errors the schema can't express: they depend on several options together. */
const INVALID_TOGETHER: readonly (readonly [string, unknown, string, string])[] = [
  ["a lint listed twice", { targets: { rust: { out: "r", allow: [{ lint: "dead_code", reason: "a" }, { lint: "dead_code", reason: "b" }] } } }, "targets.rust.allow[1].lint", "dead_code is listed twice"],
  ["an owned folder holding the config file", { targets: { typescript: { out: "." } } }, "targets.typescript.out", "holds the config file"],
  ["an owned folder holding the schemas", { schemas: "gen/schemas", targets: { typescript: { out: "gen" } } }, "targets.typescript.out", "holds the schemas folder"],
  ["two targets in one folder", { targets: { rust: { out: "gen" }, typescript: { out: "gen" } } }, "targets.typescript.out", "is the same folder as targets.rust.out"],
  ["a target inside an owned folder", { targets: { rust: { out: "gen" }, typescript: { out: "gen/ts" } } }, "targets.typescript.out", "is inside targets.rust.out"],
  ["the fixture registry inside the Rust folder", { targets: { rust: { out: "gen", fixtures: { out: "gen/tests", crate: "t" } } } }, "targets.rust.fixtures.out", "is inside targets.rust.out"],
  ["a folder owned by Go", { targets: { go: { out: "go", shared: false }, typescript: { out: "go/ts" } } }, "targets.typescript.out", "is inside targets.go.out"],
];

describe("config validation", () => {
  it.each(INVALID)("rejects %s, naming the option", (_, config, option, problem) => {
    const error = failure(config);
    expect(error.option).toBe(option);
    expect(error.problem).toContain(problem);
    expect(error.message).toBe(`strictgen.json: ${option === "" ? "" : `${option}: `}${error.problem}`);
  });

  it.each(INVALID_TOGETHER)("rejects %s, naming the option", (_, config, option, problem) => {
    const error = failure(config);
    expect(error.option).toBe(option);
    expect(error.problem).toContain(problem);
  });

  it("allows a shared Go folder that holds the config file and other targets", () => {
    const config = parse({ targets: { go: { out: "." }, rust: { out: "gen" } } });
    expect(config.targets.go?.out).toBe(ROOT);
  });

  it("lists the known options of an object with an unknown one", () => {
    expect(failure({ targets: { go: { out: "g", pkg: "x" } } }).problem).toBe(
      "unknown option. Known options: out, package, shared, fixtures, read",
    );
  });
});

describe("strictgen.schema.json", () => {
  it("is a valid JSON Schema 2020-12 document", () => {
    expect(SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(validate).toBeTypeOf("function");
  });

  it("accepts the configs the loader accepts", () => {
    for (const config of [FULL, { targets: ts }, { targets: { rust: { out: "r", fixtures: false } } }]) {
      parse(config);
      expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each(INVALID)("rejects %s, like the loader", (_, config) => {
    expect(validate(config)).toBe(false);
  });

  it.each(INVALID_TOGETHER)("accepts %s, which only the loader checks", (_, config) => {
    expect(validate(config)).toBe(true);
  });

  it("names every option the loader knows, at every level", () => {
    const defs = SCHEMA.$defs as Record<string, { properties: Record<string, unknown> }>;
    const props = (schema: unknown): string[] =>
      Object.keys((schema as { properties: Record<string, unknown> }).properties);
    const top = SCHEMA.properties as Record<string, unknown>;
    const levels: [unknown, unknown, string[]][] = [
      [{ targets: ts }, [], props(SCHEMA)],
      [{ targets: ts, ids: { file: "a", suffix: "b" } }, ["ids"], props(top.ids)],
      [{ targets: ts }, ["targets"], props(top.targets)],
      [{ targets: { rust: { out: "r" } } }, ["targets", "rust"], props(defs.rust)],
      [{ targets: { rust: { out: "r", fixtures: { out: "f", crate: "c" } } } }, ["targets", "rust", "fixtures"], ["out", "crate"]],
      [{ targets: { rust: { out: "r", allow: [{ lint: "a", reason: "b" }] } } }, ["targets", "rust", "allow", 0], ["lint", "reason"]],
      [{ targets: { go: { out: "g" } } }, ["targets", "go"], props(defs.go)],
      [{ targets: ts }, ["targets", "typescript"], props(defs.typescript)],
      [{ targets: ts, llm: { profiles: ["a"], out: "l" } }, ["llm"], props(top.llm)],
      [{ targets: ts, docs: { out: "d" } }, ["docs"], props(top.docs)],
      [{ targets: ts, format: {} }, ["format"], props(top.format)],
    ];
    for (const [config, at, expected] of levels) {
      const copy = structuredClone(config) as Record<string | number, unknown>;
      let node = copy;
      for (const key of at as (string | number)[]) node = node[key] as Record<string | number, unknown>;
      node.unknownOption = true;
      const problem = failure(copy).problem;
      expect(problem.replace("unknown option. Known options: ", "").split(", ").sort()).toEqual(
        [...expected].sort(),
      );
      expect(validate(copy)).toBe(false);
    }
  });
});
