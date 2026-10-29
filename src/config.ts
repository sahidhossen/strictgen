import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { IdRule } from "./build.js";
import { DEFAULT_HEADER } from "./common.js";
import type { LintAllow } from "./emit-rust.js";
import { DEFAULT_ALLOW } from "./emit-rust.js";
import { GO_PACKAGE } from "./emit-go.js";
import { fsReason, isFsError } from "./fs-error.js";
import { samePath, within } from "./paths.js";

/** The config file strictgen reads from the project root unless another path is given. */
export const CONFIG_FILE = "strictgen.json";

/**
 * A config file that can't be read or breaks a rule of `strictgen.schema.json`. `option` is the
 * path of the offending option, like `targets.go.package`, or `""` for the whole file.
 */
export class ConfigError extends Error {
  constructor(
    readonly file: string,
    readonly option: string,
    readonly problem: string,
  ) {
    super(`${file}: ${option === "" ? "" : `${option}: `}${problem}`);
    this.name = "ConfigError";
  }
}

/** How a decoder treats unknown keys. Not yet active. */
export type ReadMode = "strict" | "report";

/** The Rust fixture registry: where `registry.rs` goes, and the Rust path to the generated types. */
export interface RustFixtures {
  readonly out: string;
  readonly crate: string;
}

export interface RustConfig {
  readonly out: string;
  /** Left out when the registry is off. */
  readonly fixtures?: RustFixtures;
  readonly allow: readonly LintAllow[];
  readonly embedSchemas: boolean;
  readonly read: ReadMode;
}

export interface GoConfig {
  readonly out: string;
  readonly package: string;
  readonly shared: boolean;
  /** Writes `registry_test.go`, the fixture registry. */
  readonly fixtures: boolean;
  readonly read: ReadMode;
}

export interface TypeScriptConfig {
  readonly out: string;
  readonly decoders: boolean;
  readonly read: ReadMode;
}

export interface Targets {
  readonly rust?: RustConfig;
  readonly go?: GoConfig;
  readonly typescript?: TypeScriptConfig;
}

/** Not yet active. */
export interface LlmConfig {
  readonly profiles: readonly string[];
  readonly out: string;
  readonly cleanup: boolean;
}

/** Not yet active. */
export interface DocsConfig {
  readonly out: string;
  readonly format: "markdown";
}

/** The formatter each language's output goes through, or `none`. */
export interface FormatConfig {
  readonly rust: "rustfmt" | "none";
  readonly go: "gofmt" | "none";
  readonly typescript: "none";
}

/**
 * A loaded config, with defaults applied and every path absolute, resolved against `root`,
 * the folder that holds the config file.
 */
export interface Config {
  readonly file: string;
  readonly root: string;
  readonly schemas: string;
  readonly idBase?: string;
  readonly ids?: IdRule;
  readonly header: string;
  readonly validation: boolean;
  readonly targets: Targets;
  readonly llm?: LlmConfig;
  readonly docs?: DocsConfig;
  readonly format: FormatConfig;
}

/** Go keywords, and the blank identifier, which can't name a package. */
export const GO_KEYWORDS: readonly string[] = (
  "_ break case chan const continue default defer else fallthrough for func go goto if import " +
  "interface map package range return select struct switch type var"
).split(" ");

const READ_MODES = ["strict", "report"] as const;
const ONE_LINE = /^[^\u0000-\u001f\u007f]+$/;
const GO_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUST_PATH = /^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/;
const LINT = /^[a-z][a-z0-9_]*(::[a-z][a-z0-9_]*)?$/;
const PROFILE = /^[a-z][a-z0-9-]*$/;

type Raw = Readonly<Record<string, unknown>>;

/** Reads the values of one config file, failing with the option path. */
class Reader {
  constructor(readonly file: string) {}

  fail(option: string, problem: string): never {
    throw new ConfigError(this.file, option, problem);
  }

  /** An object with only `known` keys. */
  object(value: unknown, option: string, known: readonly string[]): Raw {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(option, option === "" ? "the config must be a JSON object" : "must be an object");
    }
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        this.fail(join(option, key), `unknown option. Known options: ${known.join(", ")}`);
      }
    }
    return value as Raw;
  }

  required(object: Raw, option: string, key: string): unknown {
    if (object[key] === undefined) this.fail(join(option, key), "is required");
    return object[key];
  }

  string(value: unknown, option: string, pattern?: RegExp, expected?: string): string {
    if (typeof value !== "string") this.fail(option, "must be a string");
    if (value === "") this.fail(option, "must not be empty");
    if (pattern !== undefined && !pattern.test(value)) {
      this.fail(option, `${JSON.stringify(value)} is not ${expected ?? `matching ${String(pattern)}`}`);
    }
    return value;
  }

  boolean(value: unknown, option: string, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") this.fail(option, "must be true or false");
    return value;
  }

  oneOf<T extends string>(value: unknown, option: string, values: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      this.fail(option, `must be one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
    }
    return value as T;
  }
}

function join(option: string, key: string): string {
  return option === "" ? key : `${option}.${key}`;
}

/**
 * Reads the config file at `path`, or `strictgen.json` in `cwd`, validates it against the rules of
 * `strictgen.schema.json`, applies defaults and resolves paths against the folder that holds it.
 * Throws a {@link ConfigError} naming the option and the problem.
 */
export function loadConfig(path?: string, cwd: string = process.cwd()): Config {
  const file = resolve(cwd, path ?? CONFIG_FILE);
  const shown = path ?? CONFIG_FILE;
  if (!existsSync(file)) throw new ConfigError(shown, "", "config file not found");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (!isFsError(error)) throw error;
    throw new ConfigError(shown, "", `can't read it: ${fsReason(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      shown,
      "",
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseConfig(value, file, shown);
}

/**
 * Validates a parsed config and applies defaults. `file` is the absolute path of the config file,
 * whose folder relative paths resolve against, and `shown` names it in errors.
 */
export function parseConfig(value: unknown, file: string, shown: string = file): Config {
  const r = new Reader(shown);
  const root = dirname(file);
  const raw = r.object(value, "", [
    "$schema",
    "schemas",
    "idBase",
    "ids",
    "header",
    "validation",
    "targets",
    "llm",
    "docs",
    "format",
  ]);
  if (raw.$schema !== undefined && typeof raw.$schema !== "string") {
    r.fail("$schema", "must be a string");
  }
  const path = (v: unknown, option: string): string => resolve(root, r.string(v, option));
  const schemas = raw.schemas === undefined ? resolve(root, "schemas") : path(raw.schemas, "schemas");
  const idBase =
    raw.idBase === undefined
      ? undefined
      : r.string(raw.idBase, "idBase", /^.+[/#]$/, "a base that ends in / or #");
  const ids = raw.ids === undefined ? undefined : readIds(r, raw.ids);
  const header =
    raw.header === undefined
      ? DEFAULT_HEADER
      : r.string(raw.header, "header", ONE_LINE, "one line without control characters");
  const validation = r.boolean(raw.validation, "validation", true);
  const targets = readTargets(r, r.required(raw, "", "targets"), path);
  const llm = raw.llm === undefined ? undefined : readLlm(r, raw.llm, path);
  const docs = raw.docs === undefined ? undefined : readDocs(r, raw.docs, path);
  const format = readFormat(r, raw.format);
  const config: Config = {
    file,
    root,
    schemas,
    ...(idBase === undefined ? {} : { idBase }),
    ...(ids === undefined ? {} : { ids }),
    header,
    validation,
    targets,
    ...(llm === undefined ? {} : { llm }),
    ...(docs === undefined ? {} : { docs }),
    format,
  };
  checkFolders(r, config);
  return config;
}

function readIds(r: Reader, value: unknown): IdRule {
  const o = r.object(value, "ids", ["file", "suffix"]);
  return {
    file: r.string(r.required(o, "ids", "file"), "ids.file"),
    suffix: r.string(r.required(o, "ids", "suffix"), "ids.suffix"),
  };
}

type Resolve = (value: unknown, option: string) => string;

function readTargets(r: Reader, value: unknown, path: Resolve): Targets {
  const o = r.object(value, "targets", ["rust", "go", "typescript"]);
  if (Object.keys(o).length === 0) {
    r.fail("targets", "lists no target. Add at least one of rust, go or typescript");
  }
  const rust = o.rust === undefined ? undefined : readRust(r, o.rust, path);
  const go = o.go === undefined ? undefined : readGo(r, o.go, path);
  const typescript = o.typescript === undefined ? undefined : readTypeScript(r, o.typescript, path);
  return {
    ...(rust === undefined ? {} : { rust }),
    ...(go === undefined ? {} : { go }),
    ...(typescript === undefined ? {} : { typescript }),
  };
}

function readRust(r: Reader, value: unknown, path: Resolve): RustConfig {
  const at = "targets.rust";
  const o = r.object(value, at, ["out", "fixtures", "allow", "embedSchemas", "read"]);
  const out = path(r.required(o, at, "out"), `${at}.out`);
  const fixtures = readFixtures(r, o.fixtures, path);
  return {
    out,
    ...(fixtures === undefined ? {} : { fixtures }),
    allow: o.allow === undefined ? DEFAULT_ALLOW : readAllow(r, o.allow),
    embedSchemas: r.boolean(o.embedSchemas, `${at}.embedSchemas`, false),
    read: r.oneOf(o.read, `${at}.read`, READ_MODES, "strict"),
  };
}

function readFixtures(r: Reader, value: unknown, path: Resolve): RustFixtures | undefined {
  const at = "targets.rust.fixtures";
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    r.fail(at, "must be false or an object { out, crate }");
  }
  const o = r.object(value, at, ["out", "crate"]);
  return {
    out: path(r.required(o, at, "out"), `${at}.out`),
    crate: r.string(
      r.required(o, at, "crate"),
      `${at}.crate`,
      RUST_PATH,
      "a Rust path, like my_types or my_types::generated",
    ),
  };
}

function readAllow(r: Reader, value: unknown): LintAllow[] {
  const at = "targets.rust.allow";
  if (!Array.isArray(value)) r.fail(at, "must be an array");
  const seen = new Set<string>();
  return value.map((item: unknown, i) => {
    const option = `${at}[${String(i)}]`;
    const o = r.object(item, option, ["lint", "reason"]);
    const lint = r.string(
      r.required(o, option, "lint"),
      `${option}.lint`,
      LINT,
      "a lint name, like clippy::doc_markdown",
    );
    if (seen.has(lint)) r.fail(`${option}.lint`, `${lint} is listed twice`);
    seen.add(lint);
    const reason = r.string(
      r.required(o, option, "reason"),
      `${option}.reason`,
      ONE_LINE,
      "one line without control characters",
    );
    return { lint, reason };
  });
}

function readGo(r: Reader, value: unknown, path: Resolve): GoConfig {
  const at = "targets.go";
  const o = r.object(value, at, ["out", "package", "shared", "fixtures", "read"]);
  const out = path(r.required(o, at, "out"), `${at}.out`);
  const pkg =
    o.package === undefined
      ? GO_PACKAGE
      : r.string(o.package, `${at}.package`, GO_IDENTIFIER, "a Go identifier");
  if (GO_KEYWORDS.includes(pkg)) {
    r.fail(`${at}.package`, `${JSON.stringify(pkg)} can't name a Go package`);
  }
  return {
    out,
    package: pkg,
    shared: r.boolean(o.shared, `${at}.shared`, true),
    fixtures: r.boolean(o.fixtures, `${at}.fixtures`, false),
    read: r.oneOf(o.read, `${at}.read`, READ_MODES, "strict"),
  };
}

function readTypeScript(r: Reader, value: unknown, path: Resolve): TypeScriptConfig {
  const at = "targets.typescript";
  const o = r.object(value, at, ["out", "decoders", "read"]);
  return {
    out: path(r.required(o, at, "out"), `${at}.out`),
    decoders: r.boolean(o.decoders, `${at}.decoders`, true),
    read: r.oneOf(o.read, `${at}.read`, READ_MODES, "strict"),
  };
}

function readLlm(r: Reader, value: unknown, path: Resolve): LlmConfig {
  const o = r.object(value, "llm", ["profiles", "out", "cleanup"]);
  const list = r.required(o, "llm", "profiles");
  if (!Array.isArray(list)) r.fail("llm.profiles", "must be an array");
  if (list.length === 0) r.fail("llm.profiles", "must list at least one profile");
  const profiles = list.map((p: unknown, i) =>
    r.string(p, `llm.profiles[${String(i)}]`, PROFILE, "a profile name, like openai"),
  );
  const twice = profiles.find((p, i) => profiles.indexOf(p) !== i);
  if (twice !== undefined) r.fail("llm.profiles", `${twice} is listed twice`);
  return {
    profiles,
    out: path(r.required(o, "llm", "out"), "llm.out"),
    cleanup: r.boolean(o.cleanup, "llm.cleanup", false),
  };
}

function readDocs(r: Reader, value: unknown, path: Resolve): DocsConfig {
  const o = r.object(value, "docs", ["out", "format"]);
  return {
    out: path(r.required(o, "docs", "out"), "docs.out"),
    format: r.oneOf(o.format, "docs.format", ["markdown"], "markdown"),
  };
}

function readFormat(r: Reader, value: unknown): FormatConfig {
  const o = value === undefined ? {} : r.object(value, "format", ["rust", "go", "typescript"]);
  return {
    rust: r.oneOf(o.rust, "format.rust", ["rustfmt", "none"], "rustfmt"),
    go: r.oneOf(o.go, "format.go", ["gofmt", "none"], "gofmt"),
    typescript: r.oneOf(o.typescript, "format.typescript", ["none"], "none"),
  };
}

/** A folder a target writes to. An owned one is cleared before writing. */
export interface ConfigFolder {
  readonly option: string;
  readonly path: string;
  readonly owned: boolean;
}

/** The folders the targets write to, in config order. */
export function configFolders(config: Config): ConfigFolder[] {
  const { rust, go, typescript } = config.targets;
  return [
    ...(rust === undefined ? [] : [{ option: "targets.rust.out", path: rust.out, owned: true }]),
    ...(rust?.fixtures === undefined
      ? []
      : [{ option: "targets.rust.fixtures.out", path: rust.fixtures.out, owned: true }]),
    ...(go === undefined ? [] : [{ option: "targets.go.out", path: go.out, owned: !go.shared }]),
    ...(typescript === undefined
      ? []
      : [{ option: "targets.typescript.out", path: typescript.out, owned: true }]),
  ];
}

/**
 * Owned folders are cleared before writing, so none may hold the config file, the schemas or
 * another target's folder, and no two targets may write to the same folder. Paths are compared
 * as the filesystem sees them: symlinks resolved and case ignored.
 */
function checkFolders(r: Reader, config: Config): void {
  const folders = configFolders(config);
  for (const folder of folders) {
    if (!folder.owned) continue;
    if (within(config.file, folder.path)) {
      r.fail(folder.option, "holds the config file, and the folder is cleared before writing");
    }
    if (within(config.schemas, folder.path)) {
      r.fail(folder.option, "holds the schemas folder, and the folder is cleared before writing");
    }
  }
  for (const [i, a] of folders.entries()) {
    for (const b of folders.slice(i + 1)) {
      if (samePath(a.path, b.path)) r.fail(b.option, `is the same folder as ${a.option}`);
      const [outer, inner] = within(b.path, a.path) ? [a, b] : [b, a];
      if (outer.owned && within(inner.path, outer.path)) {
        r.fail(inner.option, `is inside ${outer.option}, which is cleared before writing`);
      }
    }
  }
}
