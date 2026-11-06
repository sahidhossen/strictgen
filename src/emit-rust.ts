import type { EmittedFile } from "./common.js";
import { bySchema, commentHeader, compare, declTypes, DEFAULT_HEADER, imports } from "./common.js";
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
import {
  RENAME_TYPE,
  RUST_CRATE_ROOTS,
  RUST_KEYWORDS as KEYWORDS,
  RUST_NOT_RAW as NOT_RAW,
  variantName,
} from "./naming.js";
import {
  RUST_HELPERS_ATTEMPT,
  RUST_HELPERS_CONST_BOOL,
  RUST_HELPERS_CONST_INT,
  RUST_HELPERS_ENUM,
  RUST_HELPERS_ONE_OF,
  RUST_HELPERS_REST,
  RUST_HELPERS_TAGGED,
  RUST_NON_NULL,
  rustHelpersCore,
  rustHelpersObject,
} from "./rust-helpers.js";
import type { ReadMode } from "./config.js";
import { CodegenError } from "./schema.js";

/** Name of the built in type for any JSON value except `null`. */
export const NON_NULL_JSON = RUST_NON_NULL;

/** Names the generated module uses itself. A schema type with one of these names fails. */
const RESERVED = new Set([
  "Option",
  "Result",
  "Vec",
  "Box",
  "String",
  "BTreeMap",
  "Value",
  "Number",
  "Serialize",
  "Serializer",
  "Deserialize",
  "Deserializer",
  NON_NULL_JSON,
  "ConstInt",
  "ConstBool",
  "Decode",
  "DecodeError",
  // Report mode's, reserved in strict mode too, so switching the mode never makes a schema fail.
  "Reported",
]);

const DERIVE_DATA = "#[derive(Debug, Clone, PartialEq, Eq, Serialize)]";
/** Enums order by their JSON value, so they implement `Ord` and `PartialOrd` by hand. */
const DERIVE_ENUM = "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]";
const DERIVE_ID = "#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]";

/** The first line of every generated `Decode` impl's method. */
const DECODE_FN =
  "    fn decode_node(node: &helpers::Node<'_>) -> Result<Self, helpers::DecodeError> {\n";

/** An impl of `Decode` for `name` whose method body is `body`, indented by eight spaces. */
function decodeImpl(name: string, body: string): string {
  return `impl ${HELPERS}::Decode for ${name} {\n${DECODE_FN}${body}    }\n}\n`;
}

/** A lint the generated `mod.rs` allows for every module, and why. */
export interface LintAllow {
  /** The lint, like `clippy::doc_markdown`. */
  readonly lint: string;
  /** Why generated code can't avoid it. */
  readonly reason: string;
}

/**
 * Lints generated code can't avoid, each with its reason. Kept short on purpose:
 * anything else clippy reports is a generator bug.
 */
export const DEFAULT_ALLOW: readonly LintAllow[] = [
  {
    lint: "clippy::doc_markdown",
    reason: "descriptions come from the schemas, which name keys without backticks",
  },
  {
    lint: "clippy::enum_variant_names",
    reason: "variant names come from schema values, which often share a prefix",
  },
  {
    lint: "clippy::large_enum_variant",
    reason: "variants follow the schemas, only recursive ones are boxed",
  },
];

/** Options for {@link emitRust}. */
export interface RustOptions {
  /** The header text each file starts with, as a comment. */
  readonly header?: string;
  /** The lints `mod.rs` allows. Defaults to {@link DEFAULT_ALLOW}. */
  readonly allow?: readonly LintAllow[];
  /** Modules written by another emitter, like `schemas`, declared `pub` and not re-exported. */
  readonly publicModules?: readonly string[];
  /**
   * How decoders treat unknown keys: `strict` fails on them, `report` accepts them, reports
   * their paths and adds `Decode::report_from_json`. Defaults to `strict`.
   */
  readonly read?: ReadMode;
}

/**
 * A Rust string literal: `text` with backslashes and quotes escaped, and control characters,
 * U+2028 and U+2029 as `\u{...}` escapes, so any JSON key or value can be written.
 */
export function rustString(text: string): string {
  let out = '"';
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if (c === "\\" || c === '"') out += `\\${c}`;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029)
      out += `\\u{${code.toString(16)}}`;
    else out += c;
  }
  return `${out}"`;
}

/** Name of the module that holds the built in types and decoding functions. */
export const HELPERS = "helpers";

/**
 * Emits the Rust modules for the folder the Rust target owns: one module per schema,
 * named after the schema file (`user-profile` to `user_profile.rs`), a
 * `helpers` module with the built in types, and `mod.rs`, which declares them,
 * carries the clippy allows every module inherits and re-exports every type, so
 * `<crate>::Order` works whichever module holds it. `publicModules` are declared
 * `pub` and not re-exported, for modules written by another emitter, like `schemas`.
 */
export function emitRust(model: Model, options: RustOptions = {}): EmittedFile[] {
  const header = commentHeader(options.header ?? DEFAULT_HEADER);
  const publicModules = options.publicModules ?? [];
  const report = options.read === "report";
  for (const decl of model.decls) {
    if (RESERVED.has(decl.name) || KEYWORDS.has(decl.name)) {
      throw new CodegenError(
        decl.path,
        "reserved-name",
        `type name ${decl.name} is reserved in Rust`,
        RENAME_TYPE,
      );
    }
  }
  const groups = bySchema(model);
  const modules = [...groups].map(([schema, decls]) => ({
    schema,
    name: moduleName(schema, decls[0]?.path ?? schema),
    decls,
  }));
  for (const m of modules) {
    if (publicModules.includes(m.name)) {
      throw new CodegenError(
        m.decls[0]?.path ?? m.schema,
        "reserved-name",
        `schema file ${m.schema} clashes with the generated ${m.name} module`,
        "rename the schema file",
      );
    }
  }
  const usesStruct = model.decls.some((d) => d.kind === "struct");
  const usesEnum = model.decls.some((d) => d.kind === "enum");
  const usesRest = model.decls.some((d) => d.kind === "struct" && d.rest !== undefined);
  const usesTagged = model.decls.some((d) => d.kind === "tagged");
  const usesUntagged = model.decls.some((d) => d.kind === "untagged");
  const literals = new Set(model.decls.flatMap(literalKinds));
  const exported = [
    ...(literals.has("boolean") ? ["ConstBool"] : []),
    ...(literals.has("number") ? ["ConstInt"] : []),
    "Decode",
    "DecodeError",
    NON_NULL_JSON,
    ...(report ? ["Reported", "clear_unknown_key_hook", "set_unknown_key_hook"] : []),
  ];
  // Only the parts some declaration uses, so the module has no dead code.
  const helpers = [
    `${header}\n\n//! Built in types and decoding functions the generated modules share.\n`,
    rustHelpersCore(report),
    usesStruct ? rustHelpersObject(report) : "",
    usesRest ? RUST_HELPERS_REST : "",
    usesEnum || usesTagged ? RUST_HELPERS_ONE_OF : "",
    usesEnum ? RUST_HELPERS_ENUM : "",
    usesTagged ? RUST_HELPERS_TAGGED : "",
    literals.has("number") ? RUST_HELPERS_CONST_INT : "",
    literals.has("boolean") ? RUST_HELPERS_CONST_BOOL : "",
    report && usesUntagged ? RUST_HELPERS_ATTEMPT : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
  const root = [
    `${header}\n\n//! Types for every schema in the set.\n//!\n//! One module per schema file. Every type is re-exported here.\n`,
    (options.allow ?? DEFAULT_ALLOW)
      .map((a) => `#![allow(${a.lint}, reason = ${rustString(a.reason)})]\n`)
      .join(""),
    "\n",
    [HELPERS, ...modules.map((m) => m.name)].map((m) => `mod ${m};\n`).join(""),
    publicModules.map((m) => `pub mod ${m};\n`).join(""),
    "\n",
    modules.map((m) => `pub use ${m.name}::*;\n`).join(""),
    `pub use ${HELPERS}::{${exported.join(", ")}};\n`,
  ].join("");
  return [
    { name: "mod.rs", contents: root },
    { name: `${HELPERS}.rs`, contents: helpers },
    ...modules.map((m) => ({
      name: `${m.name}.rs`,
      contents: rustModule(model, m.schema, m.decls, moduleNames(modules), header, report),
    })),
  ];
}

function moduleNames(modules: readonly { schema: string; name: string }[]): Map<string, string> {
  return new Map(modules.map((m) => [m.schema, m.name]));
}

/** The Rust module name of a schema file, like `user-profile` to `user_profile`. */
export function moduleName(schema: string, path: string): string {
  const name = schema.replaceAll("-", "_");
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new CodegenError(
      path,
      "unsupported-name",
      `schema file ${schema} has no Rust module name`,
      "name schema files with lowercase letters, digits and dashes, starting with a letter",
    );
  }
  if (KEYWORDS.has(name) || RUST_CRATE_ROOTS.has(name) || name === HELPERS || name === "mod") {
    throw new CodegenError(
      path,
      "reserved-name",
      `schema file ${schema} has no Rust module name: ${name} is reserved in Rust`,
      "rename the schema file",
    );
  }
  return name;
}

/** One schema's module: imports from the other modules and the helpers, then its declarations. */
function rustModule(
  model: Model,
  schema: string,
  decls: readonly Decl[],
  modules: ReadonlyMap<string, string>,
  header: string,
  report: boolean,
): string {
  const helpers = new Set<string>();
  const types = decls.flatMap(declTypes);
  for (const type of types) {
    for (const kind of kindsOf(type)) {
      if (kind === "nonNull") helpers.add(NON_NULL_JSON);
      if (kind === "number-literal") helpers.add("ConstInt");
      if (kind === "boolean-literal") helpers.add("ConstBool");
    }
  }
  // Every declaration but an alias implements Decode through the helpers module.
  const decodes = decls.some((d) => d.kind !== "alias");
  const usesMap =
    types.some((t) => kindsOf(t).has("map")) ||
    decls.some((d) => d.kind === "struct" && d.rest !== undefined);
  const uses = [...imports(model, decls)].map(
    ([other, names]) => `use super::${modules.get(other) ?? other}::${importList(names)};\n`,
  );
  const fromHelpers = [...(decodes ? ["self"] : []), ...[...helpers].sort(compare)];
  if (fromHelpers.length === 1 && fromHelpers[0] === "self") uses.push(`use super::${HELPERS};\n`);
  else if (fromHelpers.length > 0)
    uses.push(`use super::${HELPERS}::${importList(fromHelpers)};\n`);
  if (decodes) uses.push("use serde::Serialize;\n");
  if (usesMap) uses.push("use std::collections::BTreeMap;\n");
  const parts = [
    `${header}\n\n//! Types for \`${schema}.json\`.\n\n${uses.join("")}`,
    ...decls.map((decl) => declaration(decl, report)),
  ];
  return parts.join("\n");
}

function importList(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? "") : `{${names.join(", ")}}`;
}

/** The kinds a type is built from, with literals split by value type. */
function kindsOf(type: TypeExpr): Set<string> {
  const out = new Set<string>();
  const walk = (t: TypeExpr): void => {
    out.add(t.kind === "literal" ? `${typeof t.value}-literal` : t.kind);
    if (t.kind === "array") walk(t.items);
    if (t.kind === "map") {
      walk(t.key);
      walk(t.value);
    }
  };
  walk(type);
  return out;
}

/** The kinds of literal (`number` or `boolean`) a declaration uses. */
function literalKinds(decl: Decl): string[] {
  const of = (type: TypeExpr): string[] => {
    switch (type.kind) {
      case "literal":
        return [typeof type.value];
      case "array":
        return of(type.items);
      case "map":
        return [...of(type.key), ...of(type.value)];
      default:
        return [];
    }
  };
  return declTypes(decl).flatMap(of);
}

function declaration(decl: Decl, report: boolean): string {
  const head = docs(decl.doc === "" ? [] : decl.doc.split("\n"), "", [`Schema: \`${decl.path}\`.`]);
  switch (decl.kind) {
    case "struct":
      return head + struct(decl, report);
    case "enum":
      return head + enumeration(decl);
    case "tagged":
      return head + tagged(decl);
    case "untagged":
      return head + untagged(decl, report);
    case "alias":
      return `${head}pub type ${decl.name} = ${typeText(decl.type)};\n`;
    case "id":
      return (
        `${head}${DERIVE_ID}\n#[serde(transparent)]\npub struct ${decl.name}(pub String);\n\n` +
        decodeImpl(decl.name, `        <String as ${HELPERS}::Decode>::decode_node(node).map(Self)\n`)
      );
  }
}

/**
 * A struct, and its `Decode` impl, which reads the keys in schema order, then the keys of the
 * rest map, and fails on the first key it didn't read. A struct with a rest map serializes by
 * hand, so its fields carry no serde attributes.
 */
function struct(decl: StructDecl, report: boolean): string {
  const derived = decl.rest === undefined;
  const seen = new Set<string>();
  const fields = decl.fields.map((f) => field(f, decl, seen, derived));
  const idents = [...seen];
  const reads = decl.fields.map(
    (f, i) =>
      `            ${idents[i] ?? ""}: object.${f.required ? "required" : "optional"}(${rustString(f.name)})?,\n`,
  );
  if (decl.rest !== undefined) {
    const rest = "rest";
    if (seen.has(rest))
      throw new CodegenError(
        decl.path,
        "reserved-name",
        "a field named rest clashes with the other keys",
        "rename the rest key",
      );
    fields.push(
      `    /// Keys other than the named fields.\n    pub ${rest}: BTreeMap<${typeText(decl.rest.key)}, ${typeText(decl.rest.value)}>,\n`,
    );
    reads.push(`            ${rest}: object.rest()?,\n`);
  }
  const body = fields.length === 0 ? "{}" : `{\n${fields.join("")}}`;
  // In report mode, finish notes unknown keys, and fails on those a sibling branch names.
  const finish = report
    ? `object.finish(&[${decl.forbidden.map(rustString).join(", ")}])?`
    : "object.finish()?";
  const decode = decodeImpl(
    decl.name,
    reads.length === 0
      ? `        let object = ${HELPERS}::Object::new(node)?;\n        ${finish};\n        Ok(Self {})\n`
      : `        let mut object = ${HELPERS}::Object::new(node)?;\n        let value = Self {\n${reads.join("")}        };\n        ${finish};\n        Ok(value)\n`,
  );
  if (derived) {
    return `${DERIVE_DATA}\n#[serde(rename_all = "camelCase")]\npub struct ${decl.name} ${body}\n\n${decode}`;
  }
  const derive = DERIVE_DATA.replace(", Serialize", "");
  return `${derive}\npub struct ${decl.name} ${body}\n\n${restSerialize(decl, seen)}\n${decode}`;
}

/**
 * Serializes a struct with named fields and a map of the other keys. Fails when
 * the map holds a named field's key, so a key like \`default\` is never written twice.
 */
function restSerialize(decl: StructDecl, idents: ReadonlySet<string>): string {
  const names = [...idents];
  const entries = decl.fields.map((f, i) => {
    const ident = names[i] ?? "";
    const key = rustString(f.name);
    return f.required
      ? `        map.serialize_entry(${key}, &self.${ident})?;\n`
      : `        if let Some(value) = &self.${ident} {\n            map.serialize_entry(${key}, value)?;\n        }\n`;
  });
  const named = decl.fields.map((f) => rustString(f.name)).join(", ");
  return (
    `impl Serialize for ${decl.name} {\n` +
    `    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {\n` +
    `        use serde::ser::{Error, SerializeMap};\n` +
    `        let mut map = serializer.serialize_map(None)?;\n${entries.join("")}` +
    `        for (key, value) in &self.rest {\n` +
    `            if let serde_json::Value::String(name) = serde_json::to_value(key).map_err(S::Error::custom)?\n` +
    `                && [${named}].contains(&name.as_str())\n` +
    `            {\n` +
    `                return Err(S::Error::custom(format_args!("rest holds the named key \`{name}\`")));\n` +
    `            }\n` +
    `            map.serialize_entry(key, value)?;\n` +
    `        }\n` +
    `        map.end()\n    }\n}\n`
  );
}

/** One field. `serde` is false for a struct that serializes by hand, which takes no serde attributes. */
function field(f: Field, decl: StructDecl, seen: Set<string>, serde: boolean): string {
  const ident = fieldIdent(f.name, decl.path);
  if (seen.has(ident))
    throw new CodegenError(
      decl.path,
      "name-clash",
      `two keys map to the Rust field ${ident}`,
      "rename one of the keys",
    );
  seen.add(ident);
  const attrs: string[] = [];
  if (serdeCamel(ident) !== f.name) attrs.push(`rename = ${rustString(f.name)}`);
  let type = typeText(f.type);
  if (f.boxed) type = `Box<${type}>`;
  if (!f.required) {
    attrs.push('skip_serializing_if = "Option::is_none"');
    type = `Option<${type}>`;
  }
  const attr = !serde || attrs.length === 0 ? "" : `    #[serde(${attrs.join(", ")})]\n`;
  const text = f.doc === "" ? [`The \`${f.name}\` key.`] : f.doc.split("\n");
  return `${docs(text, "    ", [])}${attr}    pub ${ident}: ${type},\n`;
}

/**
 * An enum of strings, ordered by its JSON value rather than by variant, so a map keyed by it
 * encodes its keys in code point order, as Go and TypeScript do.
 */
function enumeration(decl: EnumDecl): string {
  const seen = new Set<string>();
  const variants = decl.values.map((value) => ({
    value,
    name: unique(variantName(value), seen, decl.path),
  }));
  const lines = variants.map(
    (v) => `    /// \`${v.value}\`\n    #[serde(rename = ${rustString(v.value)})]\n    ${v.name},\n`,
  );
  const texts = variants.map((v) => `            Self::${v.name} => ${rustString(v.value)},\n`);
  const arms = variants.map((v) => `            ${rustString(v.value)} => Ok(Self::${v.name}),\n`);
  const values = variants.map((v) => rustString(v.value)).join(", ");
  return (
    `${DERIVE_ENUM}\npub enum ${decl.name} {\n${lines.join("")}}\n\n` +
    `impl ${decl.name} {\n` +
    `    /// The value as it is in JSON.\n` +
    `    #[must_use]\n` +
    `    pub const fn as_str(self) -> &'static str {\n` +
    `        match self {\n${texts.join("")}        }\n    }\n}\n\n` +
    `/// Orders by the JSON value, by code point, so a map keyed by the enum encodes its keys in\n` +
    `/// the order Go and TypeScript write them.\n` +
    `impl Ord for ${decl.name} {\n` +
    `    fn cmp(&self, other: &Self) -> std::cmp::Ordering {\n` +
    `        self.as_str().cmp(other.as_str())\n    }\n}\n\n` +
    `impl PartialOrd for ${decl.name} {\n` +
    `    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {\n` +
    `        Some(self.cmp(other))\n    }\n}\n\n` +
    decodeImpl(
      decl.name,
      `        match ${HELPERS}::string(node)? {\n${arms.join("")}` +
        `            other => Err(${HELPERS}::not_in_enum(other, &[${values}])),\n        }\n`,
    )
  );
}

/** A tagged union, which reads the tag and decodes only the branch it names. */
function tagged(decl: TaggedDecl): string {
  const seen = new Set<string>();
  const variants = decl.variants.map((v) => ({
    ...v,
    name: unique(variantName(v.value), seen, decl.path),
    text: v.boxed ? `Box<${v.type}>` : v.type,
  }));
  const lines = variants.map(
    (v) => `    /// The \`${v.value}\` branch.\n    ${v.name}(${v.text}),\n`,
  );
  const tag = rustString(decl.tag);
  const arms = variants.map(
    (v) =>
      `            ${rustString(v.value)} => <${v.text} as ${HELPERS}::Decode>::decode_node(node).map(Self::${v.name}),\n`,
  );
  const tags = variants.map((v) => rustString(v.value)).join(", ");
  return (
    `${DERIVE_DATA}\n#[serde(untagged)]\npub enum ${decl.name} {\n${lines.join("")}}\n\n` +
    decodeImpl(
      decl.name,
      `        match ${HELPERS}::tag(node, ${tag})? {\n${arms.join("")}` +
        `            other => Err(${HELPERS}::bad_tag(${tag}, other, &[${tags}])),\n        }\n`,
    )
  );
}

/**
 * An untagged union, which tries the variants in order and keeps the first that decodes, like
 * Go and TypeScript. When none does, it fails naming the union. In report mode each variant runs
 * through `attempt`, which drops the unknown keys of one that fails.
 */
function untagged(decl: UntaggedDecl, report: boolean): string {
  const seen = new Set<string>();
  const variants = decl.variants.map((v) => {
    const name = unique(v.name, seen, decl.path);
    const type = v.boxed ? `Box<${typeText(v.type)}>` : typeText(v.type);
    return { name, type, text: typeText(v.type) };
  });
  const lines = variants.map((v) => `    /// A \`${v.text}\`.\n    ${v.name}(${v.type}),\n`);
  const tries = variants.map((v) => {
    const decode = `<${v.type} as ${HELPERS}::Decode>::decode_node(node)`;
    const run = report ? `${HELPERS}::attempt(|| ${decode})` : decode;
    return (
      `        if let Ok(value) = ${run} {\n` +
      `            return Ok(Self::${v.name}(value));\n        }\n`
    );
  });
  return (
    `${DERIVE_DATA}\n#[serde(untagged)]\npub enum ${decl.name} {\n${lines.join("")}}\n\n` +
    decodeImpl(
      decl.name,
      `${tries.join("")}        Err(${HELPERS}::mismatch(${rustString(decl.name)}, node))\n`,
    )
  );
}

function unique(name: string, seen: Set<string>, path: string): string {
  if (seen.has(name))
    throw new CodegenError(
      path,
      "name-clash",
      `two variants map to the Rust name ${name}`,
      "change one of the values so their names differ",
    );
  seen.add(name);
  return name;
}

function typeText(type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "string":
      return "String";
    case "integer":
      return "i64";
    case "literal":
      if (typeof type.value === "boolean") return `ConstBool<${String(type.value)}>`;
      return type.value < 0
        ? `ConstInt<{ ${String(type.value)} }>`
        : `ConstInt<${String(type.value)}>`;
    case "number":
      // Keeps the JSON spelling, so 12 re-encodes as 12, not 12.0, like Go and TypeScript.
      return "serde_json::Number";
    case "boolean":
      return "bool";
    case "any":
      return "serde_json::Value";
    case "nonNull":
      return NON_NULL_JSON;
    case "array":
      return `Vec<${typeText(type.items)}>`;
    case "map":
      return `BTreeMap<${typeText(type.key)}, ${typeText(type.value)}>`;
  }
}

/** A snake_case Rust field name for a JSON key, like `shippedAt` to `shipped_at` and `$account` to `account`. */
export function fieldIdent(key: string, path: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (snake === "" || /^[0-9]/.test(snake))
    throw new CodegenError(
      path,
      "unsupported-name",
      `key ${key} has no Rust field name`,
      "start the key with a letter",
    );
  if (NOT_RAW.has(snake)) return `${snake}_`;
  return KEYWORDS.has(snake) ? `r#${snake}` : snake;
}

/** What serde's `rename_all = "camelCase"` makes of a field name. */
export function serdeCamel(ident: string): string {
  const name = ident.startsWith("r#") ? ident.slice(2) : ident;
  let out = "";
  let upper = false;
  for (const ch of name) {
    if (ch === "_") {
      upper = true;
    } else {
      out += upper ? ch.toUpperCase() : ch;
      upper = false;
    }
  }
  return out;
}

/**
 * The fixture registry, a Rust test file: one arm per schema root and def, decoding into the
 * types reached by the Rust path `crate`, like `my_types` or `my_types::generated`.
 */
export function emitRustFixtures(
  model: Model,
  crate: string,
  options: { readonly header?: string; readonly read?: ReadMode } = {},
): string {
  const report = options.read === "report";
  const arms = model.decls
    .filter((d) => d.source !== undefined)
    .map((d) => ({ decl: d, schema: d.source?.schema ?? "", def: d.source?.def }))
    .sort((a, b) => compare(`${a.schema}#${a.def ?? ""}`, `${b.schema}#${b.def ?? ""}`))
    .map(({ decl, schema, def }) => {
      const pattern = `(${JSON.stringify(schema)}, ${def === undefined ? "None" : `Some(${JSON.stringify(def)})`})`;
      return `        ${pattern} => run::<${crate}::${decl.name}>(json),\n`;
    });
  return `${commentHeader(options.header ?? DEFAULT_HEADER)}

//! Maps each fixture folder to the type generated for it, for the fixture tests.

use ${crate}::{Decode, DecodeError};
use serde_json::Value;

/// Why a fixture didn't round trip.
#[derive(Debug)]
pub enum Failure {
    /// It didn't decode.
    Decode(DecodeError),
    /// It decoded, then didn't encode.
    Encode(String),
}

${registryTail(report, arms.join(""))}`;
}

/** Rustdoc lines, with `extra` lines after a blank line. */
function docs(lines: readonly string[], indent: string, extra: readonly string[]): string {
  const all =
    lines.length > 0 && extra.length > 0 ? [...lines, "", ...extra] : [...lines, ...extra];
  return all.map((line) => `${indent}///${line === "" ? "" : ` ${line}`}\n`).join("");
}

/** The end of the registry: round_trip, holding the match arms, and run. */
function registryTail(report: boolean, arms: string): string {
  if (!report) {
    return `/// Decodes \`json\` as the type generated for \`schema\` and \`def\` (\`None\` for the root), then
/// encodes it again. Returns \`None\` when no type is generated for that pair.
#[allow(clippy::too_many_lines, reason = "one arm per generated def")]
pub fn round_trip(schema: &str, def: Option<&str>, json: &[u8]) -> Option<Result<Value, Failure>> {
    let result = match (schema, def) {
${arms}        _ => return None,
    };
    Some(result)
}

fn run<T: Decode + serde::Serialize>(json: &[u8]) -> Result<Value, Failure> {
    let decoded = T::from_json(json).map_err(Failure::Decode)?;
    serde_json::to_value(decoded).map_err(|error| Failure::Encode(error.to_string()))
}
`;
  }
  // In report mode, it also returns the unknown key paths.
  return `/// Decodes \`json\` as the type generated for \`schema\` and \`def\` (\`None\` for the root), then
/// encodes it again, and returns the encoding with the paths of the unknown keys. Returns
/// \`None\` when no type is generated for that pair.
#[allow(clippy::too_many_lines, reason = "one arm per generated def")]
pub fn round_trip(
    schema: &str,
    def: Option<&str>,
    json: &[u8],
) -> Option<Result<(Value, Vec<String>), Failure>> {
    let result = match (schema, def) {
${arms}        _ => return None,
    };
    Some(result)
}

fn run<T: Decode + serde::Serialize>(json: &[u8]) -> Result<(Value, Vec<String>), Failure> {
    let decoded = T::report_from_json(json).map_err(Failure::Decode)?;
    let encoded = serde_json::to_value(decoded.value).map_err(|error| Failure::Encode(error.to_string()))?;
    Ok((encoded, decoded.unknown))
}
`;
}
