import { spawn, spawnSync } from "node:child_process";
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
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatFiles, FormatterFailedError } from "./format.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run, version } from "./run.js";

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

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "strictgen-cli-"));
  roots.push(root);
  return root;
}

/** A project in a temp folder: `schemas/order.json` and a `strictgen.json` with `config`. */
function project(config: object = { targets: { rust: { out: "rust/gen" }, go: { out: "go" } } }) {
  const root = temp();
  mkdirSync(join(root, "schemas"));
  writeFileSync(join(root, "schemas", "order.json"), JSON.stringify(order));
  writeFileSync(join(root, "strictgen.json"), JSON.stringify(config));
  return root;
}

/** A folder for `PATH` with fake formatters: shell scripts named like them. */
function formatters(scripts: Readonly<Record<string, string>>): string {
  const dir = temp();
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** Passes the file through and adds a last line naming the formatter, and logs its arguments. */
function passing(name: string, log: string): string {
  return `echo "args: $@" >> "${log}"\n/bin/cat\nprintf '// formatted by ${name}\\n'`;
}

/** Answers `--version` like an installed formatter, the probe strictgen runs before rustfmt. */
const PROBE_OK = 'if [ "$1" = "--version" ]; then echo "fake 1.0.0"; exit 0; fi';

const FAILING = `${PROBE_OK}\n/bin/cat > /dev/null\necho 'error: expected one of \`;\` or \`}\`' >&2\nexit 1`;
/** Exits 0 but prints nothing. */
const SILENT = `${PROBE_OK}\n/bin/cat > /dev/null`;
/** Exits 0 but prints something that isn't the file. */
const GARBAGE = `${PROBE_OK}\n/bin/cat > /dev/null\necho garbage`;
/** A rustup proxy without the rustfmt component: it exists, but fails even for `--version`. */
const PROXY =
  "echo \"error: 'rustfmt' is not installed for the toolchain 'stable'\" >&2\nexit 1";

interface Result {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/** Runs the CLI in `cwd`, with `PATH` set to `path`, an empty folder unless given. */
function cli(cwd: string, args: readonly string[], path: string = temp()): Result {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, {
    cwd,
    env: { PATH: path },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

/** Every file below `dir`, relative to it, with its contents. */
function snapshot(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(at, entry.name), `${rel}/`);
      else found[rel] = readFileSync(join(at, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return found;
}

function noStack(result: Result): void {
  for (const line of [...result.out, ...result.err]) expect(line).not.toMatch(/^\s+at /);
}

describe("help, version and usage", () => {
  it("prints the help with --help or -h and exits 0", () => {
    const root = temp();
    for (const flag of ["--help", "-h"]) {
      const result = cli(root, [flag]);
      expect(result.code).toBe(EXIT_OK);
      expect(result.out[0]).toMatch(/^strictgen: /);
      expect(result.out).toContain("Usage: strictgen [command] [options]");
      for (const name of ["generate", "check", "dirs"]) {
        expect(result.out.some((line) => line.startsWith(`  ${name} `))).toBe(true);
      }
    }
  });

  it("prints the help of one command", () => {
    const root = temp();
    expect(cli(root, ["generate", "--help"]).out).toContain(
      "Usage: strictgen [generate] [--config <path>]",
    );
    expect(cli(root, ["check", "--help"]).out).toContain("Usage: strictgen check [--config <path>]");
    const dirs = cli(root, ["dirs", "-h"]);
    expect(dirs.code).toBe(EXIT_OK);
    expect(dirs.out).toContain("Usage: strictgen dirs [--json] [--config <path>]");
  });

  it("prints the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(version()).toBe(pkg.version);
    expect(cli(temp(), ["--version"])).toEqual({ code: EXIT_OK, out: [pkg.version], err: [] });
  });

  it.each([
    [["bogus"], 'error: unknown command "bogus". Commands: generate, check, dirs'],
    [["--bogus"], "error: Unknown option '--bogus'"],
    [["generate", "extra"], 'error: unexpected argument "extra"'],
    [["--json"], "error: --json only applies to strictgen dirs"],
    [["check", "--json"], "error: --json only applies to strictgen dirs"],
    [["--config"], "error: Option '--config <value>' argument missing"],
  ])("exits 2 on bad usage: %j", (args, message) => {
    const result = cli(project(), args);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.out).toEqual([]);
    expect(result.err[0]?.startsWith(message)).toBe(true);
    expect(result.err[1]).toBe("Run strictgen --help for usage.");
  });
});

describe("generate", () => {
  it("writes every target, with or without the command name", () => {
    for (const args of [[], ["generate"]]) {
      const root = project();
      const result = cli(root, args);
      expect(result).toEqual({
        code: EXIT_OK,
        out: ["Generated 6 files for rust, go."],
        err: [
          'notice: rustfmt is not installed, so the Rust output is left unformatted. Install it, or set format.rust to "none"',
          'notice: gofmt is not installed, so the Go output is left unformatted. Install it, or set format.go to "none"',
        ],
      });
      expect(Object.keys(snapshot(join(root, "rust"))).sort()).toEqual([
        "gen/helpers.rs",
        "gen/mod.rs",
        "gen/order.rs",
      ]);
      expect(existsSync(join(root, "go", "order.go"))).toBe(true);
    }
  });

  it("exits 1 with the schema path when a schema is outside the conventions", () => {
    const root = project();
    writeFileSync(join(root, "schemas", "order.json"), JSON.stringify({ ...order, $id: "x" }));
    const result = cli(root, []);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/^error: order\.json#\/\$id: /);
  });

  it("exits 1 with the file name when a schema is not valid JSON", () => {
    const root = project();
    writeFileSync(join(root, "schemas", "order.json"), "{");
    const result = cli(root, []);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(/^error: order\.json: not valid JSON: /);
  });
});

describe("--config", () => {
  it("reads the config from another path, with paths relative to it, for every command", () => {
    const root = project();
    const cwd = temp();
    const config = join(root, "strictgen.json");
    expect(cli(cwd, ["--config", config, "--version"]).code).toBe(EXIT_OK);
    expect(cli(cwd, ["generate", "--config", config]).code).toBe(EXIT_OK);
    expect(existsSync(join(root, "rust", "gen", "mod.rs"))).toBe(true);
    expect(readdirSync(cwd)).toEqual([]);
    expect(cli(cwd, ["check", `--config=${config}`]).code).toBe(EXIT_FAILED);
    expect(cli(root, ["dirs", "--config", "strictgen.json"]).out).toEqual(["rust/gen", "go"]);
  });

  it("finds a relative --config from the current folder", () => {
    const root = project();
    mkdirSync(join(root, "sub"));
    const result = cli(join(root, "sub"), ["dirs", "--config", "../strictgen.json"]);
    expect(result.out).toEqual(["../rust/gen", "../go"]);
  });

  it("exits 2 when the config file is missing", () => {
    const result = cli(temp(), ["--config", "missing.json"]);
    expect(result).toEqual({
      code: EXIT_USAGE,
      out: [],
      err: ["error: missing.json: config file not found"],
    });
  });

  it("exits 2 naming the option and the problem when the config breaks a rule", () => {
    const root = project({ targets: { go: { out: "go", package: "func" } } });
    for (const args of [[], ["check"], ["dirs"]]) {
      expect(cli(root, args)).toEqual({
        code: EXIT_USAGE,
        out: [],
        err: [`error: strictgen.json: targets.go.package: "func" can't name a Go package`],
      });
    }
  });

  it("exits 2 when the config is a folder", () => {
    const root = temp();
    mkdirSync(join(root, "strictgen.json"));
    const result = cli(root, []);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err).toEqual([
      "error: strictgen.json: can't read it: is a folder, where a file should be (EISDIR)",
    ]);
  });
});

describe("formatters", () => {
  it("runs rustfmt and gofmt on the files they format, on stdin, with stable options", () => {
    const root = project({
      targets: { rust: { out: "rust/gen" }, go: { out: "go" }, typescript: { out: "ts" } },
    });
    const log = join(temp(), "args");
    const path = formatters({ rustfmt: passing("rustfmt", log), gofmt: passing("gofmt", log) });
    const result = cli(root, [], path);
    expect(result).toEqual({
      code: EXIT_OK,
      out: ["Generated 8 files for typescript, rust, go."],
      err: [],
    });
    const files = snapshot(root);
    expect(files["rust/gen/order.rs"]).toMatch(/\n\/\/ formatted by rustfmt\n$/);
    expect(files["go/order.go"]).toMatch(/\n\/\/ formatted by gofmt\n$/);
    expect(files["go/.gitattributes"]).not.toMatch(/formatted/);
    expect(files["ts/order.ts"]).not.toMatch(/formatted/);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.filter((c) => c.startsWith("args: --edition 2024 --config-path "))).toHaveLength(3);
    expect(calls.filter((c) => c.trim() === "args:")).toHaveLength(2);
    expect(calls.filter((c) => c === "args: --version")).toHaveLength(1);
  });

  it("skips a formatter set to none", () => {
    const root = project({
      targets: { rust: { out: "rust/gen" }, go: { out: "go" } },
      format: { rust: "none", go: "none" },
    });
    const log = join(temp(), "args");
    const path = formatters({ rustfmt: passing("rustfmt", log), gofmt: passing("gofmt", log) });
    expect(cli(root, [], path)).toEqual({
      code: EXIT_OK,
      out: ["Generated 6 files for rust, go."],
      err: [],
    });
    expect(existsSync(log)).toBe(false);
  });

  it("prints a notice and skips a formatter that isn't installed", () => {
    const root = project();
    const log = join(temp(), "args");
    const result = cli(root, [], formatters({ gofmt: passing("gofmt", log) }));
    expect(result.code).toBe(EXIT_OK);
    expect(result.err).toEqual([
      'notice: rustfmt is not installed, so the Rust output is left unformatted. Install it, or set format.rust to "none"',
    ]);
    expect(readFileSync(join(root, "rust", "gen", "order.rs"), "utf8")).not.toMatch(/formatted/);
    expect(readFileSync(join(root, "go", "order.go"), "utf8")).toMatch(/formatted by gofmt/);
  });

  it("exits 1 with the output of a formatter that fails, and writes nothing", () => {
    const root = project();
    const result = cli(root, [], formatters({ rustfmt: FAILING, gofmt: "/bin/cat" }));
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([
      "error: rust/gen/mod.rs: rustfmt failed:\nerror: expected one of `;` or `}`",
    ]);
    expect(existsSync(join(root, "rust"))).toBe(false);
    expect(existsSync(join(root, "go"))).toBe(false);
  });

  it.each([
    ["prints nothing", SILENT, "error: go/helpers.go: gofmt failed:\nit printed nothing"],
    [
      "prints something else",
      GARBAGE,
      "error: go/helpers.go: gofmt failed:\nwhat it printed doesn't start with the generated header, so it was not used",
    ],
  ])("exits 1 and keeps the previous output when the formatter %s", (_, script, message) => {
    const root = project();
    const log = join(temp(), "args");
    const good = formatters({ rustfmt: passing("rustfmt", log), gofmt: passing("gofmt", log) });
    expect(cli(root, [], good).code).toBe(EXIT_OK);
    const before = snapshot(root);
    const bad = formatters({ rustfmt: passing("rustfmt", log), gofmt: script });
    expect(cli(root, [], bad)).toEqual({ code: EXIT_FAILED, out: [], err: [message] });
    expect(snapshot(root)).toEqual(before);
    expect(cli(root, ["check"], bad).code).toBe(EXIT_FAILED);
    expect(cli(root, [], good).code).toBe(EXIT_OK);
  });

  it("treats a rustfmt whose --version fails, like a rustup proxy, as not installed", () => {
    const root = project();
    const path = formatters({ rustfmt: PROXY, gofmt: "/bin/cat" });
    const result = cli(root, [], path);
    expect(result).toEqual({
      code: EXIT_OK,
      out: ["Generated 6 files for rust, go."],
      err: [
        'notice: rustfmt is not installed, so the Rust output is left unformatted. Install it, or set format.rust to "none"',
      ],
    });
    expect(cli(root, ["check"], path)).toEqual({
      code: EXIT_FAILED,
      out: [],
      err: [
        'error: rustfmt is not installed, so the Rust output can\'t be formatted. Fix: install it, or set format.rust to "none"',
      ],
    });
  });

  it("stops a formatter that takes too long and names it", () => {
    const path = formatters({ gofmt: "exec /bin/sleep 10" });
    const started = Date.now();
    const run = (): unknown =>
      formatFiles(
        [{ path: "go/x.go", contents: "// Code generated by strictgen. DO NOT EDIT.\n" }],
        { rust: "none", go: "gofmt", typescript: "none" },
        { env: { PATH: path }, timeout: 300 },
      );
    expect(run).toThrow(FormatterFailedError);
    expect(run).toThrow("go/x.go: gofmt failed:\nit took longer than 0.3s and was stopped");
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("check", () => {
  /** A generated project and a `PATH` with passing fake formatters. */
  function generated(): { root: string; path: string } {
    const root = project();
    const log = join(temp(), "args");
    const path = formatters({ rustfmt: passing("rustfmt", log), gofmt: passing("gofmt", log) });
    expect(cli(root, [], path).code).toBe(EXIT_OK);
    return { root, path };
  }

  it("exits 0 and writes nothing when the formatted output matches", () => {
    const { root, path } = generated();
    const before = snapshot(root);
    const mtime = statSync(join(root, "go", "order.go")).mtimeMs;
    expect(cli(root, ["check"], path)).toEqual({
      code: EXIT_OK,
      out: ["6 generated files are up to date."],
      err: [],
    });
    expect(snapshot(root)).toEqual(before);
    expect(statSync(join(root, "go", "order.go")).mtimeMs).toBe(mtime);
  });

  it("lists every file that differs, is missing or is stale, and exits 1", () => {
    const { root, path } = generated();
    writeFileSync(join(root, "go", "order.go"), "changed");
    rmSync(join(root, "rust", "gen", "helpers.rs"));
    writeFileSync(join(root, "rust", "gen", "extra.rs"), "hand written");
    writeFileSync(join(root, "go", "old.go"), "// Code generated by strictgen. DO NOT EDIT.\n");
    writeFileSync(join(root, "go", "hand_test.go"), "package types\n");
    const before = snapshot(root);
    const result = cli(root, ["check"], path);
    expect(result).toEqual({
      code: EXIT_FAILED,
      out: [],
      err: [
        "error: 4 files are out of date. Run strictgen generate to update them:",
        "  stale:   go/old.go",
        "  differs: go/order.go",
        "  stale:   rust/gen/extra.rs",
        "  missing: rust/gen/helpers.rs",
      ],
    });
    expect(snapshot(root)).toEqual(before);
  });

  it("compares with formatted output, so unformatted files on disk differ", () => {
    const root = project();
    expect(cli(root, []).code).toBe(EXIT_OK);
    const log = join(temp(), "args");
    const path = formatters({ rustfmt: passing("rustfmt", log), gofmt: passing("gofmt", log) });
    const result = cli(root, ["check"], path);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err[0]).toBe("error: 5 files are out of date. Run strictgen generate to update them:");
  });

  it("exits 1 when a configured formatter isn't installed", () => {
    const { root } = generated();
    const result = cli(root, ["check"]);
    expect(result).toEqual({
      code: EXIT_FAILED,
      out: [],
      err: [
        'error: rustfmt is not installed, so the Rust output can\'t be formatted. Fix: install it, or set format.rust to "none"',
      ],
    });
  });

  it("exits 1 with the output of a formatter that fails", () => {
    const { root } = generated();
    const result = cli(root, ["check"], formatters({ rustfmt: FAILING, gofmt: "/bin/cat" }));
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err[0]).toBe("error: rust/gen/mod.rs: rustfmt failed:\nerror: expected one of `;` or `}`");
  });

  it("reports a project never generated as missing files", () => {
    const root = project({
      targets: { go: { out: "go" } },
      format: { go: "none" },
    });
    const result = cli(root, ["check"]);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err.slice(1)).toEqual([
      "  missing: go/.gitattributes",
      "  missing: go/helpers.go",
      "  missing: go/order.go",
    ]);
  });
});

describe("dirs", () => {
  const config = {
    targets: { typescript: { out: "web/types" }, go: { out: "go/types", shared: true } },
  };

  it("prints one folder per line, owned and shared, in config order", () => {
    expect(cli(project(config), ["dirs"])).toEqual({
      code: EXIT_OK,
      out: ["go/types", "web/types"],
      err: [],
    });
  });

  it("prints { target, dir, shared } objects with --json", () => {
    const result = cli(project(config), ["dirs", "--json"]);
    expect(result.code).toBe(EXIT_OK);
    expect(JSON.parse(result.out.join("\n"))).toEqual([
      { target: "go", dir: "go/types", shared: true },
      { target: "typescript", dir: "web/types", shared: false },
    ]);
  });

  it("lists the Rust fixture folder as a Rust folder", () => {
    const root = project({
      targets: { rust: { out: "rust/gen", fixtures: { out: "rust/tests/gen", crate: "my_types" } } },
    });
    expect(JSON.parse(cli(root, ["dirs", "--json"]).out.join("\n"))).toEqual([
      { target: "rust", dir: "rust/gen", shared: false },
      { target: "rust", dir: "rust/tests/gen", shared: false },
    ]);
  });
});

describe("file system errors", () => {
  it("reports an out folder through a dangling symlink with the path, and exits 1", () => {
    const root = project({
      targets: { go: { out: "link/types", shared: false } },
      format: { go: "none" },
    });
    symlinkSync(join(root, "nowhere"), join(root, "link"));
    const result = cli(root, []);
    noStack(result);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err).toHaveLength(1);
    expect(result.err[0]).toMatch(
      /^error: link(\/types)?: can't write the output: a folder on the way is missing, or is a symlink that points nowhere \(ENOENT\)$/,
    );
  });

  it("reports a folder where a generated file goes in a shared folder, and exits 1", () => {
    const root = project({ targets: { go: { out: "go" } }, format: { go: "none" } });
    mkdirSync(join(root, "go", "helpers.go"), { recursive: true });
    const result = cli(root, []);
    noStack(result);
    expect(result).toEqual({
      code: EXIT_FAILED,
      out: [],
      err: [
        "error: go/helpers.go: a folder is in the way of a generated file. Fix: move what it holds elsewhere and remove it",
      ],
    });
  });

  it("check reports a folder where a generated file goes as a difference", () => {
    const root = project({ targets: { go: { out: "go" } }, format: { go: "none" } });
    expect(cli(root, []).code).toBe(EXIT_OK);
    rmSync(join(root, "go", "helpers.go"));
    mkdirSync(join(root, "go", "helpers.go"));
    const result = cli(root, ["check"]);
    expect(result.code).toBe(EXIT_FAILED);
    expect(result.err.slice(1)).toEqual(["  differs: go/helpers.go"]);
  });
});

describe("the built command", () => {
  it("exits quietly when the reader of its output goes away", async () => {
    const out = temp();
    const tsc = spawnSync(
      process.execPath,
      [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json", "--outDir", out],
      { encoding: "utf8" },
    );
    expect(tsc.stdout + tsc.stderr).toBe("");
    const root = project();
    const child = spawn(process.execPath, [join(out, "cli.js"), "dirs", "--json"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(stderr).toBe("");
    expect(code).toBe(0);
  }, 30_000);
});
