import type { EmittedFile } from "./common.js";
import { bySchema, commentHeader, DEFAULT_HEADER, declTypes, imports } from "./common.js";
import { CodegenError } from "./schema.js";
import type { Decl, Model, StructDecl, TypeExpr } from "./model.js";
import { RENAME_TYPE, TS_RESERVED } from "./naming.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WIDTH = 100;

/** Global types the generated TypeScript names. A schema type named like one would shadow it. */
const RESERVED = new Set(["Record", "Partial", "NonNullable"]);

/** Options for {@link emitTypeScript}. */
export interface TypeScriptOptions {
  /** The header text each file starts with, as a comment. */
  readonly header?: string;
  /** Modules written by another emitter whose values `index.ts` re-exports. */
  readonly valueModules?: readonly string[];
}

/**
 * Emits the TypeScript files for the folder the TypeScript target owns: one file per
 * schema, named after the schema file, importing the types it uses from the
 * others, and `index.ts`, which re-exports every type, and the values of `valueModules`.
 */
export function emitTypeScript(model: Model, options: TypeScriptOptions = {}): EmittedFile[] {
  const header = commentHeader(options.header ?? DEFAULT_HEADER);
  const valueModules = options.valueModules ?? [];
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
    if (schema === "index")
      throw new CodegenError(
        own[0]?.path ?? schema,
        "reserved-name",
        "a schema named index clashes with index.ts",
        "rename the schema file",
      );
    const uses = [...imports(model, own, tsTypes)].map(
      ([other, names]) => `import type { ${names.join(", ")} } from "./${other}.js";\n`,
    );
    const body = own.map((decl) => declaration(decl, decls)).join("\n");
    const head = `${header}\n\n/** Types for \`${schema}.json\`. */\n\n`;
    return {
      name: `${schema}.ts`,
      contents: `${head}${uses.length > 0 ? `${uses.join("")}\n` : ""}${body}`,
    };
  });
  const index = [
    ...files.map((f) => `export type * from "./${f.name.replace(/\.ts$/, ".js")}";\n`),
    ...valueModules.map((m) => `export * from "./${m}.js";\n`),
  ];
  return [...files, { name: "index.ts", contents: `${header}\n\n${index.join("")}` }];
}

/** The types the TypeScript output names: a rest map's keys are typed as `string` by the index signature. */
function tsTypes(decl: Decl): TypeExpr[] {
  if (decl.kind !== "struct" || decl.rest === undefined) return declTypes(decl);
  return [...decl.fields.map((f) => f.type), decl.rest.value];
}

function declaration(decl: Decl, decls: ReadonlyMap<string, Decl>): string {
  const head = doc(decl.doc, "");
  switch (decl.kind) {
    case "struct":
      return head + struct(decl, decls);
    case "enum":
      return (
        head +
        union(
          decl.name,
          decl.values.map((v) => JSON.stringify(v)),
        )
      );
    case "tagged":
      return (
        head +
        union(
          decl.name,
          decl.variants.map((v) => v.type),
        )
      );
    case "untagged":
      return (
        head +
        union(
          decl.name,
          decl.variants.map((v) => typeText(v.type, decls)),
        )
      );
    case "alias":
      return `${head}export type ${decl.name} = ${typeText(decl.type, decls)};\n`;
    case "id":
      return `${head}export type ${decl.name} = string;\n`;
  }
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
