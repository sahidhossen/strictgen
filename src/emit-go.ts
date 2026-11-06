import type { EmittedFile } from "./common.js";
import { bySchema, commentHeader, compare, declTypes, DEFAULT_HEADER } from "./common.js";
import type {
  Decl,
  EnumDecl,
  Field,
  Model,
  StructDecl,
  TaggedDecl,
  TypeExpr,
  UntaggedDecl,
} from "./model.js";
import { GO_KEYWORDS, pascal, RENAME_TYPE, variantName } from "./naming.js";
import { CodegenError } from "./schema.js";

/** The Go package every generated file belongs to, unless the options name another. */
export const GO_PACKAGE = "types";
/** Name of the file with the built in types and the decoding functions. */
export const GO_HELPERS = "helpers.go";
/** Name of the generated fixture registry, a test file. */
export const GO_FIXTURES = "registry_test.go";
/** Name of the built in type for any JSON value except `null`. */
export const GO_NON_NULL = "NonNullJson";

/** The error code constants the helpers file declares, for JSON that fails to parse. */
const CODES = ["CodeInvalidJSON", "CodeDuplicateKey", "CodeTooDeep"];

/** Exported names the helpers file declares, besides the literal types. */
const RESERVED = new Set([GO_NON_NULL, "DecodeError", ...CODES]);

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
}

/** Options for the Go emitters. */
export interface GoOptions {
  /** The header text each file starts with, as a comment. */
  readonly header?: string;
  /** The package clause of every file. Defaults to {@link GO_PACKAGE}. */
  readonly package?: string;
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
  const ctx: Ctx = { decls: new Map(model.decls.map((d) => [d.name, d])) };
  checkNames(model);
  const files = [...bySchema(model)].map(([schema, decls]) => ({
    name: fileName(schema, decls[0]?.path ?? schema),
    contents: goFile(
      goHead(options, `Types for ${schema}.json.`),
      decls.some(usesJSON) ? ["encoding/json"] : [],
      decls.map((d) => declaration(ctx, d)),
    ),
  }));
  const literals = literalsOf(model);
  return [
    {
      name: GO_HELPERS,
      contents: goFile(goHead(options, ""), HELPER_IMPORTS, [HELPERS, ...literals.map(literalType)]),
    },
    ...files,
  ];
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
      return `${head}type ${decl.name} = ${goType(decl.type)}\n`;
    case "id":
      return (
        `${head}type ${decl.name} string\n\n` +
        `// UnmarshalJSON decodes the id from a JSON string.\n` +
        unmarshalMethod(decl.name) +
        `func (v *${decl.name}) decode(n *node) *DecodeError { return decodeStringInto(n, v) }\n`
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
  const unmarshal =
    `// UnmarshalJSON decodes strictly: unknown keys, missing required keys and explicit nulls fail.\n` +
    unmarshalMethod(decl.name) +
    `func (v *${decl.name}) decode(n *node) *DecodeError {\n` +
    `\tvar out ${decl.name}\n` +
    `\treturn decodeObject(n, ${fill}, func() { *v = out })\n}\n`;
  return `type ${decl.name} ${body}\n\n${unmarshal}${marshal(ctx, decl, names)}`;
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
  if (decl.rest === undefined && checks.length === 0) return "";
  const keys = `[]string{${checks.map((c) => JSON.stringify(c.key)).join(", ")}}`;
  const set = checks.map((c) => `, v.${c.name} != nil`).join("");
  if (decl.rest === undefined) {
    return (
      `\n// MarshalJSON fails when a required slice, map, union or pointer is nil, which would encode as null.\n` +
      `func (v ${decl.name}) MarshalJSON() ([]byte, error) {\n` +
      `\ttype plain ${decl.name}\n` +
      `\treturn encodeRequired(plain(v), ${keys}${set})\n}\n`
    );
  }
  const named = `[]string{${decl.fields.map((f) => JSON.stringify(f.name)).join(", ")}}`;
  return (
    `\n// MarshalJSON encodes the named keys, then the keys of Rest in order, as one object.\n` +
    `// It fails when Rest holds a named key, so no key is written twice, or when a required\n` +
    `// slice, map, union or pointer is nil.\n` +
    `func (v ${decl.name}) MarshalJSON() ([]byte, error) {\n` +
    `\ttype named ${decl.name}\n` +
    `\treturn encodeWithRest(named(v), v.Rest, ${named}, ${keys}${set})\n}\n`
  );
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

/** Follows aliases to the type they stand for. */
function resolve(ctx: Ctx, type: TypeExpr): TypeExpr {
  let current = type;
  for (let depth = 0; current.kind === "ref" && depth <= ctx.decls.size; depth++) {
    const decl = ctx.decls.get(current.name);
    if (decl?.kind !== "alias") return current;
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
  return (
    `//\n// It holds one of ${list(types)}, picked by the ${key} key.\n` +
    `// Decode it with Decode${decl.name}, which reads the key first.\n` +
    `type ${decl.name} interface {\n\t${marker}()\n}\n\n` +
    `// Decode${decl.name} reads the ${key} key and decodes only the branch it names.\n` +
    `func Decode${decl.name}(data []byte) (${decl.name}, error) { return decodeRoot(data, union${decl.name}) }\n\n` +
    `// union${decl.name} decodes a parsed ${decl.name} by its ${key} key.\n` +
    `func union${decl.name}(n *node) (${decl.name}, *DecodeError) {\n` +
    `\treturn decodeTagged(n, ${key}, map[string]func(*node) (${decl.name}, *DecodeError){\n${branches.join("")}\t})\n}\n\n` +
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
  return (
    `//\n// Exactly one field is set. Decoding tries them in order: ${list(fields.map((f) => f.name))}.\n` +
    `type ${decl.name} struct {\n${lines.join("")}}\n\n` +
    `// MarshalJSON encodes the one variant that is set. None or more than one fails.\n` +
    `func (v ${decl.name}) MarshalJSON() ([]byte, error) {\n` +
    `\treturn encodeUntagged(${name}, ${encode.join(", ")})\n}\n\n` +
    `// UnmarshalJSON decodes the first variant, in order, that the value matches.\n` +
    unmarshalMethod(decl.name) +
    `func (v *${decl.name}) decode(n *node) *DecodeError {\n` +
    `\tvar out ${decl.name}\n` +
    `\treturn decodeUntagged(n, ${name}, func() { *v = out },\n${tries.join("")}\t)\n}\n`
  );
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
      if (decl?.kind === "alias") return decoder(ctx, decl.type);
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
  const ctx: Ctx = { decls: new Map(model.decls.map((d) => [d.name, d])) };
  const entries = model.decls
    .filter((d) => d.source !== undefined)
    .map((d) => ({
      key:
        d.source?.def === undefined
          ? (d.source?.schema ?? "")
          : `${d.source.schema}/${d.source.def}`,
      decode: decoder(ctx, { kind: "ref", name: d.name }),
    }))
    .sort((a, b) => compare(a.key, b.key))
    .map((e) => `\t\t${JSON.stringify(e.key)}: asAny(${e.decode}),\n`);
  const types = [
    ...model.decls.filter((d) => d.kind !== "alias" && d.kind !== "tagged").map((d) => d.name),
    ...literalsOf(model).map(literalName),
    GO_NON_NULL,
  ]
    .sort(compare)
    .map((name) => `\t\tnew(${name}),\n`);
  return `${goHead(options, "")}import "encoding/json"

// fixtureDecoders maps each fixture folder, "schema" for a root and "schema/def" for a def,
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

// unmarshalers returns a new value of every generated type with an UnmarshalJSON method.
func unmarshalers() []json.Unmarshaler {
\treturn []json.Unmarshaler{
${types.join("")}\t}
}
`;
}

/** Standard library packages the helpers file uses, in import order. */
const HELPER_IMPORTS = [
  "bytes",
  "encoding/json",
  "errors",
  "fmt",
  "maps",
  "slices",
  "strconv",
  "strings",
  "unicode/utf8",
];

const HELPERS = `// maxDepth is serde_json's recursion limit: a value nested in 128 or more arrays and objects
// fails, so Go and Rust accept the same documents and decoding stays bounded.
const maxDepth = 128

// Error codes of input that isn't JSON the decoders read, in DecodeError.Code.
const (
	// CodeInvalidJSON is a syntax error, invalid UTF-8, a lone surrogate, trailing data or a
	// number out of range.
	CodeInvalidJSON = "invalid_json"
	// CodeDuplicateKey is an object that gives the same key twice.
	CodeDuplicateKey = "duplicate_key"
	// CodeTooDeep is a value nested in maxDepth or more arrays and objects.
	CodeTooDeep = "too_deep"
)

// DecodeError is a value that doesn't fit its generated type. Path is a JSON Pointer to the
// value, empty for the whole input. Code is the error code of a JSON decoding failure, like
// CodeDuplicateKey, and empty for a value that doesn't fit its type.
type DecodeError struct {
	Path   string
	Reason string
	Code   string
}

// Error returns the path and the reason, like /items/0: kind "card": missing key "number".
func (e *DecodeError) Error() string {
	if e.Path == "" {
		return e.Reason
	}
	return e.Path + ": " + e.Reason
}

// failf returns a DecodeError at the current value.
func failf(format string, args ...any) *DecodeError {
	return &DecodeError{Reason: fmt.Sprintf(format, args...)}
}

// at moves the error one level down, under an object key or array index.
func (e *DecodeError) at(segment string) *DecodeError {
	escaped := strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
	return &DecodeError{Path: "/" + escaped + e.Path, Reason: e.Reason, Code: e.Code}
}

// node is one parsed JSON value. Input is parsed once, then decoders walk the nodes, so
// decoding is linear in the input size.
type node struct {
	kind   byte             // '{', '[', '"', 'n', 't', 'f' or '0' for a number
	raw    []byte           // the value as spelled in the input
	text   string           // the value of a string
	keys   []string         // the keys of an object in input order, each once
	fields map[string]*node // the members of an object; a key given twice fails to parse
	items  []*node          // the items of an array
}

// kindName names a node's kind for errors.
func kindName(kind byte) string {
	switch kind {
	case '{':
		return "an object"
	case '[':
		return "an array"
	case '"':
		return "a string"
	case 'n':
		return "null"
	case 't', 'f':
		return "a boolean"
	default:
		return "a number"
	}
}

// expect fails unless the node is of the given kind.
func expect(n *node, kind byte) *DecodeError {
	if n.kind == kind || (kind == 't' && n.kind == 'f') {
		return nil
	}
	return failf("expected %s, found %s", kindName(kind), kindName(n.kind))
}

// parser reads JSON like serde_json: strict grammar, valid UTF-8, no lone surrogates,
// finite numbers and at most maxDepth - 1 nested arrays and objects.
type parser struct {
	data []byte
	pos  int
}

// parse parses a whole JSON document. Every failure carries its error code.
func parse(data []byte) (*node, *DecodeError) {
	if !utf8.Valid(data) {
		return nil, failAt(CodeInvalidJSON, invalidUTF8At(data), "not valid UTF-8")
	}
	p := &parser{data: data}
	n, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.space()
	if p.pos != len(p.data) {
		return nil, failAt(CodeInvalidJSON, p.pos, "trailing characters")
	}
	return n, nil
}

// invalidUTF8At returns the offset of the first byte that isn't valid UTF-8.
func invalidUTF8At(data []byte) int {
	at := 0
	for at < len(data) {
		r, size := utf8.DecodeRune(data[at:])
		if r == utf8.RuneError && size == 1 {
			break
		}
		at += size
	}
	return at
}

// failAt returns a JSON decoding failure with its error code, at a byte offset.
func failAt(code string, offset int, reason string) *DecodeError {
	return &DecodeError{Reason: fmt.Sprintf("invalid JSON at offset %d: %s", offset, reason), Code: code}
}

func (p *parser) fail(reason string) *DecodeError {
	return failAt(CodeInvalidJSON, p.pos, reason)
}

func (p *parser) space() {
	for p.pos < len(p.data) && strings.IndexByte(" \\t\\n\\r", p.data[p.pos]) >= 0 {
		p.pos++
	}
}

// accept consumes c if it comes next.
func (p *parser) accept(c byte) bool {
	if p.pos < len(p.data) && p.data[p.pos] == c {
		p.pos++
		return true
	}
	return false
}

// value parses one value inside depth arrays and objects.
func (p *parser) value(depth int) (*node, *DecodeError) {
	p.space()
	if p.pos >= len(p.data) {
		return nil, p.fail("unexpected end of input")
	}
	start := p.pos
	switch c := p.data[p.pos]; c {
	case '{', '[':
		if depth+1 >= maxDepth {
			return nil, failAt(CodeTooDeep, p.pos, fmt.Sprintf("recursion limit exceeded, more than %d nested arrays and objects", maxDepth-1))
		}
		if c == '{' {
			return p.object(start, depth+1)
		}
		return p.array(start, depth+1)
	case '"':
		text, err := p.str()
		if err != nil {
			return nil, err
		}
		return &node{kind: '"', raw: p.data[start:p.pos], text: text}, nil
	case 't':
		return p.literal(start, "true", 't')
	case 'f':
		return p.literal(start, "false", 'f')
	case 'n':
		return p.literal(start, "null", 'n')
	default:
		return p.number(start)
	}
}

// literal reads true, false or null, failing at the first byte that differs, like serde_json.
func (p *parser) literal(start int, word string, kind byte) (*node, *DecodeError) {
	for i := 0; i < len(word); i++ {
		if p.pos >= len(p.data) || p.data[p.pos] != word[i] {
			return nil, p.fail("invalid literal")
		}
		p.pos++
	}
	return &node{kind: kind, raw: p.data[start:p.pos]}, nil
}

func (p *parser) object(start, depth int) (*node, *DecodeError) {
	n := &node{kind: '{', fields: map[string]*node{}}
	p.pos++
	p.space()
	if p.accept('}') {
		n.raw = p.data[start:p.pos]
		return n, nil
	}
	for {
		p.space()
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, p.fail("expected a key")
		}
		keyAt := p.pos
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		if _, seen := n.fields[key]; seen {
			return nil, failAt(CodeDuplicateKey, keyAt, fmt.Sprintf("key %q given twice", key))
		}
		p.space()
		if !p.accept(':') {
			return nil, p.fail("expected a colon")
		}
		value, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		n.keys = append(n.keys, key)
		n.fields[key] = value
		p.space()
		if p.accept('}') {
			n.raw = p.data[start:p.pos]
			return n, nil
		}
		if !p.accept(',') {
			return nil, p.fail("expected a comma or a closing brace")
		}
	}
}

func (p *parser) array(start, depth int) (*node, *DecodeError) {
	n := &node{kind: '['}
	p.pos++
	p.space()
	if p.accept(']') {
		n.raw = p.data[start:p.pos]
		return n, nil
	}
	for {
		item, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		n.items = append(n.items, item)
		p.space()
		if p.accept(']') {
			n.raw = p.data[start:p.pos]
			return n, nil
		}
		if !p.accept(',') {
			return nil, p.fail("expected a comma or a closing bracket")
		}
	}
}

// str parses a string, rejecting invalid UTF-8, control characters and lone surrogates.
func (p *parser) str() (string, *DecodeError) {
	start := p.pos
	p.pos++
	escaped := false
	for {
		if p.pos >= len(p.data) {
			return "", p.fail("unterminated string")
		}
		switch c := p.data[p.pos]; {
		case c == '"':
			p.pos++
			raw := p.data[start:p.pos]
			if !escaped {
				return string(raw[1 : len(raw)-1]), nil
			}
			// The escapes were checked as they were read, so unescaping can't fail.
			var text string
			_ = json.Unmarshal(raw, &text)
			return text, nil
		case c == '\\\\':
			escaped = true
			if err := p.escape(); err != nil {
				return "", err
			}
		case c < 0x20:
			return "", p.fail("control character in a string")
		default:
			p.pos++
		}
	}
}

// escape reads one escape sequence at the backslash. A \\u escape of a high surrogate must be
// followed by one of a low surrogate, and a low surrogate can't stand alone. A bad escape or hex
// digit fails at that byte, and a surrogate that isn't half of a pair fails at the backslash.
func (p *parser) escape() *DecodeError {
	start := p.pos
	p.pos++
	if p.pos < len(p.data) && strings.IndexByte("\\"\\\\/bfnrt", p.data[p.pos]) >= 0 {
		p.pos++
		return nil
	}
	if p.pos >= len(p.data) || p.data[p.pos] != 'u' {
		return p.fail("invalid escape")
	}
	p.pos++
	unit, err := p.hex4()
	if err != nil {
		return err
	}
	if unit >= 0xDC00 && unit <= 0xDFFF {
		return failAt(CodeInvalidJSON, start, "lone surrogate")
	}
	if unit >= 0xD800 && unit <= 0xDBFF {
		if p.pos+1 >= len(p.data) || p.data[p.pos] != '\\\\' || p.data[p.pos+1] != 'u' {
			return failAt(CodeInvalidJSON, start, "lone surrogate")
		}
		p.pos += 2
		low, err := p.hex4()
		if err != nil {
			return err
		}
		if low < 0xDC00 || low > 0xDFFF {
			return failAt(CodeInvalidJSON, start, "lone surrogate")
		}
	}
	return nil
}

// hex4 reads the four hex digits of a \\u escape, failing at the first that isn't one.
func (p *parser) hex4() (int, *DecodeError) {
	unit := 0
	for range 4 {
		if p.pos >= len(p.data) {
			return 0, p.fail("invalid escape")
		}
		digit := strings.IndexByte("0123456789abcdefABCDEF", p.data[p.pos])
		if digit > 15 {
			digit -= 6
		}
		if digit < 0 {
			return 0, p.fail("invalid escape")
		}
		unit = unit*16 + digit
		p.pos++
	}
	return unit, nil
}

// digits consumes digits and returns how many.
func (p *parser) digits() int {
	start := p.pos
	for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
		p.pos++
	}
	return p.pos - start
}

// number parses a number in JSON's grammar that is finite as a float64, like serde_json.
func (p *parser) number(start int) (*node, *DecodeError) {
	p.accept('-')
	if p.accept('0') {
		if p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			return nil, p.fail("leading zero")
		}
	} else if p.digits() == 0 {
		return nil, p.fail("invalid value")
	}
	if p.accept('.') && p.digits() == 0 {
		return nil, p.fail("invalid number")
	}
	if p.accept('e') || p.accept('E') {
		if !p.accept('+') {
			p.accept('-')
		}
		if p.digits() == 0 {
			return nil, p.fail("invalid number")
		}
	}
	raw := p.data[start:p.pos]
	if _, err := strconv.ParseFloat(string(raw), 64); err != nil {
		return nil, failAt(CodeInvalidJSON, start, "number out of range")
	}
	return &node{kind: '0', raw: raw}, nil
}

// nodeDecoder is a generated type that decodes itself from a parsed node.
type nodeDecoder interface {
	decode(n *node) *DecodeError
}

// unmarshal parses data once and decodes it into v, for UnmarshalJSON.
func unmarshal[T any, PT interface {
	*T
	nodeDecoder
}](data []byte, v PT) error {
	n, err := parse(data)
	if err == nil {
		err = v.decode(n)
	}
	if err != nil {
		return err
	}
	return nil
}

// decodeRoot parses data once and decodes it with decode.
func decodeRoot[T any](data []byte, decode func(*node) (T, *DecodeError)) (T, error) {
	var v T
	n, err := parse(data)
	if err == nil {
		v, err = decode(n)
	}
	if err != nil {
		var zero T
		return zero, err
	}
	return v, nil
}

// decodeType decodes a generated type, which checks its own shape.
func decodeType[T any, PT interface {
	*T
	nodeDecoder
}](n *node) (T, *DecodeError) {
	var v T
	err := PT(&v).decode(n)
	return v, err
}

// decodeString decodes a JSON string.
func decodeString(n *node) (string, *DecodeError) {
	return n.text, expect(n, '"')
}

// decodeInt decodes a JSON integer that fits an int64. A fraction like 1.5, or 1.0, fails, and
// so does -0, which serde_json reads as a float.
func decodeInt(n *node) (int64, *DecodeError) {
	if err := expect(n, '0'); err != nil {
		return 0, err
	}
	v, err := strconv.ParseInt(string(n.raw), 10, 64)
	if err != nil {
		return 0, failf("expected an integer, found %s", n.raw)
	}
	if v == 0 && n.raw[0] == '-' {
		return 0, failf("expected an integer, found %s", n.raw)
	}
	return v, nil
}

// decodeNumber decodes a finite JSON number as spelled, so 12 re-encodes as 12. Spellings
// Rust writes differently, like 1E2 or 1.50, are kept as they are.
func decodeNumber(n *node) (json.Number, *DecodeError) {
	return json.Number(n.raw), expect(n, '0')
}

// decodeBool decodes a JSON boolean.
func decodeBool(n *node) (bool, *DecodeError) {
	return n.kind == 't', expect(n, 't')
}

// decodeAny keeps any JSON value, null included.
func decodeAny(n *node) (json.RawMessage, *DecodeError) {
	return json.RawMessage(bytes.Clone(n.raw)), nil
}

// boxed returns decode with its result behind a pointer.
func boxed[T any](decode func(*node) (T, *DecodeError)) func(*node) (*T, *DecodeError) {
	return func(n *node) (*T, *DecodeError) {
		v, err := decode(n)
		if err != nil {
			return nil, err
		}
		return &v, nil
	}
}

// decodeSlice returns a decoder of a JSON array whose items decode with item.
func decodeSlice[T any](item func(*node) (T, *DecodeError)) func(*node) ([]T, *DecodeError) {
	return func(n *node) ([]T, *DecodeError) {
		if err := expect(n, '['); err != nil {
			return nil, err
		}
		out := make([]T, 0, len(n.items))
		for i, raw := range n.items {
			v, err := item(raw)
			if err != nil {
				return nil, err.at(strconv.Itoa(i))
			}
			out = append(out, v)
		}
		return out, nil
	}
}

// decodeMap returns a decoder of a JSON object whose keys decode with key and values with value.
func decodeMap[K comparable, V any](
	key func(*node) (K, *DecodeError),
	value func(*node) (V, *DecodeError),
) func(*node) (map[K]V, *DecodeError) {
	return func(n *node) (map[K]V, *DecodeError) {
		if err := expect(n, '{'); err != nil {
			return nil, err
		}
		out := make(map[K]V, len(n.keys))
		for _, name := range n.keys {
			k, v, err := entry(key, value, name, n.fields[name])
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, nil
	}
}

// entry decodes one member of a map, its key as a JSON string.
func entry[K, V any](
	key func(*node) (K, *DecodeError),
	value func(*node) (V, *DecodeError),
	name string,
	n *node,
) (K, V, *DecodeError) {
	k, err := key(&node{kind: '"', text: name})
	if err != nil {
		var v V
		return k, v, &DecodeError{Reason: fmt.Sprintf("key %q: %s", name, err.Reason), Code: err.Code}
	}
	v, err := value(n)
	if err != nil {
		return k, v, err.at(name)
	}
	return k, v, nil
}

// objectDecoder reads the keys of a JSON object into a struct and tracks the keys it read.
type objectDecoder struct {
	n    *node
	used map[string]bool
	err  *DecodeError
}

// decodeObject decodes a JSON object strictly: fill reads its keys, any key fill didn't read
// fails, and commit stores the result only when everything decoded.
func decodeObject(n *node, fill func(*objectDecoder), commit func()) *DecodeError {
	if err := expect(n, '{'); err != nil {
		return err
	}
	d := &objectDecoder{n: n, used: make(map[string]bool, len(n.keys))}
	fill(d)
	if d.err != nil {
		return d.err
	}
	for _, key := range n.keys {
		if !d.used[key] {
			return failf("unknown key %q", key)
		}
	}
	commit()
	return nil
}

// required reads a key that must be present.
func required[T any](d *objectDecoder, key string, dst *T, decode func(*node) (T, *DecodeError)) {
	if d.err != nil {
		return
	}
	if _, ok := d.n.fields[key]; !ok {
		d.err = failf("missing key %q", key)
		return
	}
	optionalValue(d, key, dst, decode)
}

// optional reads an optional key into a pointer, which stays nil when the key is absent.
// An explicit null fails, since only decodeAny accepts it.
func optional[T any](d *objectDecoder, key string, dst **T, decode func(*node) (T, *DecodeError)) {
	optionalValue(d, key, dst, boxed(decode))
}

// optionalValue reads an optional key into a value whose zero value means absent, like an
// interface or a json.RawMessage.
func optionalValue[T any](d *objectDecoder, key string, dst *T, decode func(*node) (T, *DecodeError)) {
	if d.err != nil {
		return
	}
	d.used[key] = true
	n, ok := d.n.fields[key]
	if !ok {
		return
	}
	v, err := decode(n)
	if err != nil {
		d.err = err.at(key)
		return
	}
	*dst = v
}

// rest reads every key not read yet into a map, for a struct with named keys and a map of the others.
func rest[K comparable, V any](
	d *objectDecoder,
	dst *map[K]V,
	key func(*node) (K, *DecodeError),
	value func(*node) (V, *DecodeError),
) {
	if d.err != nil {
		return
	}
	out := make(map[K]V)
	for _, name := range d.n.keys {
		if d.used[name] {
			continue
		}
		d.used[name] = true
		k, v, err := entry(key, value, name, d.n.fields[name])
		if err != nil {
			d.err = err
			return
		}
		out[k] = v
	}
	*dst = out
}

// checkRequired fails when one of the named required fields is nil.
func checkRequired(names []string, set []bool) error {
	for i, ok := range set {
		if !ok {
			return fmt.Errorf("required key %q is nil, which would encode as null", names[i])
		}
	}
	return nil
}

// encodeRequired encodes a struct after checking its required slices, maps, unions and pointers.
func encodeRequired(plain any, names []string, set ...bool) ([]byte, error) {
	if err := checkRequired(names, set); err != nil {
		return nil, err
	}
	data, err := json.Marshal(plain)
	if err != nil {
		return nil, fmt.Errorf("encoding: %w", err)
	}
	return data, nil
}

// encodeWithRest encodes the named keys of a struct, then the keys of rest sorted, as one
// object, the order Rust writes. It fails when rest holds one of the named keys, so no key
// is written twice, or when a required field is nil.
func encodeWithRest[K ~string, V any](named any, rest map[K]V, keys, names []string, set ...bool) ([]byte, error) {
	if err := checkRequired(names, set); err != nil {
		return nil, err
	}
	data, err := json.Marshal(named)
	if err != nil {
		return nil, fmt.Errorf("encoding named keys: %w", err)
	}
	var out bytes.Buffer
	out.Write(data[:len(data)-1])
	first := len(data) == 2
	for _, key := range slices.Sorted(maps.Keys(rest)) {
		if slices.Contains(keys, string(key)) {
			return nil, fmt.Errorf("rest holds the named key %q", string(key))
		}
		member, err := json.Marshal(map[K]V{key: rest[key]})
		if err != nil {
			return nil, fmt.Errorf("encoding key %q: %w", string(key), err)
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		out.Write(member[1 : len(member)-1])
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// decodeTagged reads the tag key of a JSON object and decodes only the branch it names,
// naming the branch in errors.
func decodeTagged[U any](n *node, key string, branches map[string]func(*node) (U, *DecodeError)) (U, *DecodeError) {
	var zero U
	if err := expect(n, '{'); err != nil {
		return zero, err
	}
	tag, ok := n.fields[key]
	if !ok {
		return zero, failf("missing key %q", key)
	}
	if tag.kind != '"' {
		return zero, failf("%q must be a string, found %s", key, kindName(tag.kind))
	}
	decode, ok := branches[tag.text]
	if !ok {
		names := strings.Join(slices.Sorted(maps.Keys(branches)), ", ")
		return zero, failf("unknown %s %q, expected one of %s", key, tag.text, names)
	}
	v, err := decode(n)
	if err != nil {
		return zero, &DecodeError{Path: err.Path, Reason: fmt.Sprintf("%s %q: %s", key, tag.text, err.Reason), Code: err.Code}
	}
	return v, nil
}

// branch decodes one branch of a tagged union as the union's interface type U.
func branch[U any, T any, PT interface {
	*T
	nodeDecoder
}](n *node) (U, *DecodeError) {
	v, err := decodeType[T, PT](n)
	if err != nil {
		var zero U
		return zero, err
	}
	return any(v).(U), nil
}

// decodeUntagged tries each variant in order and commits the first one that decodes.
func decodeUntagged(n *node, name string, commit func(), variants ...func(*node) bool) *DecodeError {
	for _, variant := range variants {
		if variant(n) {
			commit()
			return nil
		}
	}
	return failf("data did not match any variant of %s", name)
}

// try returns a variant of an untagged union that decodes into a pointer field.
func try[T any](dst **T, decode func(*node) (T, *DecodeError)) func(*node) bool {
	return tryValue(dst, boxed(decode))
}

// tryValue returns a variant of an untagged union that decodes into a value field.
func tryValue[T any](dst *T, decode func(*node) (T, *DecodeError)) func(*node) bool {
	return func(n *node) bool {
		v, err := decode(n)
		if err != nil {
			return false
		}
		*dst = v
		return true
	}
}

// encodeUntagged encodes the one variant that is set. None or more than one fails.
func encodeUntagged(name string, variants ...any) ([]byte, error) {
	var set []any
	for _, v := range variants {
		if v != nil {
			set = append(set, v)
		}
	}
	if len(set) != 1 {
		return nil, fmt.Errorf("%s must hold exactly one variant, it holds %d", name, len(set))
	}
	data, err := json.Marshal(set[0])
	if err != nil {
		return nil, fmt.Errorf("encoding %s: %w", name, err)
	}
	return data, nil
}

// some returns p as an any that is nil when p is nil.
func some[T any](p *T) any {
	if p == nil {
		return nil
	}
	return p
}

// someRaw returns raw as an any that is nil when raw is absent.
func someRaw(raw json.RawMessage) any {
	if raw == nil {
		return nil
	}
	return raw
}

// decodeEnum decodes a JSON string that must be one of values.
func decodeEnum[T ~string](n *node, dst *T, values ...T) *DecodeError {
	s, err := decodeString(n)
	if err != nil {
		return err
	}
	if !slices.Contains(values, T(s)) {
		return failf("unknown value %q", s)
	}
	*dst = T(s)
	return nil
}

// encodeEnum returns the text of v, failing when values doesn't list it. Used as MarshalText,
// it covers values; a map key of a string type is written without it.
func encodeEnum[T ~string](v T, values ...T) ([]byte, error) {
	if !slices.Contains(values, v) {
		return nil, fmt.Errorf("unknown value %q", string(v))
	}
	return []byte(v), nil
}

// decodeStringInto decodes a JSON string into a named string type, like an id.
func decodeStringInto[T ~string](n *node, dst *T) *DecodeError {
	s, err := decodeString(n)
	if err != nil {
		return err
	}
	*dst = T(s)
	return nil
}

// decodeConstInt decodes an integer that must be want.
func decodeConstInt(n *node, want int64) *DecodeError {
	v, err := decodeInt(n)
	if err != nil {
		return err
	}
	if v != want {
		return failf("expected %d, found %d", want, v)
	}
	return nil
}

// decodeConstBool decodes a boolean that must be want.
func decodeConstBool(n *node, want bool) *DecodeError {
	v, err := decodeBool(n)
	if err != nil {
		return err
	}
	if v != want {
		return failf("expected %t, found %t", want, v)
	}
	return nil
}

// ${GO_NON_NULL} is any JSON value except null at the top, like jsonValue. Nested values may be anything.
type ${GO_NON_NULL} json.RawMessage

// MarshalJSON encodes the value as it was decoded. An empty value fails.
func (v ${GO_NON_NULL}) MarshalJSON() ([]byte, error) {
	if len(v) == 0 {
		return nil, errors.New("${GO_NON_NULL} is empty")
	}
	return []byte(v), nil
}

// UnmarshalJSON keeps any JSON value except null.
func (v *${GO_NON_NULL}) UnmarshalJSON(data []byte) error { return unmarshal(data, v) }

func (v *${GO_NON_NULL}) decode(n *node) *DecodeError {
	if n.kind == 'n' {
		return failf("expected a JSON value other than null")
	}
	*v = ${GO_NON_NULL}(bytes.Clone(n.raw))
	return nil
}
`;
