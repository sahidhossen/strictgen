import type { EmittedFile } from "./common.js";
import { bySchema, commentHeader, compare, declTypes, DEFAULT_HEADER } from "./common.js";
import type {
  AliasDecl,
  Decl,
  EnumDecl,
  Field,
  Model,
  StructDecl,
  TaggedDecl,
  TypeExpr,
  UntaggedDecl,
} from "./model.js";
import { Checks, limitsOf } from "./checks.js";
import type { ReadMode } from "./config.js";
import { GO_CODES, GO_NON_NULL, goHelpersBody } from "./go-helpers.js";
import { GO_KEYWORDS, pascal, RENAME_TYPE, variantName } from "./naming.js";
import { CodegenError } from "./schema.js";

/** The Go package every generated file belongs to, unless the options name another. */
export const GO_PACKAGE = "types";
/** Name of the file with the built in types and the decoding functions. */
export const GO_HELPERS = "helpers.go";
/** Name of the generated fixture registry, a test file. */
export const GO_FIXTURES = "registry_test.go";
export { GO_NON_NULL };

/** The error code constants the helpers file declares, like `CodeUnknownKey`. */
const CODES = GO_CODES;

/**
 * Exported names the helpers file declares, besides the literal types. The report mode names
 * are reserved in strict mode too, so switching the mode never makes a schema fail.
 */
const RESERVED = new Set([
  GO_NON_NULL,
  "DecodeError",
  ...GO_CODES,
  "Report",
  "Reported",
  "SetUnknownKeyHook",
]);

/** File name suffixes that put a Go file behind a build constraint or make it a test. */
const CONSTRAINED = new Set(
  (
    "test aix android darwin dragonfly freebsd hurd illumos ios js linux nacl netbsd openbsd plan9 " +
    "solaris wasip1 windows zos 386 amd64 amd64p32 arm armbe arm64 arm64be loong64 mips mipsle mips64 " +
    "mips64le mips64p32 mips64p32le ppc ppc64 ppc64le riscv riscv64 s390 s390x sparc sparc64 wasm"
  ).split(" "),
);

/** Characters encoding/json accepts in a struct tag name. Any other makes it fall back to the field name. */
const TAG_NAME = /^[A-Za-z0-9!#$%&()*+\-./:;<=>?@[\]^_{|}~ ]+$/;

/** Methods generated types carry, which no field may be named like. */
const METHODS = new Set(["MarshalJSON", "UnmarshalJSON"]);

interface Ctx {
  readonly decls: ReadonlyMap<string, Decl>;
  /** True in report mode. */
  readonly report: boolean;
  /** Which values have constraints to check. */
  readonly checks: Checks;
}

function context(model: Model, report: boolean): Ctx {
  return {
    decls: new Map(model.decls.map((d) => [d.name, d])),
    report,
    checks: new Checks(model.decls),
  };
}

/** Options for the Go emitters. */
export interface GoOptions {
  /** The header text each file starts with, as a comment. */
  readonly header?: string;
  /** The package clause of every file. Defaults to {@link GO_PACKAGE}. */
  readonly package?: string;
  /**
   * How decoders treat unknown keys: `strict` fails on them, `report` accepts them, reports
   * their paths and adds `Report` and a `ReportX` per tagged union. Defaults to `strict`.
   */
  readonly read?: ReadMode;
}

/** The first lines of a generated Go file: header comment, then `doc` and the package clause. */
function goHead(options: GoOptions, doc: string): string {
  const comment = doc === "" ? "" : `// ${doc}\n\n`;
  return `${commentHeader(options.header ?? DEFAULT_HEADER)}\n\n${comment}package ${options.package ?? GO_PACKAGE}\n\n`;
}

/**
 * Emits the Go files for the Go target's folder: one file per schema, named after the
 * schema file (`user-profile` to `user_profile.go`), and `helpers.go` with
 * the built in types and decoding functions. Everything is in one package, so
 * names are unique across schemas and files need no imports between them.
 */
export function emitGo(model: Model, options: GoOptions = {}): EmittedFile[] {
  const ctx = context(model, options.read === "report");
  checkNames(model);
  const files = [...bySchema(model)].map(([schema, decls]) => ({
    name: fileName(schema, decls[0]?.path ?? schema),
    contents: goFile(
      goHead(options, `Types for ${schema}.json.`),
      decls.some((d) => usesJSON(d) || marshalsKeys(ctx, d)) ? ["encoding/json"] : [],
      decls.map((d) => declaration(ctx, d)),
    ),
  }));
  const literals = literalsOf(model);
  return [
    {
      name: GO_HELPERS,
      contents: goFile(goHead(options, ""), helperImports(ctx.report), [
        goHelpersBody(ctx.report),
        ...literals.map(literalType),
      ]),
    },
    ...files,
  ];
}

/** True for a constrained alias of a map with enum keys, whose MarshalJSON calls json.Marshal. */
function marshalsKeys(ctx: Ctx, decl: Decl): boolean {
  return decl.kind === "alias" && ctx.checks.ownType(decl) && keyCheck(ctx, decl.type) !== undefined;
}

/** True when a declaration spells a type from encoding/json: `json.Number` or `json.RawMessage`. */
function usesJSON(decl: Decl): boolean {
  const walk = (type: TypeExpr): boolean => {
    switch (type.kind) {
      case "number":
      case "any":
        return true;
      case "array":
        return walk(type.items);
      case "map":
        return walk(type.key) || walk(type.value);
      default:
        return false;
    }
  };
  return declTypes(decl).some(walk);
}

/**
 * The `.gitattributes` for the Go folder, which marks every generated file, so
 * pull request diffs collapse them while hand written files stay open.
 */
export function emitGoAttributes(names: readonly string[], options: GoOptions = {}): string {
  const lines = [...names].sort(compare).map((name) => `${name} linguist-generated=true\n`);
  return `# ${options.header ?? DEFAULT_HEADER}\n# Marks the generated Go files, so diffs collapse them.\n${lines.join("")}`;
}

/** The Go file name of a schema, like `user-profile` to `user_profile.go`. */
export function fileName(schema: string, path: string): string {
  const name = schema.replaceAll("-", "_");
  const suffix = name.split("_").at(-1) ?? "";
  if (
    !/^[a-z][a-z0-9_]*$/.test(name) ||
    CONSTRAINED.has(suffix) ||
    `${name}.go` === GO_HELPERS ||
    `${name}.go` === GO_FIXTURES
  ) {
    throw new CodegenError(
      path,
      "unsupported-name",
      `schema file ${schema} has no safe Go file name`,
      "rename the schema file, so it doesn't end in a Go build suffix like -test or -linux",
    );
  }
  return `${name}.go`;
}

/** A Go source file: `head`, the imports the emitter says the body uses, then the body. */
function goFile(head: string, packages: readonly string[], parts: readonly string[]): string {
  const body = parts.join("\n");
  const imports =
    packages.length === 0
      ? ""
      : packages.length === 1
        ? `import "${packages[0] ?? ""}"\n\n`
        : `import (\n${packages.map((p) => `\t"${p}"\n`).join("")})\n\n`;
  return `${head}${imports}${body}`;
}

/** Every package-level name must be unique, since all schemas share one package. */
function checkNames(model: Model): void {
  // An enum constant like CodeTooDeep, from an enum named code, would clash with the helpers.
  const owners = new Map<string, string>(CODES.map((name) => [name, GO_HELPERS]));
  const claim = (name: string, path: string): void => {
    const other = owners.get(name);
    if (other !== undefined)
      throw new CodegenError(
        path,
        "name-clash",
        `Go name ${name} is also used by ${other}`,
        RENAME_TYPE,
      );
    owners.set(name, path);
  };
  for (const decl of model.decls) {
    const name = decl.name;
    if (RESERVED.has(name) || GO_KEYWORDS.has(name) || /^Const(Int|Bool)/.test(name)) {
      throw new CodegenError(
        decl.path,
        "reserved-name",
        `type name ${decl.name} is reserved in Go`,
        RENAME_TYPE,
      );
    }
    claim(decl.name, decl.path);
    if (decl.kind === "enum") for (const c of enumConsts(decl)) claim(c.name, decl.path);
    if (decl.kind === "tagged") {
      claim(`Decode${decl.name}`, decl.path);
      claim(`Report${decl.name}`, decl.path);
      claim(`union${decl.name}`, decl.path);
    }
    if (decl.kind === "struct") fieldNames(decl);
  }
}

function literalsOf(model: Model): (number | boolean)[] {
  const out = new Map<string, number | boolean>();
  const walk = (type: TypeExpr): void => {
    if (type.kind === "literal") out.set(literalName(type.value), type.value);
    if (type.kind === "array") walk(type.items);
    if (type.kind === "map") {
      walk(type.key);
      walk(type.value);
    }
  };
  for (const decl of model.decls) declTypes(decl).forEach(walk);
  return [...out].sort(([a], [b]) => compare(a, b)).map(([, value]) => value);
}

/** The Go type of an integer or boolean const, like `ConstInt1` or `ConstBoolTrue`. */
export function literalName(value: number | boolean): string {
  if (typeof value === "boolean") return value ? "ConstBoolTrue" : "ConstBoolFalse";
  return value < 0 ? `ConstIntMinus${String(-value)}` : `ConstInt${String(value)}`;
}

function literalType(value: number | boolean): string {
  const name = literalName(value);
  const text = String(value);
  const kind = typeof value === "boolean" ? "boolean" : "integer";
  const decode = typeof value === "boolean" ? "decodeConstBool" : "decodeConstInt";
  return (
    `// ${name} is the ${kind} const ${text}. It encodes as ${text} and decodes only ${text}.\n` +
    `type ${name} struct{}\n\n` +
    `// MarshalJSON encodes ${text}.\n` +
    `func (${name}) MarshalJSON() ([]byte, error) { return []byte("${text}"), nil }\n\n` +
    `// UnmarshalJSON decodes ${text} and fails on any other value.\n` +
    `func (v *${name}) UnmarshalJSON(data []byte) error { return unmarshal(data, v) }\n\n` +
    `func (*${name}) decode(n *node) *DecodeError { return ${decode}(n, ${text}) }\n`
  );
}

function declaration(ctx: Ctx, decl: Decl): string {
  const lines = [`${decl.name} is generated from ${decl.path}.`];
  if (decl.doc !== "") lines.push("", ...decl.doc.split("\n"));
  const head = comment(lines, "");
  switch (decl.kind) {
    case "struct":
      return head + struct(ctx, decl);
    case "enum":
      return head + enumeration(decl);
    case "tagged":
      return head + tagged(ctx, decl);
    case "untagged":
      return head + untagged(ctx, decl);
    case "alias":
      return ctx.checks.ownType(decl)
        ? head + definedType(ctx, decl)
        : `${head}type ${decl.name} = ${goType(decl.type)}\n`;
    case "id":
      return (
        `${head}type ${decl.name} string\n\n` +
        `// UnmarshalJSON decodes the id from a JSON string.\n` +
        unmarshalMethod(decl.name) +
        `func (v *${decl.name}) decode(n *node) *DecodeError { return decodeStringInto(n, v) }\n` +
        checkMethod(
          decl.name,
          [`\treturn ${goCheck(ctx, decl.type, "string(v)") ?? "nil"}\n`],
          ctx.checks.decl(decl.name),
        )
      );
  }
}

/** The Go field name of each key, checked for clashes. */
function fieldNames(decl: StructDecl): string[] {
  const seen = new Set<string>();
  const names = decl.fields.map((f) => {
    const name = pascal(f.name);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name))
      throw new CodegenError(
        decl.path,
        "unsupported-name",
        `key ${f.name} has no Go field name`,
        "start the key with a letter",
      );
    if (!TAG_NAME.test(f.name))
      throw new CodegenError(
        decl.path,
        "unsupported-name",
        `key ${f.name} can't be a Go struct tag`,
        "drop quotes, backslashes and commas from the key",
      );
    if (METHODS.has(name) || (decl.rest !== undefined && name === "Rest")) {
      throw new CodegenError(
        decl.path,
        "reserved-name",
        `key ${f.name} maps to the Go field ${name}, which the generated code uses itself`,
        "rename the key",
      );
    }
    if (seen.has(name)) {
      throw new CodegenError(
        decl.path,
        "name-clash",
        `two keys map to the Go field ${name}`,
        "rename one of the keys",
      );
    }
    seen.add(name);
    return name;
  });
  return names;
}

function struct(ctx: Ctx, decl: StructDecl): string {
  const names = fieldNames(decl);
  const lines = decl.fields.map((f, i) => {
    const doc = comment(f.doc === "" ? [`The ${f.name} key.`] : f.doc.split("\n"), "\t");
    const tag = f.required ? f.name : `${f.name},omitempty`;
    return `${doc}\t${names[i] ?? ""} ${fieldType(ctx, f)} \`json:"${tag}"\`\n`;
  });
  if (decl.rest !== undefined) {
    lines.push(
      `\t// Rest holds the keys other than the named fields.\n\tRest map[${goType(decl.rest.key)}]${goType(decl.rest.value)} \`json:"-"\`\n`,
    );
  }
  const body = lines.length === 0 ? "struct{}" : `struct {\n${lines.join("")}}`;
  const reads = decl.fields.map((f, i) => `\t\t${read(ctx, f, names[i] ?? "")}\n`);
  if (decl.rest !== undefined) {
    reads.push(
      `\t\trest(d, &out.Rest, ${decoder(ctx, decl.rest.key)}, ${decoder(ctx, decl.rest.value)})\n`,
    );
  }
  const fill =
    reads.length === 0
      ? "func(*objectDecoder) {}"
      : `func(d *objectDecoder) {\n${reads.join("")}\t}`;
  const forbidden = ctx.report ? decl.forbidden.map((k) => `, ${JSON.stringify(k)}`).join("") : "";
  const doc = ctx.report
    ? `// UnmarshalJSON decodes strictly: missing required keys and explicit nulls fail. Unknown keys\n` +
      `// are accepted, and their paths go to the hook set with SetUnknownKeyHook.\n`
    : `// UnmarshalJSON decodes strictly: unknown keys, missing required keys and explicit nulls fail.\n`;
  const unmarshal =
    doc +
    unmarshalMethod(decl.name) +
    `func (v *${decl.name}) decode(n *node) *DecodeError {\n` +
    `\tvar out ${decl.name}\n` +
    `\treturn decodeObject(n, ${fill}, func() { *v = out }${forbidden})\n}\n`;
  return `type ${decl.name} ${body}\n\n${unmarshal}${structCheck(ctx, decl, names)}${marshal(ctx, decl, names)}`;
}

/**
 * The check method of a type with constraints, which runs once the whole value has decoded.
 * Its body is `lines`, which end in a return. Empty when the type has nothing to check.
 */
function checkMethod(name: string, lines: readonly string[], checked: boolean): string {
  if (!checked) return "";
  return (
    `\n// check checks the constraints of a decoded ${name}.\n` +
    `func (v ${name}) check() *DecodeError {\n${lines.join("")}}\n`
  );
}

/** A struct's check: its fields in schema order, then the keys of its rest map. */
function structCheck(ctx: Ctx, decl: StructDecl, names: readonly string[]): string {
  const lines = decl.fields.flatMap((f, i) => {
    const name = `v.${names[i] ?? ""}`;
    const pointer = fieldType(ctx, f).startsWith("*");
    const check = goCheck(ctx, f.type, pointer ? `*${name}` : name);
    if (check === undefined) return [];
    const key = JSON.stringify(f.name);
    const test = `if err := ${check}; err != nil {\n`;
    if (!pointer || f.required) return [`\t${test}\t\treturn err.at(${key})\n\t}\n`];
    return [`\tif ${name} != nil {\n\t\t${test}\t\t\treturn err.at(${key})\n\t\t}\n\t}\n`];
  });
  const rest = decl.rest;
  if (rest !== undefined && (ctx.checks.type(rest.key) || ctx.checks.type(rest.value))) {
    const entries = `checkEntries(v.Rest, -1, -1, ${goCheckFn(ctx, rest.key)}, ${goCheckFn(ctx, rest.value)})`;
    lines.push(`\tif err := ${entries}; err != nil {\n\t\treturn err\n\t}\n`);
  }
  return checkMethod(decl.name, [...lines, "\treturn nil\n"], ctx.checks.decl(decl.name));
}

/**
 * A constrained alias of a type that can't check it, like a list of codes, as a defined type
 * with the methods of a generated type, so json.Unmarshal into it, Report and every type that
 * holds it check its constraints. It encodes as the value it holds: a number through
 * json.Number, which encoding/json would otherwise write as a string, and a map with enum keys
 * after checking them.
 */
function definedType(ctx: Ctx, decl: AliasDecl): string {
  const name = decl.name;
  const inner = goType(decl.type);
  const keys = keyCheck(ctx, decl.type);
  const marshal =
    decl.type.kind === "number"
      ? `\n// MarshalJSON encodes the number as it was decoded.\n` +
        `func (v ${name}) MarshalJSON() ([]byte, error) { return json.Marshal(json.Number(v)) }\n`
      : keys !== undefined
        ? `\n// MarshalJSON fails on a map key its enum doesn't list, which encoding/json would write.\n` +
          `func (v ${name}) MarshalJSON() ([]byte, error) {\n` +
          `\tif err := ${keys}(${inner}(v)); err != nil {\n\t\treturn nil, err\n\t}\n` +
          `\treturn json.Marshal(${inner}(v))\n}\n`
        : "";
  return (
    `type ${name} ${inner}\n\n` +
    `// UnmarshalJSON decodes strictly, then checks the constraints.\n` +
    unmarshalMethod(name) +
    `func (v *${name}) decode(n *node) *DecodeError {\n` +
    `\tx, err := ${decoder(ctx, decl.type)}(n)\n` +
    `\tif err != nil {\n\t\treturn err\n\t}\n` +
    `\t*v = ${name}(x)\n\treturn nil\n}\n` +
    checkMethod(name, [`\treturn ${goCheck(ctx, decl.type, `${inner}(v)`) ?? "nil"}\n`], true) +
    marshal
  );
}

/**
 * A Go expression of type `*DecodeError` that checks `v`, a value of `type`, or undefined when
 * there is nothing to check.
 */
function goCheck(ctx: Ctx, type: TypeExpr, v: string): string | undefined {
  if (!ctx.checks.type(type)) return undefined;
  const n = (value: number | undefined): string => (value === undefined ? "-1" : String(value));
  switch (type.kind) {
    case "ref": {
      const decl = ctx.decls.get(type.name);
      if (decl?.kind === "alias" && !ctx.checks.ownType(decl)) return goCheck(ctx, decl.type, v);
      if (decl?.kind === "tagged") return `checkValue(${v})`;
      return v.startsWith("*") ? `(${v}).check()` : `${v}.check()`;
    }
    case "string":
      return `checkLength(${v}, ${n(type.minLength)}, ${n(type.maxLength)})`;
    case "integer":
    case "number": {
      const go = type.kind === "integer" ? "int64" : "float64";
      const limits = limitsOf(type).map(
        (l) => `limit[${go}]{${JSON.stringify(l.op)}, ${String(l.bound)}, ${JSON.stringify(l.text)}}`,
      );
      return `${type.kind === "integer" ? "checkInt" : "checkNumber"}(${v}, ${limits.join(", ")})`;
    }
    case "array":
      return `checkItems(${v}, ${n(type.minItems)}, ${n(type.maxItems)}, ${goCheckFn(ctx, type.items)})`;
    case "map":
      return `checkEntries(${v}, ${n(type.minProperties)}, ${n(type.maxProperties)}, ${goCheckFn(ctx, type.key)}, ${goCheckFn(ctx, type.value)})`;
    default:
      return undefined;
  }
}

/** A Go `func(T) *DecodeError` that checks a value of `type`, or `nil` when there is nothing to check. */
function goCheckFn(ctx: Ctx, type: TypeExpr): string {
  const check = goCheck(ctx, type, "item");
  if (check === undefined) return "nil";
  return `func(item ${goType(type)}) *DecodeError { return ${check} }`;
}

/** UnmarshalJSON, which parses once and calls the type's decode method. */
function unmarshalMethod(name: string): string {
  return `func (v *${name}) UnmarshalJSON(data []byte) error { return unmarshal(data, v) }\n\n`;
}

/** Required fields whose nil value would encode as null: slices, maps, unions and boxed pointers. */
function nilable(
  ctx: Ctx,
  decl: StructDecl,
  names: readonly string[],
): { key: string; name: string }[] {
  return decl.fields.flatMap((f, i) => {
    if (!f.required) return [];
    const resolved = resolve(ctx, f.type);
    const union = resolved.kind === "ref" && ctx.decls.get(resolved.name)?.kind === "tagged";
    const nil = f.boxed || union || resolved.kind === "array" || resolved.kind === "map";
    return nil ? [{ key: f.name, name: names[i] ?? "" }] : [];
  });
}

/** MarshalJSON for a struct with a rest map or with required fields that may be nil. */
function marshal(ctx: Ctx, decl: StructDecl, names: readonly string[]): string {
  const checks = nilable(ctx, decl, names);
  const enumKeys = decl.fields.flatMap((f, i) => {
    const check = keyCheck(ctx, f.type);
    if (check === undefined) return [];
    const pointer = fieldType(ctx, f).startsWith("*");
    return [`${pointer ? `ptrKeys(${check})` : check}(v.${names[i] ?? ""})`];
  });
  if (decl.rest !== undefined) {
    const check = keyCheck(ctx, decl.rest.value);
    if (check !== undefined) {
      enumKeys.push(`mapKeys[${goType(decl.rest.key)}, ${goType(decl.rest.value)}](${check})(v.Rest)`);
    }
  }
  if (decl.rest === undefined && checks.length === 0 && enumKeys.length === 0) return "";
  const keys = `[]string{${checks.map((c) => JSON.stringify(c.key)).join(", ")}}`;
  const set = checks.map((c) => `, v.${c.name} != nil`).join("");
  const checkKeys =
    enumKeys.length === 0
      ? ""
      : `\tif err := firstError(\n${enumKeys.map((c) => `\t\t${c},\n`).join("")}\t); err != nil {\n\t\treturn nil, err\n\t}\n`;
  const why =
    enumKeys.length === 0
      ? ""
      : `// It fails on a map key its enum doesn't list, which encoding/json would write.\n`;
  if (decl.rest === undefined) {
    return (
      `\n// MarshalJSON fails when a required slice, map, union or pointer is nil, which would encode as null.\n` +
      why +
      `func (v ${decl.name}) MarshalJSON() ([]byte, error) {\n` +
      checkKeys +
      `\ttype plain ${decl.name}\n` +
      `\treturn encodeRequired(plain(v), ${keys}${set})\n}\n`
    );
  }
  const named = `[]string{${decl.fields.map((f) => JSON.stringify(f.name)).join(", ")}}`;
  return (
    `\n// MarshalJSON encodes the named keys, then the keys of Rest in order, as one object.\n` +
    `// It fails when Rest holds a named key, so no key is written twice, or when a required\n` +
    `// slice, map, union or pointer is nil.\n` +
    why +
    `func (v ${decl.name}) MarshalJSON() ([]byte, error) {\n` +
    checkKeys +
    `\ttype named ${decl.name}\n` +
    `\treturn encodeWithRest(named(v), v.Rest, ${named}, ${keys}${set})\n}\n`
  );
}

/**
 * A Go check of the enum map keys inside a value of type, `func(T) error`, or undefined when
 * it holds none. encoding/json writes a map key of a string type without its MarshalText, so
 * a key the enum doesn't list would be written. It stops at named types other than aliases,
 * which check their own fields.
 */
function keyCheck(ctx: Ctx, type: TypeExpr): string | undefined {
  // A constrained alias is a defined type, whose MarshalJSON checks its own keys.
  const resolved = resolve(ctx, type, true);
  if (resolved.kind === "array") {
    const inner = keyCheck(ctx, resolved.items);
    return inner === undefined ? undefined : `sliceKeys[${goType(resolved.items)}](${inner})`;
  }
  if (resolved.kind !== "map") return undefined;
  const key = resolve(ctx, resolved.key);
  const isEnum = key.kind === "ref" && ctx.decls.get(key.name)?.kind === "enum";
  const inner = keyCheck(ctx, resolved.value);
  if (!isEnum && inner === undefined) return undefined;
  return `mapKeys[${goType(resolved.key)}, ${goType(resolved.value)}](${inner ?? "nil"})`;
}

/** The statement that reads one key in a struct's UnmarshalJSON. */
function read(ctx: Ctx, f: Field, name: string): string {
  const key = JSON.stringify(f.name);
  const decode = decoder(ctx, f.type);
  if (f.required) {
    return `required(d, ${key}, &out.${name}, ${f.boxed ? `boxed(${decode})` : decode})`;
  }
  return isValue(ctx, f.type)
    ? `optionalValue(d, ${key}, &out.${name}, ${decode})`
    : `optional(d, ${key}, &out.${name}, ${decode})`;
}

/** The Go type of a field: a pointer when optional or boxed, unless nil already means absent. */
function fieldType(ctx: Ctx, f: Field): string {
  const type = goType(f.type);
  if (f.required) return f.boxed ? `*${type}` : type;
  return isValue(ctx, f.type) ? type : `*${type}`;
}

/** Types whose zero value is nil, so an optional one needs no pointer: interfaces and json.RawMessage. */
function isValue(ctx: Ctx, type: TypeExpr): boolean {
  const resolved = resolve(ctx, type);
  if (resolved.kind === "any") return true;
  return resolved.kind === "ref" && ctx.decls.get(resolved.name)?.kind === "tagged";
}

/**
 * Follows aliases to the type they stand for. With `plain`, it stops at a constrained alias,
 * which is a defined type of its own.
 */
function resolve(ctx: Ctx, type: TypeExpr, plain = false): TypeExpr {
  let current = type;
  for (let depth = 0; current.kind === "ref" && depth <= ctx.decls.size; depth++) {
    const decl = ctx.decls.get(current.name);
    if (decl?.kind !== "alias" || (plain && ctx.checks.ownType(decl))) return current;
    current = decl.type;
  }
  return current;
}

function enumConsts(decl: EnumDecl): { name: string; value: string }[] {
  const seen = new Set<string>();
  return decl.values.map((value) => {
    const name = `${decl.name}${variantName(value)}`;
    if (seen.has(name))
      throw new CodegenError(
        decl.path,
        "name-clash",
        `two values map to the Go name ${name}`,
        "change one of the values so their names differ",
      );
    seen.add(name);
    return { name, value };
  });
}

function enumeration(decl: EnumDecl): string {
  const consts = enumConsts(decl);
  const lines = consts.map(
    (c) =>
      `\t// ${c.name} is ${JSON.stringify(c.value)}.\n\t${c.name} ${decl.name} = ${JSON.stringify(c.value)}\n`,
  );
  return (
    `type ${decl.name} string\n\n` +
    `// Values of ${decl.name}.\nconst (\n${lines.join("")})\n\n` +
    `// MarshalText fails on a value the type doesn't list, so it is never written.\n` +
    `func (v ${decl.name}) MarshalText() ([]byte, error) {\n` +
    `\treturn encodeEnum(v, ${consts.map((c) => c.name).join(", ")})\n}\n\n` +
    `// UnmarshalJSON fails on a value the type doesn't list.\n` +
    unmarshalMethod(decl.name) +
    `func (v *${decl.name}) decode(n *node) *DecodeError {\n` +
    `\treturn decodeEnum(n, v, ${consts.map((c) => c.name).join(", ")})\n}\n`
  );
}

/** The struct of each branch, through aliases, which gets the union's marker method. */
function branchTypes(ctx: Ctx, decl: TaggedDecl): string[] {
  return decl.variants.map((v) => {
    const resolved = resolve(ctx, { kind: "ref", name: v.type });
    return resolved.kind === "ref" ? resolved.name : v.type;
  });
}

function tagged(ctx: Ctx, decl: TaggedDecl): string {
  const types = branchTypes(ctx, decl);
  const key = JSON.stringify(decl.tag);
  const marker = `is${decl.name}`;
  const branches = decl.variants.map(
    (v, i) => `\t\t${JSON.stringify(v.value)}: branch[${decl.name}, ${types[i] ?? ""}],\n`,
  );
  const markers = types.map((t) => `func (${t}) ${marker}() {}\n`);
  const tags = `[]string{${decl.variants.map((v) => JSON.stringify(v.value)).join(", ")}}`;
  return (
    `//\n// It holds one of ${list(types)}, picked by the ${key} key.\n` +
    `// Decode it with Decode${decl.name}, which reads the key first.\n` +
    `type ${decl.name} interface {\n\t${marker}()\n}\n\n` +
    `// Decode${decl.name} reads the ${key} key and decodes only the branch it names.\n` +
    `func Decode${decl.name}(data []byte) (${decl.name}, error) { return decodeRoot(data, union${decl.name}) }\n\n` +
    (ctx.report
      ? `// Report${decl.name} decodes like Decode${decl.name} and returns the value with the paths of its\n` +
        `// unknown keys.\n` +
        `func Report${decl.name}(data []byte) (Reported[${decl.name}], error) {\n` +
        `\treturn decodeReport(data, union${decl.name})\n}\n\n`
      : "") +
    `// union${decl.name} decodes a parsed ${decl.name} by its ${key} key.\n` +
    `func union${decl.name}(n *node) (${decl.name}, *DecodeError) {\n` +
    `\treturn decodeTagged(n, ${key}, ${tags}, map[string]func(*node) (${decl.name}, *DecodeError){\n${branches.join("")}\t})\n}\n\n` +
    markers.join("")
  );
}

function untagged(ctx: Ctx, decl: UntaggedDecl): string {
  const fields = decl.variants.map((v) => {
    const value = isValue(ctx, v.type);
    return {
      name: v.name,
      type: value ? goType(v.type) : `*${goType(v.type)}`,
      decode: decoder(ctx, v.type),
      value,
      raw: resolve(ctx, v.type).kind === "any",
      doc: `${v.name} is set when the value decodes as ${goType(v.type)}.`,
    };
  });
  const lines = fields.map((f) => `\t// ${f.doc}\n\t${f.name} ${f.type}\n`);
  const encode = fields.map((f) =>
    f.raw ? `someRaw(v.${f.name})` : f.value ? `v.${f.name}` : `some(v.${f.name})`,
  );
  const tries = fields.map(
    (f) => `\t\t${f.value ? "tryValue" : "try"}(&out.${f.name}, ${f.decode}),\n`,
  );
  const name = JSON.stringify(decl.name);
  const enumKeys = decl.variants.flatMap((v) => {
    const check = keyCheck(ctx, v.type);
    return check === undefined ? [] : [`\t\tptrKeys(${check})(v.${v.name}),\n`];
  });
  const checkKeys =
    enumKeys.length === 0
      ? ""
      : `\tif err := firstError(\n${enumKeys.join("")}\t); err != nil {\n\t\treturn nil, err\n\t}\n`;
  return (
    `//\n// Exactly one field is set. Decoding tries them in order: ${list(fields.map((f) => f.name))}.\n` +
    `type ${decl.name} struct {\n${lines.join("")}}\n\n` +
    `// MarshalJSON encodes the one variant that is set. None or more than one fails.\n` +
    `func (v ${decl.name}) MarshalJSON() ([]byte, error) {\n` +
    checkKeys +
    `\treturn encodeUntagged(${name}, ${encode.join(", ")})\n}\n\n` +
    `// UnmarshalJSON decodes the first variant, in order, that the value matches.\n` +
    unmarshalMethod(decl.name) +
    `func (v *${decl.name}) decode(n *node) *DecodeError {\n` +
    `\tvar out ${decl.name}\n` +
    `\treturn decodeUntagged(n, ${name}, func() { *v = out },\n${tries.join("")}\t)\n}\n` +
    untaggedCheck(ctx, decl)
  );
}

/** An untagged union's check: that of the variant that is set. */
function untaggedCheck(ctx: Ctx, decl: UntaggedDecl): string {
  const lines = decl.variants.flatMap((v) => {
    const value = isValue(ctx, v.type);
    const check = goCheck(ctx, v.type, value ? `v.${v.name}` : `*v.${v.name}`);
    return check === undefined ? [] : [`\tif v.${v.name} != nil {\n\t\treturn ${check}\n\t}\n`];
  });
  return checkMethod(decl.name, [...lines, "\treturn nil\n"], ctx.checks.decl(decl.name));
}

function list(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1) ?? ""}`;
}

/** The Go type for a type expression. Aliases keep their name, since Go aliases are identical types. */
export function goType(type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "string":
      return "string";
    case "integer":
      return "int64";
    case "number":
      // Keeps the JSON spelling of finite numbers, so 12 re-encodes as 12, not 12.0, like Rust.
      return "json.Number";
    case "boolean":
      return "bool";
    case "literal":
      return literalName(type.value);
    case "any":
      return "json.RawMessage";
    case "nonNull":
      return GO_NON_NULL;
    case "array":
      return `[]${goType(type.items)}`;
    case "map":
      return `map[${goType(type.key)}]${goType(type.value)}`;
  }
}

/** A decoding function for a type: `func(*node) (T, *DecodeError)`, strict at every level. */
function decoder(ctx: Ctx, type: TypeExpr): string {
  switch (type.kind) {
    case "ref": {
      const decl = ctx.decls.get(type.name);
      if (decl?.kind === "alias" && !ctx.checks.ownType(decl)) return decoder(ctx, decl.type);
      if (decl?.kind === "tagged") return `union${type.name}`;
      return `decodeType[${type.name}]`;
    }
    case "string":
      return "decodeString";
    case "integer":
      return "decodeInt";
    case "number":
      return "decodeNumber";
    case "boolean":
      return "decodeBool";
    case "literal":
      return `decodeType[${literalName(type.value)}]`;
    case "any":
      return "decodeAny";
    case "nonNull":
      return `decodeType[${GO_NON_NULL}]`;
    case "array":
      return `decodeSlice(${decoder(ctx, type.items)})`;
    case "map":
      return `decodeMap(${decoder(ctx, type.key)}, ${decoder(ctx, type.value)})`;
  }
}

/** Go comment lines. */
function comment(lines: readonly string[], indent: string): string {
  return lines.map((line) => `${indent}//${line === "" ? "" : ` ${line}`}\n`).join("");
}

/**
 * The fixture registry, `registry_test.go`: a decoder per schema
 * root (`"payment"`) and def (`"payment/cardPayment"`), for the fixture tests,
 * and every type with an UnmarshalJSON, for tests that cover them all.
 */
export function emitGoFixtures(model: Model, options: GoOptions = {}): string {
  const ctx = context(model, options.read === "report");
  const entries = model.decls
    .filter((d) => d.source !== undefined)
    .map((d) => ({
      key:
        d.source?.def === undefined
          ? (d.source?.schema ?? "")
          : `${d.source.schema}/${d.source.def}`,
      decode: `asAny(${decoder(ctx, { kind: "ref", name: d.name })})`,
    }))
    .sort((a, b) => compare(a.key, b.key))
    .map((e) => `\t\t${JSON.stringify(e.key)}: ${e.decode},\n`);
  const types = [
    ...model.decls
      .filter((d) => (d.kind !== "alias" || ctx.checks.ownType(d)) && d.kind !== "tagged")
      .map((d) => d.name),
    ...literalsOf(model).map(literalName),
    GO_NON_NULL,
  ]
    .sort(compare)
    .map((name) => `\t\tnew(${name}),\n`);
  const registry = ctx.report
    ? `// fixtureDecoders maps each fixture folder, "schema" for a root and "schema/def" for a def,
// to a function that decodes JSON as the type generated for it and returns the value with the
// paths of its unknown keys.
func fixtureDecoders() map[string]func([]byte) (any, []string, error) {
\treturn map[string]func([]byte) (any, []string, error){
${entries.join("")}\t}
}

// asAny returns a decoder of JSON that parses it once, then decodes it with decode.
func asAny[T any](decode func(*node) (T, *DecodeError)) func([]byte) (any, []string, error) {
\treturn func(data []byte) (any, []string, error) {
\t\tr, err := decodeReport(data, decode)
\t\treturn r.Value, r.Unknown, err
\t}
}
`
    : `// fixtureDecoders maps each fixture folder, "schema" for a root and "schema/def" for a def,
// to a function that decodes JSON as the type generated for it.
func fixtureDecoders() map[string]func([]byte) (any, error) {
\treturn map[string]func([]byte) (any, error){
${entries.join("")}\t}
}

// asAny returns a decoder of JSON that parses it once, then decodes it with decode.
func asAny[T any](decode func(*node) (T, *DecodeError)) func([]byte) (any, error) {
\treturn func(data []byte) (any, error) {
\t\tv, err := decodeRoot(data, decode)
\t\treturn v, err
\t}
}
`;
  return `${goHead(options, "")}import "encoding/json"

${registry}
// unmarshalers returns a new value of every generated type with an UnmarshalJSON method.
func unmarshalers() []json.Unmarshaler {
\treturn []json.Unmarshaler{
${types.join("")}\t}
}
`;
}

/** Standard library packages the helpers file uses, in import order. Report mode adds sync/atomic. */
function helperImports(report: boolean): string[] {
  return [
    "bytes",
    "encoding",
    "encoding/json",
    "errors",
    "fmt",
    "maps",
    "slices",
    "strconv",
    "strings",
    ...(report ? ["sync/atomic"] : []),
    "unicode/utf8",
  ];
}

