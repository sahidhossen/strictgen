import type { EmittedFile } from "./common.js";
import { bySchema, commentHeader, compare, DEFAULT_HEADER, declTypes, imports } from "./common.js";
import { CodegenError } from "./schema.js";
import type { Decl, Model, StructDecl, TypeExpr } from "./model.js";
import { RENAME_TYPE, TS_RESERVED } from "./naming.js";
import { TS_HELPERS_BODY } from "./ts-helpers.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WIDTH = 100;

/** Name of the generated file with the decoding helpers. */
export const TS_HELPERS = "helpers.ts";

/** What `index.ts` re-exports from the helpers, besides the generated types and functions. */
const HELPER_EXPORTS = ["DecodeError", "EncodeError", "DecodeResult"];

/**
 * Global types the generated TypeScript names, and the helper names `index.ts` re-exports.
 * A schema type named like one would shadow or clash with it.
 */
const RESERVED = new Set(["Record", "Partial", "NonNullable", ...HELPER_EXPORTS]);

/** Options for {@link emitTypeScript}. */
export interface TypeScriptOptions {
  /** The header text each file starts with, as a comment. */
  readonly header?: string;
  /** Modules written by another emitter whose values `index.ts` re-exports. */
  readonly valueModules?: readonly string[];
  /** Emits `decodeX`, `tryDecodeX` and `encodeX` per type, and `helpers.ts`. Defaults to true. */
  readonly decoders?: boolean;
}

interface Ctx {
  readonly decls: ReadonlyMap<string, Decl>;
  /** The generated functions of declarations a file calls, like `decodeUserId`. */
  readonly calls: Set<string>;
}

/**
 * Emits the TypeScript files for the folder the TypeScript target owns: one file per
 * schema, named after the schema file, importing what it uses from the others,
 * `helpers.ts` with the decoding helpers when decoders are on, and `index.ts`, which
 * re-exports every type and function, and the values of `valueModules`.
 */
export function emitTypeScript(model: Model, options: TypeScriptOptions = {}): EmittedFile[] {
  const header = commentHeader(options.header ?? DEFAULT_HEADER);
  const valueModules = options.valueModules ?? [];
  const decoders = options.decoders ?? true;
  const decls = new Map(model.decls.map((d) => [d.name, d]));
  for (const decl of model.decls) {
    if (RESERVED.has(decl.name) || TS_RESERVED.has(decl.name)) {
      throw new CodegenError(
        decl.path,
        "reserved-name",
        `type name ${decl.name} is reserved in TypeScript`,
        RENAME_TYPE,
      );
    }
  }
  const files = [...bySchema(model)].map(([schema, own]) => {
    if (schema === "index" || schema === "helpers")
      throw new CodegenError(
        own[0]?.path ?? schema,
        "reserved-name",
        `a schema named ${schema} clashes with ${schema}.ts`,
        "rename the schema file",
      );
    const ctx: Ctx = { decls, calls: new Set() };
    const body = own.map((decl) => declaration(ctx, decl, decoders)).join("\n");
    const what = decoders ? "Types and decoders" : "Types";
    const head = `${header}\n\n/** ${what} for \`${schema}.json\`. */\n\n`;
    const uses = importLines(model, own, ctx.calls);
    if (decoders) uses.unshift(`import * as h from "./helpers.js";\n`);
    return {
      name: `${schema}.ts`,
      contents: `${head}${uses.length > 0 ? `${uses.join("")}\n` : ""}${body}`,
    };
  });
  const index = [
    ...files.map((f) => `export * from "./${f.name.replace(/\.ts$/, ".js")}";\n`),
    ...valueModules.map((m) => `export * from "./${m}.js";\n`),
  ];
  if (decoders) {
    const names = HELPER_EXPORTS.map((n) => (n === "DecodeResult" ? `type ${n}` : n));
    index.push(`export { ${names.join(", ")} } from "./helpers.js";\n`);
  }
  return [
    ...files,
    ...(decoders ? [{ name: TS_HELPERS, contents: `${header}\n\n${TS_HELPERS_BODY}` }] : []),
    { name: "index.ts", contents: `${header}\n\n${index.join("")}` },
  ];
}

/**
 * The imports of a schema file from the others: the types its declarations name, and the
 * generated functions it calls, like `decodeUserId`, one line per file.
 */
function importLines(model: Model, own: readonly Decl[], calls: ReadonlySet<string>): string[] {
  const types = imports(model, own, tsTypes);
  const owner = new Map(model.decls.map((d) => [d.name, d.schema]));
  const schema = own[0]?.schema;
  const values = new Map<string, string[]>();
  for (const call of [...calls].sort(compare)) {
    const file = owner.get(call.replace(/^(decode|encode)/, ""));
    if (file === undefined || file === schema) continue;
    values.set(file, [...(values.get(file) ?? []), call]);
  }
  const files = [...new Set([...types.keys(), ...values.keys()])].sort(compare);
  return files.map((file) => {
    const fns = values.get(file) ?? [];
    const names = types.get(file) ?? [];
    if (fns.length === 0) return `import type { ${names.join(", ")} } from "./${file}.js";\n`;
    const all = [...fns, ...names.map((n) => `type ${n}`)];
    const line = `import { ${all.join(", ")} } from "./${file}.js";\n`;
    if (line.length <= WIDTH + 1) return line;
    return `import {\n${all.map((n) => `  ${n},\n`).join("")}} from "./${file}.js";\n`;
  });
}

/** The types the TypeScript output names: a rest map's keys are typed as `string` by the index signature. */
function tsTypes(decl: Decl): TypeExpr[] {
  if (decl.kind !== "struct" || decl.rest === undefined) return declTypes(decl);
  return [...decl.fields.map((f) => f.type), decl.rest.value];
}

function declaration(ctx: Ctx, decl: Decl, decoders: boolean): string {
  const head = doc(decl.doc, "");
  const cast = decl.kind === "id" ? `\n${castFunction(decl.name)}` : "";
  return `${head}${typeDeclaration(ctx, decl)}${cast}${decoders ? `\n${functions(ctx, decl)}` : ""}`;
}

function typeDeclaration(ctx: Ctx, decl: Decl): string {
  switch (decl.kind) {
    case "struct":
      return struct(decl, ctx.decls);
    case "enum":
      return union(
        decl.name,
        decl.values.map((v) => JSON.stringify(v)),
      );
    case "tagged":
      return union(
        decl.name,
        decl.variants.map((v) => v.type),
      );
    case "untagged":
      return union(
        decl.name,
        decl.variants.map((v) => typeText(v.type, ctx.decls)),
      );
    case "alias":
      return `export type ${decl.name} = ${typeText(decl.type, ctx.decls)};\n`;
    case "id":
      // Branded, so ids of different kinds don't mix. Only the decoder or the cast makes one.
      return `export type ${decl.name} = string & { readonly __brand: ${JSON.stringify(decl.name)} };\n`;
  }
}

/** The documented cast of an id, for a string the caller knows is one. */
function castFunction(name: string): string {
  return (
    `/** Marks a string as ${name} without checking it. Decode input from outside with decode${name}. */\n` +
    `export function as${name}(value: string): ${name} {\n  return value as ${name};\n}\n`
  );
}

/** `decodeX`, `tryDecodeX` and `encodeX` for one declaration. */
function functions(ctx: Ctx, decl: Decl): string {
  const name = decl.name;
  return (
    `/**\n * Decodes parsed JSON as ${name}, strictly. Throws a DecodeError at the JSON Pointer of\n` +
    ` * the first problem, under \`path\` when given.\n */\n` +
    `export function decode${name}(json: unknown, path = ""): ${name} {\n${decodeBody(ctx, decl)}}\n\n` +
    `/** Like decode${name}, but returns the DecodeError instead of throwing it. */\n` +
    `export function tryDecode${name}(json: unknown): h.DecodeResult<${name}> {\n` +
    `  return h.attempt(decode${name}, json);\n}\n\n` +
    `/** Encodes ${name} as a JSON value, ready for JSON.stringify. */\n` +
    `export function encode${name}(${encodeParam(decl)}: ${name}): unknown {\n${encodeBody(ctx, decl)}}\n`
  );
}

/** The encoder's parameter: `_value` for an object with no keys, whose encoder never reads it. */
function encodeParam(decl: Decl): string {
  const empty = decl.kind === "struct" && decl.fields.length === 0 && decl.rest === undefined;
  return empty ? "_value" : "value";
}

/** Unions have no TypeScript decoder or encoder yet. Theirs fail every value, never pass one through. */
function pending(decl: Decl): string | undefined {
  if (decl.kind === "tagged") return "tagged unions";
  if (decl.kind === "untagged") return "untagged unions";
  return undefined;
}

function decodeBody(ctx: Ctx, decl: Decl): string {
  const missing = pending(decl);
  if (missing !== undefined) return `  return h.unsupported(${JSON.stringify(missing)})(json, path);\n`;
  switch (decl.kind) {
    case "struct":
      return decodeStruct(ctx, decl);
    case "enum":
      return `  return h.enumValue(json, path, [${decl.values.map((v) => JSON.stringify(v)).join(", ")}] as const);\n`;
    case "id":
      return `  return h.decodeString(json, path) as ${decl.name};\n`;
    case "alias":
      return `  return ${decoder(ctx, decl.type)}(json, path);\n`;
    case "tagged":
    case "untagged":
      return "";
  }
}

/**
 * Reads the named keys in schema order, then the rest map or the unknown key check, like Go,
 * so the first missing or bad key in schema order is the error.
 */
function decodeStruct(ctx: Ctx, decl: StructDecl): string {
  const named = `[${decl.fields.map((f) => JSON.stringify(f.name)).join(", ")}]`;
  if (decl.fields.length === 0 && decl.rest === undefined) {
    return `  h.closed(h.object(json, path), path, []);\n  return {};\n`;
  }
  const lines = decl.fields.map((f) => {
    const key = JSON.stringify(f.name);
    const decode = decoder(ctx, f.type);
    return f.required
      ? `    ${literalKey(f.name)}: h.required(o, ${key}, path, ${decode}),\n`
      : `    ...h.optional(o, ${key}, path, ${decode}),\n`;
  });
  if (decl.rest !== undefined) {
    const key = decoder(ctx, decl.rest.key);
    const value = decoder(ctx, decl.rest.value);
    lines.push(`    ...h.rest(o, path, ${named}, ${key}, ${value}),\n`);
  }
  const check = decl.rest === undefined ? `  h.closed(o, path, ${named});\n` : "";
  return (
    `  const o = h.object(json, path);\n` +
    `  const value: ${decl.name} = {\n${lines.join("")}  };\n${check}  return value;\n`
  );
}

function encodeBody(ctx: Ctx, decl: Decl): string {
  const missing = pending(decl);
  if (missing !== undefined) return `  return h.cannotEncode(${JSON.stringify(missing)}, value);\n`;
  switch (decl.kind) {
    case "struct":
      return encodeStruct(ctx, decl);
    case "enum":
    case "id":
      return "  return value;\n";
    case "alias":
      return `  return ${encoder(ctx, decl.type, "value")};\n`;
    case "tagged":
    case "untagged":
      return "";
  }
}

/** Writes the named keys in schema order, then the rest keys sorted, as Rust and Go do. */
function encodeStruct(ctx: Ctx, decl: StructDecl): string {
  const lines = decl.fields.map((f) => {
    const read = `value${access(f.name)}`;
    const put = `h.put(out, ${JSON.stringify(f.name)}, ${encoder(ctx, f.type, read)});\n`;
    return f.required ? `  ${put}` : `  if (${read} !== undefined) ${put}`;
  });
  if (decl.rest !== undefined) {
    const named = `[${decl.fields.map((f) => JSON.stringify(f.name)).join(", ")}]`;
    const type = typeText(decl.rest.value, ctx.decls);
    const encode = encoder(ctx, decl.rest.value, "item");
    lines.push(`  h.putRest<${type}>(out, value, ${named}, (item) => ${encode});\n`);
  }
  return `  const out = {};\n${lines.join("")}  return out;\n`;
}

/** An expression for the decoder of a type, a `Decoder<T>`. */
function decoder(ctx: Ctx, type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      ctx.calls.add(`decode${type.name}`);
      return `decode${type.name}`;
    case "string":
      return "h.decodeString";
    case "integer":
      return "h.decodeInteger";
    case "number":
      return "h.decodeNumber";
    case "boolean":
      return "h.decodeBoolean";
    case "literal":
      return `h.literal(${String(type.value)})`;
    case "any":
      return `h.unsupported("any JSON values")`;
    case "nonNull":
      return `h.unsupported("non-null JSON values")`;
    case "array":
      return `h.array(${decoder(ctx, type.items)})`;
    case "map":
      return `h.map(${decoder(ctx, type.key)}, ${decoder(ctx, type.value)})`;
  }
}

/** An expression that encodes `value`, an expression of the type. */
function encoder(ctx: Ctx, type: TypeExpr, value: string): string {
  switch (type.kind) {
    case "ref":
      ctx.calls.add(`encode${type.name}`);
      return `encode${type.name}(${value})`;
    case "string":
    case "integer":
    case "number":
    case "boolean":
    case "literal":
      return value;
    case "any":
      return `h.cannotEncode("any JSON values", ${value})`;
    case "nonNull":
      return `h.cannotEncode("non-null JSON values", ${value})`;
    case "array": {
      const item = encoder(ctx, type.items, "item");
      return item === "item" ? `[...${value}]` : `${value}.map((item) => ${item})`;
    }
    case "map": {
      const type_ = typeText(type.value, ctx.decls);
      return `h.encodeMap(${value}, (item: ${type_}) => ${encoder(ctx, type.value, "item")})`;
    }
  }
}

/** A property name in an object literal. `__proto__` is computed, so it stays an own key. */
function literalKey(name: string): string {
  return name === "__proto__" ? `[${JSON.stringify(name)}]` : property(name);
}

/** Reads a property: `.name`, or `["name"]` when the key is not an identifier, or is `__proto__`. */
function access(name: string): string {
  return IDENTIFIER.test(name) && name !== "__proto__" ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function struct(decl: StructDecl, decls: ReadonlyMap<string, Decl>): string {
  if (decl.fields.length === 0 && decl.forbidden.length === 0 && decl.rest === undefined) {
    return `export type ${decl.name} = Record<string, ${decl.closed ? "never" : "unknown"}>;\n`;
  }
  const lines = decl.fields.map((field) => {
    const optional = field.required ? "" : "?";
    return `${doc(field.doc, "  ")}  ${property(field.name)}${optional}: ${typeText(field.type, decls)};\n`;
  });
  for (const key of decl.forbidden) lines.push(`  ${property(key)}?: never;\n`);
  if (decl.rest !== undefined) {
    // An index signature must also cover the named properties.
    const types = new Set(
      [decl.rest.value, ...decl.fields.map((f) => f.type)].map((t) => typeText(t, decls)),
    );
    lines.push(`  [key: string]: ${[...types].join(" | ")};\n`);
  }
  return `export interface ${decl.name} {\n${lines.join("")}}\n`;
}

function union(name: string, members: readonly string[]): string {
  const line = `export type ${name} = ${members.join(" | ")};`;
  if (line.length <= WIDTH) return `${line}\n`;
  return `export type ${name} =\n${members.map((m) => `  | ${m}`).join("\n")};\n`;
}

function property(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function typeText(type: TypeExpr, decls: ReadonlyMap<string, Decl>): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "string":
    case "boolean":
      return type.kind;
    case "integer":
    case "number":
      return "number";
    case "literal":
      return String(type.value);
    case "any":
      return "unknown";
    case "nonNull":
      return "NonNullable<unknown>";
    case "array": {
      const items = typeText(type.items, decls);
      return IDENTIFIER.test(items) ? `${items}[]` : `(${items})[]`;
    }
    case "map": {
      const record = `Record<${typeText(type.key, decls)}, ${typeText(type.value, decls)}>`;
      return isEnum(type.key, decls) ? `Partial<${record}>` : record;
    }
  }
}

/** True when a map key is a closed set of strings, so a record of it must allow missing keys. */
function isEnum(type: TypeExpr, decls: ReadonlyMap<string, Decl>): boolean {
  let current = type;
  for (let depth = 0; current.kind === "ref" && depth <= decls.size; depth++) {
    const decl = decls.get(current.name);
    if (decl?.kind === "enum") return true;
    if (decl?.kind !== "alias") return false;
    current = decl.type;
  }
  return false;
}

/** A TSDoc comment, or nothing when there is no text. */
export function doc(text: string, indent: string): string {
  if (text === "") return "";
  const lines = text.replaceAll("*/", "*\\/").split("\n");
  if (lines.length === 1) return `${indent}/** ${lines[0] ?? ""} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} *${l === "" ? "" : ` ${l}`}`).join("\n")}\n${indent} */\n`;
}
