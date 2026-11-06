import { basename, join, relative, resolve, sep } from "node:path";

import { buildModel } from "./build.js";
import type { Config } from "./config.js";
import { formatFiles } from "./format.js";
import type { Target } from "./main.js";
import type { Decl, Model, TypeExpr } from "./model.js";
import type { Json, SchemaSet } from "./schema.js";
import { CodegenError, defNames, isDefsOnly, isObject, loadSchemas } from "./schema.js";
import { configTargets } from "./targets.js";

/**
 * A request `explain` can't answer: an unknown file or pointer, or one that names no generated
 * type. The CLI exits 2 for it.
 */
export class ExplainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExplainError";
  }
}

/** A generation error, as `explain` shows it. */
export interface Failure {
  readonly path: string;
  readonly rule: string;
  readonly reason: string;
  readonly hint?: string;
}

/** What one configured target generates for the explained location. */
export interface TargetExplanation {
  /** The target, like `rust`. */
  readonly target: string;
  /** The language, like `Rust`, for headings. */
  readonly language: string;
  /** The declarations, formatted like `generate` writes them, when the target generated them. */
  readonly code?: string;
  /** Why the output is left unformatted, when its formatter isn't installed. */
  readonly unformatted?: string;
  /** Why the target failed, when it did. */
  readonly failure?: Failure;
}

/** What `explain` found for a schema location. */
export interface Explanation {
  /** The location, like `user.json#/$defs/address`. */
  readonly location: string;
  /** The model declarations generated from the location, in model order. */
  readonly decls: readonly Decl[];
  /** Set when the model can't be built, so no target generates anything. */
  readonly failure?: Failure;
  /** One entry per configured target: Rust, Go, then TypeScript. Empty when the build fails. */
  readonly targets: readonly TargetExplanation[];
}

const LANGUAGES: Readonly<Record<string, string>> = {
  rust: "Rust",
  go: "Go",
  typescript: "TypeScript",
};
/** The order targets are explained in. */
const ORDER = Object.keys(LANGUAGES);

/** `path` relative to `cwd`, with `/` separators, for messages. */
function shown(cwd: string, path: string): string {
  const rel = relative(cwd, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

function failureOf(error: CodegenError): Failure {
  return {
    path: error.path,
    rule: error.rule,
    reason: error.reason,
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  };
}

/** Splits `user.json#/$defs/address` into the schema name and the pointer, checking both. */
function parseLocation(
  config: Config,
  arg: string,
  cwd: string,
): { name: string; pointer: string } {
  const hash = arg.indexOf("#");
  const file = hash === -1 ? arg : arg.slice(0, hash);
  const pointer = hash === -1 ? "" : arg.slice(hash + 1);
  if (!file.endsWith(".json") || basename(file) === ".json") {
    throw new ExplainError(
      `${JSON.stringify(arg)} names no schema file. ` +
        "Use <file>.json or <file>.json#/<pointer>, like user.json#/$defs/address",
    );
  }
  if (pointer !== "" && !pointer.startsWith("/")) {
    throw new ExplainError(`the pointer after # must start with /, like user.json#/$defs/address`);
  }
  const base = basename(file);
  if (base !== file && resolve(cwd, file) !== join(config.schemas, base)) {
    throw new ExplainError(`${file} is not in the schemas folder ${shown(cwd, config.schemas)}`);
  }
  return { name: base.slice(0, -".json".length), pointer };
}

/** The value a JSON Pointer names in `root`, or undefined when it names nothing. */
function pointed(root: Json, pointer: string): Json | undefined {
  if (pointer === "") return root;
  let current: Json | undefined = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      current = /^(0|[1-9][0-9]*)$/.test(segment) ? current[Number(segment)] : undefined;
    } else if (isObject(current)) {
      current = Object.hasOwn(current, segment) ? current[segment] : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Fails with a clear message when the location names nothing, or names no generated type. */
function noType(set: SchemaSet, name: string, pointer: string, location: string): never {
  const file = set.find((s) => s.name === name);
  if (file !== undefined && pointer === "" && isDefsOnly(file.root)) {
    const defs = defNames(file.root);
    throw new ExplainError(
      `${location} has no root type, only $defs` +
        (defs[0] === undefined ? "" : `. Explain one of them, like ${name}.json#/$defs/${defs[0]}`),
    );
  }
  throw new ExplainError(
    `no type is generated for ${location}: it is used inline, or only as an allOf base. ` +
      "Explain a schema root, a $defs entry, or an inline object, enum or union",
  );
}

/** How a declaration starts in one language's generated source, and what leads into it. */
interface Syntax {
  readonly extension: string;
  /** The declared name when `line` starts a declaration, like `pub struct User {`. */
  readonly declares: (line: string) => string | undefined;
  /** True for a line that belongs to the declaration below it: a doc comment or an attribute. */
  readonly leads: (line: string) => boolean;
}

const RUST: Syntax = {
  extension: ".rs",
  declares: (line) => /^pub (?:struct|enum|type) ([A-Za-z0-9_]+)\b/.exec(line)?.[1],
  leads: (line) => line.startsWith("///") || line.startsWith("#["),
};

const GO: Syntax = {
  extension: ".go",
  declares: (line) => /^\/\/ ([A-Za-z0-9_]+) is generated from /.exec(line)?.[1],
  leads: () => false,
};

const TYPESCRIPT: Syntax = {
  extension: ".ts",
  declares: (line) => /^export (?:type|interface) ([A-Za-z0-9_$]+)\b/.exec(line)?.[1],
  leads: (line) => line.startsWith("/**") || line.startsWith(" *"),
};

const SYNTAX: Readonly<Record<string, Syntax>> = { rust: RUST, go: GO, typescript: TYPESCRIPT };

/**
 * The declaration of `name` in generated source `contents`, with its comments and attributes,
 * up to the next declaration, so helper impls and functions that belong to it come along.
 */
function declarationText(contents: string, syntax: Syntax, name: string): string | undefined {
  const lines = contents.split("\n");
  const top = (index: number): number => {
    let start = index;
    while (start > 0 && syntax.leads(lines[start - 1] ?? "")) start--;
    return start;
  };
  const at = lines.findIndex((line) => syntax.declares(line) === name);
  if (at === -1) return undefined;
  const next = lines.findIndex((line, i) => i > at && syntax.declares(line) !== undefined);
  let end = next === -1 ? lines.length : top(next);
  while (end > at && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(top(at), end).join("\n");
}

/** What one target generates for `decls`, or why it fails. */
function explainTarget(
  config: Config,
  model: Model,
  schemas: SchemaSet,
  decls: readonly Decl[],
  target: Target,
  env: NodeJS.ProcessEnv,
): TargetExplanation {
  const language = LANGUAGES[target.name] ?? target.name;
  const syntax = SYNTAX[target.name];
  let files;
  try {
    files = target.emit(model, schemas);
  } catch (error) {
    if (!(error instanceof CodegenError)) throw error;
    return { target: target.name, language, failure: failureOf(error) };
  }
  if (syntax === undefined) return { target: target.name, language };
  const owners = files.filter(
    (f) =>
      f.path.endsWith(syntax.extension) &&
      decls.some((d) => declarationText(f.contents, syntax, d.name) !== undefined),
  );
  let unformatted: string | undefined;
  const formatted = formatFiles(owners, config.format, {
    env,
    header: config.header,
    onMissing: ({ formatter }) => {
      unformatted = `${formatter.command} is not installed`;
    },
  });
  const parts = decls.flatMap((decl) =>
    formatted.flatMap((f) => declarationText(f.contents, syntax, decl.name) ?? []),
  );
  return {
    target: target.name,
    language,
    code: parts.join("\n\n"),
    ...(unformatted === undefined ? {} : { unformatted }),
  };
}

/**
 * Explains how the schema location `arg`, like `user.json#/$defs/address` or `user.json` for a
 * root, maps in every configured target. Throws an {@link ExplainError} for an unknown file or
 * pointer, or one that names no generated type, and a {@link CodegenError} when the schemas
 * can't be read.
 */
export function explain(
  config: Config,
  arg: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Explanation {
  const { name, pointer } = parseLocation(config, arg, cwd);
  const schemas = loadSchemas(
    config.schemas,
    config.idBase === undefined ? {} : { idBase: config.idBase },
  );
  const file = schemas.find((s) => s.name === name);
  if (file === undefined) {
    throw new ExplainError(
      `there is no ${name}.json in the schemas folder ${shown(cwd, config.schemas)}`,
    );
  }
  const location = `${name}.json#${pointer}`;
  if (pointed(file.root, pointer) === undefined) {
    throw new ExplainError(`${name}.json has nothing at #${pointer}`);
  }
  let model: Model;
  try {
    model = buildModel(schemas, {
      ...(config.ids === undefined ? {} : { ids: config.ids }),
      validation: config.validation,
    });
  } catch (error) {
    if (!(error instanceof CodegenError)) throw error;
    return { location, decls: [], failure: failureOf(error), targets: [] };
  }
  const decls = model.decls.filter((d) => d.path === location);
  if (decls.length === 0) noType(schemas, name, pointer, location);
  return {
    location,
    decls,
    targets: configTargets(config)
      .sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name))
      .map((t) => explainTarget(config, model, schemas, decls, t, env)),
  };
}

/** A type as one short phrase, like `array of string` or `map of string to Price`. */
export function typePhrase(type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "literal":
      return `const ${String(type.value)}`;
    case "any":
      return "any JSON value";
    case "nonNull":
      return "any JSON value except null";
    case "array":
      return `array of ${typePhrase(type.items)}`;
    case "map":
      return `map of ${typePhrase(type.key)} to ${typePhrase(type.value)}`;
    default:
      return type.kind;
  }
}

/** The model of one declaration, as lines: its kind and name, then what it holds. */
export function describeDecl(decl: Decl): string[] {
  switch (decl.kind) {
    case "struct": {
      const count = `${String(decl.fields.length)} fields`;
      const width = Math.max(0, ...decl.fields.map((f) => f.name.length));
      const field = (f: (typeof decl.fields)[number]): string =>
        `  ${f.name.padEnd(width)}  ${f.required ? "required" : "optional"}  ${typePhrase(f.type)}`;
      return [
        `struct ${decl.name}, ${decl.closed ? "closed" : "open"}, ${count}`,
        ...decl.fields.map(field),
        ...(decl.rest === undefined
          ? []
          : [`  other keys: ${typePhrase(decl.rest.key)} to ${typePhrase(decl.rest.value)}`]),
        ...(decl.forbidden.length === 0 ? [] : [`  must be absent: ${decl.forbidden.join(", ")}`]),
      ];
    }
    case "enum":
      return [`enum ${decl.name}: ${decl.values.map((v) => JSON.stringify(v)).join(", ")}`];
    case "tagged":
      return [
        `tagged union ${decl.name}, picked by ${JSON.stringify(decl.tag)}`,
        ...decl.variants.map((v) => `  ${JSON.stringify(v.value)}: ${v.type}`),
      ];
    case "untagged":
      return [
        `untagged union ${decl.name}, tried in this order`,
        ...decl.variants.map((v) => `  ${v.name}: ${typePhrase(v.type)}`),
      ];
    case "alias":
      return [`alias ${decl.name} = ${typePhrase(decl.type)}`];
    case "id":
      return [`id ${decl.name}, a string with a type of its own`];
  }
}

function failureLines(failure: Failure, location: string): string[] {
  const elsewhere = failure.path !== location && !failure.path.startsWith(`${location}/`);
  return [
    elsewhere
      ? `Generation fails at ${failure.path}, so this can't be generated either:`
      : `Generation fails at ${failure.path}:`,
    `  rule:   ${failure.rule}`,
    `  reason: ${failure.reason}`,
    ...(failure.hint === undefined ? [] : [`  hint:   ${failure.hint}`]),
  ];
}

/** The explanation as text lines, for the terminal. */
export function explanationLines(explanation: Explanation): string[] {
  const { location } = explanation;
  if (explanation.failure !== undefined) {
    return [location, "", ...failureLines(explanation.failure, location)];
  }
  const indent = (line: string): string => `  ${line}`;
  const model = explanation.decls.flatMap((d) => describeDecl(d).map(indent));
  const lines = [location, "", "Model:", ...model];
  for (const target of explanation.targets) {
    lines.push("");
    if (target.failure !== undefined) {
      lines.push(`${target.language}:`, ...failureLines(target.failure, location).map(indent));
      continue;
    }
    const note = target.unformatted === undefined ? "" : ` (unformatted: ${target.unformatted})`;
    lines.push(`${target.language}${note}:`, ...(target.code ?? "").split("\n"));
  }
  return lines;
}

/** True when every target generated the location. */
export function explained(explanation: Explanation): boolean {
  return (
    explanation.failure === undefined && explanation.targets.every((t) => t.failure === undefined)
  );
}
