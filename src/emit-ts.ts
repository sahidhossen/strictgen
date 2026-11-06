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
    default:
      return unreachable(decl);
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
    `/**\n * Reads JSON text as ${name}, strictly. Throws a DecodeError for text that is not JSON, or\n` +
    ` * not JSON Rust and Go read, like a key given twice or 12.0 for an integer, and for a value\n` +
    ` * that doesn't fit, at the JSON Pointer of the first problem.\n */\n` +
    `export function decode${name}FromJson(text: string): ${name} {\n` +
    `  return h.fromJson(text, decode${name});\n}\n\n` +
    `/** Like decode${name}FromJson, but returns the DecodeError instead of throwing it. */\n` +
    `export function tryDecode${name}FromJson(text: string): h.DecodeResult<${name}> {\n` +
    `  return h.attemptJson(decode${name}, text);\n}\n\n` +
    `/**\n * Encodes ${name} as a JSON value, ready for JSON.stringify.\n` +
    ` * Throws an EncodeError for a value Rust and Go could not hold, like an unknown key.\n */\n` +
    `export function encode${name}(value: ${name}): unknown {\n${encodeBody(ctx, decl)}}\n`
  );
}

/** Fails to compile when a switch misses a model kind, so every kind gets a decoder and an encoder. */
function unreachable(value: never): never {
  throw new Error(`unhandled model kind ${JSON.stringify(value)}`);
}

/** An array literal of items, on one line when it fits, else one item per line. */
function list(items: readonly string[], indent: string, used: number): string {
  const line = `[${items.join(", ")}]`;
  if (used + line.length <= WIDTH) return line;
  return `[\n${items.map((i) => `${indent}  ${i},\n`).join("")}${indent}]`;
}

function decodeBody(ctx: Ctx, decl: Decl): string {
  switch (decl.kind) {
    case "struct":
      return decodeStruct(ctx, decl);
    case "enum":
      return `  return h.enumValue(json, path, [${decl.values.map((v) => JSON.stringify(v)).join(", ")}] as const);\n`;
    case "id":
      return `  return h.decodeString(json, path) as ${decl.name};\n`;
    case "alias":
      return `  return ${decoder(ctx, decl.type)}(json, path);\n`;
    case "tagged": {
      // The model spreads nested tagged unions, so every variant here is one branch struct.
      const branches = decl.variants.map(
        (v) => `[${JSON.stringify(v.value)}, ${decoder(ctx, { kind: "ref", name: v.type })}]`,
      );
      const head = `  return h.tagged<${decl.name}>(json, path, ${JSON.stringify(decl.tag)}, `;
      return `${head}${list(branches, "  ", head.length + 2)});\n`;
    }
    case "untagged": {
      const variants = decl.variants.map((v) => decoder(ctx, v.type));
      const head = `  return h.untagged<${decl.name}>(json, path, ${JSON.stringify(decl.name)}, `;
      return `${head}${list(variants, "  ", head.length + 2)});\n`;
    }
    default:
      return unreachable(decl);
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
  switch (decl.kind) {
    case "struct":
      return encodeStruct(ctx, decl);
    case "enum":
      return `  return h.encodeEnum(value, [${decl.values.map((v) => JSON.stringify(v)).join(", ")}] as const);\n`;
    case "id":
      return "  return h.encodeString(value);\n";
    case "alias":
      return `  return ${encoder(ctx, decl.type)}(value);\n`;
    case "tagged": {
      const branches = decl.variants.map(
        (v) => `[${JSON.stringify(v.value)}, ${encoder(ctx, { kind: "ref", name: v.type })}]`,
      );
      const head = `  return h.encodeTagged(value, ${JSON.stringify(decl.tag)}, `;
      return `${head}${list(branches, "  ", head.length + 2)});\n`;
    }
    case "untagged": {
      const variants = decl.variants.map((v) => encoder(ctx, v.type));
      const head = `  return h.encodeUntagged(value, ${JSON.stringify(decl.name)}, `;
      return `${head}${list(variants, "  ", head.length + 2)});\n`;
    }
    default:
      return unreachable(decl);
  }
}

/**
 * Checks the value is an object, writes the named keys in schema order, then the rest keys
 * sorted, as Rust and Go do. Without a rest map, a key the type doesn't name fails, since Rust
 * and Go could not hold it and dropping it would lose data.
 */
function encodeStruct(ctx: Ctx, decl: StructDecl): string {
  const named = `[${decl.fields.map((f) => JSON.stringify(f.name)).join(", ")}]`;
  const lines = decl.fields.map((f) => {
    const read = `value${access(f.name)}`;
    const put = `h.member(out, ${JSON.stringify(f.name)}, ${read}, ${encoder(ctx, f.type)});\n`;
    return f.required ? `  ${put}` : `  if (${read} !== undefined) ${put}`;
  });
  if (decl.rest !== undefined) {
    const key = encoder(ctx, decl.rest.key);
    const value = encoder(ctx, decl.rest.value);
    lines.push(`  h.putRest(out, value, ${named}, ${key}, ${value});\n`);
  } else {
    lines.push(`  h.encodeClosed(value, ${named});\n`);
  }
  return `  h.encodeObject(value);\n  const out = {};\n${lines.join("")}  return out;\n`;
}

/** An expression for the decoder of a type, a `Decoder<T>`. */
function decoder(ctx: Ctx, type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      ctx.calls.add(`decode${type.name}`);
      return `decode${type.name}`;
    case "string": {
      const text = stringType(type.pattern);
      return text === "string" ? "h.decodeString" : `h.family<${text}>()`;
    }
    case "integer":
      return "h.decodeInteger";
    case "number":
      return "h.decodeNumber";
    case "boolean":
      return "h.decodeBoolean";
    case "literal":
      return `h.literal(${String(type.value)})`;
    case "any":
      return "h.decodeAny";
    case "nonNull":
      return "h.decodeNonNull";
    case "array":
      return `h.array(${decoder(ctx, type.items)})`;
    case "map":
      return `h.map(${decoder(ctx, type.key)}, ${decoder(ctx, type.value)})`;
    default:
      return unreachable(type);
  }
}

/** An expression for the encoder of a type, an `Encoder<T>`, which checks what it writes. */
function encoder(ctx: Ctx, type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      ctx.calls.add(`encode${type.name}`);
      return `encode${type.name}`;
    case "string":
      return "h.encodeString";
    case "integer":
      return "h.encodeInteger";
    case "number":
      return "h.encodeNumber";
    case "boolean":
      return "h.encodeBoolean";
    case "literal":
      return `h.encodeLiteral(${String(type.value)})`;
    case "any":
      return "h.encodeAny";
    case "nonNull":
      return "h.encodeNonNull";
    case "array":
      return `h.encodeArray(${encoder(ctx, type.items)})`;
    case "map":
      return `h.encodeMap(${encoder(ctx, type.key)}, ${encoder(ctx, type.value)})`;
    default:
      return unreachable(type);
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
      return stringType(type.pattern);
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
    default:
      return unreachable(type);
  }
}

/** Pattern syntax characters, which a backslash before them makes literal. */
const SYNTAX = "^$\\.*+?()[]{}|/";

/** True for a character a pattern holds as itself: not syntax, and not a control character. */
function isLiteral(c: string): boolean {
  const code = c.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return false;
  return !"^$\\.*+?()[]{}|".includes(c);
}

/**
 * The fixed prefix and suffix of a pattern that allows anything between them, or undefined
 * when the pattern has another shape. The shapes are `^P`, `^P.*`, `^P.+`, `S$`, `.*S$`,
 * `.+S$`, `^P.*S$` and `^P.+S$`, where P and S are literal characters, or syntax characters
 * escaped with a backslash like `\.`, and at least one of them is not empty. So `^order\..+$`
 * gives the prefix `order.`. The template literal type of such a family holds every string the
 * pattern matches, and a few it doesn't, like `order.` itself for `.+`.
 */
export function stringFamily(pattern: string): { prefix: string; suffix: string } | undefined {
  const chars = [...pattern];
  // Literal characters as strings; undefined for one `.*` or `.+`.
  const tokens: (string | undefined)[] = [];
  let start = false;
  let end = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] ?? "";
    const next = chars[i + 1] ?? "";
    if (end) return undefined;
    if (c === "^" && i === 0) start = true;
    else if (c === "$") end = true;
    else if (c === "\\" && next !== "" && SYNTAX.includes(next)) {
      tokens.push(next);
      i++;
    } else if (c === "." && (next === "*" || next === "+")) {
      tokens.push(undefined);
      i++;
    } else if (isLiteral(c)) tokens.push(c);
    else return undefined;
  }
  const wild = tokens.indexOf(undefined);
  if (wild !== tokens.lastIndexOf(undefined)) return undefined;
  const literal = (part: readonly (string | undefined)[]): string => part.join("");
  let family: { prefix: string; suffix: string } | undefined;
  if (start && end) {
    // Anchored on both sides, the wildcard is the only part that varies.
    if (wild !== -1) {
      family = { prefix: literal(tokens.slice(0, wild)), suffix: literal(tokens.slice(wild + 1)) };
    }
  } else if (start) {
    // Anchored at the start only, anything may follow, so a wildcard can only come last.
    if (wild === -1 || wild === tokens.length - 1) family = { prefix: literal(tokens), suffix: "" };
  } else if (end) {
    if (wild === -1 || wild === 0) family = { prefix: "", suffix: literal(tokens) };
  }
  return family === undefined || (family.prefix === "" && family.suffix === "") ? undefined : family;
}

/** The TypeScript type of a string: a template literal type for a family, else `string`. */
function stringType(pattern: string | undefined): string {
  const family = pattern === undefined ? undefined : stringFamily(pattern);
  if (family === undefined) return "string";
  const text = (s: string): string => s.replace(/[`\\$]/g, (c) => `\\${c}`);
  return `\`${text(family.prefix)}\${string}${text(family.suffix)}\``;
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
