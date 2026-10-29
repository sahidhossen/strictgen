import type { EmittedFile } from "./common.js";
import { bySchema, compare, declTypes, HEADER, imports } from "./common.js";
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
import { variantName } from "./naming.js";
import { CodegenError } from "./schema.js";

/** Name of the built in type for any JSON value except `null`. */
export const NON_NULL_JSON = "NonNullJson";

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
]);

const KEYWORDS = new Set(
  (
    "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut " +
    "pub ref return self static struct super trait true type unsafe use where while async await dyn " +
    "abstract become box do final gen macro override priv try typeof unsized virtual yield"
  ).split(" "),
);
/** Keywords that can't be raw identifiers. */
const NOT_RAW = new Set(["crate", "self", "super", "Self"]);

const DERIVE_DATA = "#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]";
const DERIVE_ENUM =
  "#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]";

/**
 * Lints generated code can't avoid, each with its reason. Kept short on purpose:
 * anything else clippy reports is a generator bug.
 */
const ALLOWS: readonly (readonly [string, string])[] = [
  ["clippy::doc_markdown", "descriptions come from the schemas, which name keys without backticks"],
  [
    "clippy::enum_variant_names",
    "variant names come from schema values, which often share a prefix",
  ],
  ["clippy::large_enum_variant", "variants follow the schemas, only recursive ones are boxed"],
];

/** Name of the module that holds the built in types and decoding functions. */
export const HELPERS = "helpers";

/**
 * Emits the Rust modules for the folder the Rust target owns: one module per schema,
 * named after the schema file (`user-profile` to `user_profile.rs`), a
 * `helpers` module with the built in types, and `mod.rs`, which declares them,
 * carries the clippy allows every module inherits and re-exports every type, so
 * `<crate>::Block` works whichever module holds it. `publicModules` are declared
 * `pub` and not re-exported, for modules written by another emitter, like `schemas`.
 */
export function emitRust(model: Model, publicModules: readonly string[] = []): EmittedFile[] {
  for (const decl of model.decls) {
    if (RESERVED.has(decl.name)) {
      throw new CodegenError(decl.path, `type name ${decl.name} is reserved in Rust`);
    }
  }
  const groups = bySchema(model);
  const modules = [...groups].map(([schema, decls]) => ({
    schema,
    name: moduleName(schema, decls[0]?.path ?? schema),
    decls,
  }));
  const usesPresent = model.decls.some(
    (d) => d.kind === "struct" && d.fields.some((f) => !f.required),
  );
  const usesTagged = model.decls.some((d) => d.kind === "tagged");
  const literals = new Set(model.decls.flatMap(literalKinds));
  const exported = [
    ...(literals.has("boolean") ? ["ConstBool"] : []),
    ...(literals.has("number") ? ["ConstInt"] : []),
    NON_NULL_JSON,
  ];
  const helpers = [
    `${HEADER}\n\n//! Built in types and decoding functions the generated modules share.\n`,
    "use serde::{Deserialize, Deserializer, Serialize};\n",
    NON_NULL,
    usesPresent ? PRESENT : "",
    usesTagged ? TAGGED : "",
    literals.has("number") ? CONST_INT : "",
    literals.has("boolean") ? CONST_BOOL : "",
  ].join("\n");
  const root = [
    `${HEADER}\n\n//! Types for every schema in the set.\n//!\n//! One module per schema file. Every type is re-exported here.\n`,
    ALLOWS.map(([lint, reason]) => `#![allow(${lint}, reason = "${reason}")]\n`).join(""),
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
      contents: rustModule(model, m.schema, m.decls, moduleNames(modules)),
    })),
  ];
}

function moduleNames(modules: readonly { schema: string; name: string }[]): Map<string, string> {
  return new Map(modules.map((m) => [m.schema, m.name]));
}

/** The Rust module name of a schema file, like `user-profile` to `user_profile`. */
export function moduleName(schema: string, path: string): string {
  const name = schema.replaceAll("-", "_");
  if (!/^[a-z][a-z0-9_]*$/.test(name) || KEYWORDS.has(name) || name === HELPERS || name === "mod") {
    throw new CodegenError(path, `schema file ${schema} has no Rust module name`);
  }
  return name;
}

/** One schema's module: imports from the other modules and the helpers, then its declarations. */
function rustModule(
  model: Model,
  schema: string,
  decls: readonly Decl[],
  modules: ReadonlyMap<string, string>,
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
  if (decls.some((d) => d.kind === "struct" && d.fields.some((f) => !f.required)))
    helpers.add("present");
  const tagged = decls.some((d) => d.kind === "tagged");
  const untaggedUnions = decls.some((d) => d.kind === "untagged");
  if (tagged) {
    helpers.add("tag");
    helpers.add("variant");
  }
  const usesMap =
    types.some((t) => kindsOf(t).has("map")) ||
    decls.some((d) => d.kind === "struct" && d.rest !== undefined);
  const uses = [...imports(model, decls)].map(
    ([other, names]) => `use super::${modules.get(other) ?? other}::${importList(names)};\n`,
  );
  if (helpers.size > 0)
    uses.push(`use super::${HELPERS}::${importList([...helpers].sort(compare))};\n`);
  const deserializer = tagged || untaggedUnions ? "Deserializer, " : "";
  uses.push(`use serde::{Deserialize, ${deserializer}Serialize};\n`);
  if (usesMap) uses.push("use std::collections::BTreeMap;\n");
  const parts = [
    `${HEADER}\n\n//! Types for \`${schema}.json\`.\n\n${uses.join("")}`,
    ...decls.map((decl) => declaration(model, decl)),
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

const NON_NULL = `/// Any JSON value except \`null\` at the top, like \`jsonValue\`. Nested values may be anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ${NON_NULL_JSON}(pub serde_json::Value);

impl<'de> Deserialize<'de> for ${NON_NULL_JSON} {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.is_null() {
            return Err(serde::de::Error::custom("expected a JSON value other than null"));
        }
        Ok(Self(value))
    }
}
`;

const PRESENT = `/// Decodes an optional key that is present, so an explicit \`null\` fails instead of reading as absent.
pub(super) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}
`;

const TAGGED = `/// Reads the tag of a tagged union.
pub(super) fn tag<E: serde::de::Error>(value: &serde_json::Value, key: &'static str) -> Result<String, E> {
    let serde_json::Value::Object(object) = value else {
        return Err(E::custom("expected an object"));
    };
    match object.get(key) {
        Some(serde_json::Value::String(tag)) => Ok(tag.clone()),
        Some(_) => Err(E::custom(format_args!("\`{key}\` must be a string"))),
        None => Err(E::missing_field(key)),
    }
}

/// Decodes the branch a tag picked, naming it in errors.
pub(super) fn variant<T, E>(value: serde_json::Value, key: &str, tag: &str) -> Result<T, E>
where
    T: serde::de::DeserializeOwned,
    E: serde::de::Error,
{
    serde_json::from_value(value).map_err(|error| E::custom(format_args!("{key} \`{tag}\`: {error}")))
}
`;

const CONST_INT = `/// An integer \`const\`, like \`schemaVersion\`. Decoding any other value fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ConstInt<const N: i64>;

impl<const N: i64> Serialize for ConstInt<N> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(N)
    }
}

impl<'de, const N: i64> Deserialize<'de> for ConstInt<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = i64::deserialize(deserializer)?;
        if value == N {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format_args!("expected {N}, found {value}")))
        }
    }
}
`;

const CONST_BOOL = `/// A boolean \`const\`. Decoding the other value fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ConstBool<const B: bool>;

impl<const B: bool> Serialize for ConstBool<B> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(B)
    }
}

impl<'de, const B: bool> Deserialize<'de> for ConstBool<B> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = bool::deserialize(deserializer)?;
        if value == B {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format_args!("expected {B}, found {value}")))
        }
    }
}
`;

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

function declaration(model: Model, decl: Decl): string {
  const head = docs(decl.doc === "" ? [] : decl.doc.split("\n"), "", [`Schema: \`${decl.path}\`.`]);
  switch (decl.kind) {
    case "struct":
      return head + struct(decl);
    case "enum":
      return head + enumeration(decl);
    case "tagged":
      return head + tagged(decl);
    case "untagged":
      return head + untagged(model, decl);
    case "alias":
      return `${head}pub type ${decl.name} = ${typeText(decl.type)};\n`;
    case "id":
      return `${head}${DERIVE_ENUM.replace("Copy, ", "")}\n#[serde(transparent)]\npub struct ${decl.name}(pub String);\n`;
  }
}

function struct(decl: StructDecl): string {
  const serde =
    decl.closed && decl.rest === undefined
      ? 'rename_all = "camelCase", deny_unknown_fields'
      : 'rename_all = "camelCase"';
  const seen = new Set<string>();
  const fields = decl.fields.map((f) => field(f, decl, seen));
  if (decl.rest !== undefined) {
    const rest = "rest";
    if (seen.has(rest))
      throw new CodegenError(decl.path, "a field named rest clashes with the other keys");
    fields.push(
      `    /// Keys other than the named fields.\n    #[serde(flatten)]\n    pub ${rest}: BTreeMap<${typeText(decl.rest.key)}, ${typeText(decl.rest.value)}>,\n`,
    );
  }
  const body = fields.length === 0 ? "{}" : `{\n${fields.join("")}}`;
  if (decl.rest === undefined) {
    return `${DERIVE_DATA}\n#[serde(${serde})]\npub struct ${decl.name} ${body}\n`;
  }
  const derive = DERIVE_DATA.replace("Serialize, ", "");
  return `${derive}\n#[serde(${serde})]\npub struct ${decl.name} ${body}\n\n${restSerialize(decl, seen)}`;
}

/**
 * Serializes a struct with named fields and a map of the other keys. Fails when
 * the map holds a named field's key, so a key like \`default\` is never written twice.
 */
function restSerialize(decl: StructDecl, idents: ReadonlySet<string>): string {
  const names = [...idents];
  const entries = decl.fields.map((f, i) => {
    const ident = names[i] ?? "";
    const key = JSON.stringify(f.name);
    return f.required
      ? `        map.serialize_entry(${key}, &self.${ident})?;\n`
      : `        if let Some(value) = &self.${ident} {\n            map.serialize_entry(${key}, value)?;\n        }\n`;
  });
  const named = decl.fields.map((f) => JSON.stringify(f.name)).join(", ");
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

function field(f: Field, decl: StructDecl, seen: Set<string>): string {
  const ident = fieldIdent(f.name, decl.path);
  if (seen.has(ident)) throw new CodegenError(decl.path, `two keys map to the Rust field ${ident}`);
  seen.add(ident);
  const attrs: string[] = [];
  if (serdeCamel(ident) !== f.name) attrs.push(`rename = ${JSON.stringify(f.name)}`);
  let type = typeText(f.type);
  if (f.boxed) type = `Box<${type}>`;
  if (!f.required) {
    attrs.push('default, deserialize_with = "present", skip_serializing_if = "Option::is_none"');
    type = `Option<${type}>`;
  }
  const attr = attrs.length === 0 ? "" : `    #[serde(${attrs.join(", ")})]\n`;
  const text = f.doc === "" ? [`The \`${f.name}\` key.`] : f.doc.split("\n");
  return `${docs(text, "    ", [])}${attr}    pub ${ident}: ${type},\n`;
}

function enumeration(decl: EnumDecl): string {
  const seen = new Set<string>();
  const variants = decl.values.map((value) => {
    const name = unique(variantName(value), seen, decl.path);
    return `    /// \`${value}\`\n    #[serde(rename = ${JSON.stringify(value)})]\n    ${name},\n`;
  });
  return `${DERIVE_ENUM}\npub enum ${decl.name} {\n${variants.join("")}}\n`;
}

function tagged(decl: TaggedDecl): string {
  const seen = new Set<string>();
  const variants = decl.variants.map((v) => ({
    ...v,
    name: unique(variantName(v.value), seen, decl.path),
  }));
  const lines = variants.map(
    (v) =>
      `    /// The \`${v.value}\` branch.\n    ${v.name}(${v.boxed ? `Box<${v.type}>` : v.type}),\n`,
  );
  const tag = JSON.stringify(decl.tag);
  const arms = variants.map(
    (v) =>
      `            ${JSON.stringify(v.value)} => variant(value, ${tag}, ${JSON.stringify(v.value)}).map(Self::${v.name}),\n`,
  );
  const names = variants.map((v) => JSON.stringify(v.value)).join(", ");
  return (
    `#[derive(Debug, Clone, PartialEq, Eq, Serialize)]\n#[serde(untagged)]\npub enum ${decl.name} {\n${lines.join("")}}\n\n` +
    `impl<'de> Deserialize<'de> for ${decl.name} {\n` +
    `    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {\n` +
    `        let value = serde_json::Value::deserialize(deserializer)?;\n` +
    `        match tag::<D::Error>(&value, ${tag})?.as_str() {\n${arms.join("")}` +
    `            other => Err(serde::de::Error::unknown_variant(other, &[${names}])),\n` +
    `        }\n    }\n}\n`
  );
}

/**
 * An untagged union decodes by the JSON kind of the value first, then tries the variants that
 * take that kind, in order. serde's own untagged decoding would let a struct variant read a JSON
 * array as its fields in order, so a one entry list like `["ast_…"]` would decode as a binding.
 */
function untagged(model: Model, decl: UntaggedDecl): string {
  const seen = new Set<string>();
  const variants = decl.variants.map((v) => {
    const name = unique(v.name, seen, decl.path);
    const type = v.boxed ? `Box<${typeText(v.type)}>` : typeText(v.type);
    return { name, type, text: typeText(v.type), kinds: jsonKinds(model, v.type) };
  });
  const lines = variants.map((v) => `    /// A \`${v.text}\`.\n    ${v.name}(${v.type}),\n`);
  const tries = variants.map((v) => {
    const checks = [...v.kinds].sort(compare).map((kind) => `value.is_${kind}()`);
    const decode = `let Ok(inner) = <${v.type}>::deserialize(&value)`;
    const condition = v.kinds.has("any")
      ? decode
      : `${checks.length === 1 ? (checks[0] ?? "") : `(${checks.join(" || ")})`}\n            && ${decode}\n       `;
    return `        if ${condition} {\n            return Ok(Self::${v.name}(inner));\n        }\n`;
  });
  return (
    `${DERIVE_DATA.replace(", Deserialize", "")}\n#[serde(untagged)]\npub enum ${decl.name} {\n${lines.join("")}}\n\n` +
    `impl<'de> Deserialize<'de> for ${decl.name} {\n` +
    `    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {\n` +
    `        let value = serde_json::Value::deserialize(deserializer)?;\n${tries.join("")}` +
    `        Err(serde::de::Error::custom(\n            "data did not match any variant of untagged enum ${decl.name}",\n        ))\n` +
    `    }\n}\n`
  );
}

/** The JSON kinds a type decodes from, as `serde_json::Value`'s `is_` names, or `any`. */
function jsonKinds(model: Model, type: TypeExpr, depth = 0): Set<string> {
  switch (type.kind) {
    case "string":
      return new Set(["string"]);
    case "integer":
    case "number":
      return new Set(["number"]);
    case "boolean":
      return new Set(["boolean"]);
    case "literal":
      return new Set([typeof type.value === "boolean" ? "boolean" : "number"]);
    case "array":
      return new Set(["array"]);
    case "map":
      return new Set(["object"]);
    case "any":
    case "nonNull":
      return new Set(["any"]);
    case "ref": {
      // The builder resolves every ref and rejects alias cycles, so neither throw is reachable
      // from schemas; failing beats dropping the kind check for a variant.
      const decl = model.decls.find((d) => d.name === type.name);
      if (decl === undefined) throw new CodegenError(type.name, "a union variant names no type");
      if (depth > model.decls.length)
        throw new CodegenError(type.name, "a union variant's kinds don't resolve");
      switch (decl.kind) {
        case "struct":
        case "tagged":
          return new Set(["object"]);
        case "enum":
        case "id":
          return new Set(["string"]);
        case "alias":
          return jsonKinds(model, decl.type, depth + 1);
        case "untagged":
          return new Set(decl.variants.flatMap((v) => [...jsonKinds(model, v.type, depth + 1)]));
      }
    }
  }
}

function unique(name: string, seen: Set<string>, path: string): string {
  if (seen.has(name)) throw new CodegenError(path, `two variants map to the Rust name ${name}`);
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

/** A snake_case Rust field name for a JSON key, like `visibleIf` to `visible_if` and `$bind` to `bind`. */
export function fieldIdent(key: string, path: string): string {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (snake === "" || /^[0-9]/.test(snake))
    throw new CodegenError(path, `key ${key} has no Rust field name`);
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
 * types of the crate called `crate`, like `my_types`.
 */
export function emitRustFixtures(model: Model, crate: string): string {
  const arms = model.decls
    .filter((d) => d.source !== undefined)
    .map((d) => ({ decl: d, schema: d.source?.schema ?? "", def: d.source?.def }))
    .sort((a, b) => compare(`${a.schema}#${a.def ?? ""}`, `${b.schema}#${b.def ?? ""}`))
    .map(({ decl, schema, def }) => {
      const pattern = `(${JSON.stringify(schema)}, ${def === undefined ? "None" : `Some(${JSON.stringify(def)})`})`;
      return `        ${pattern} => run::<${crate}::${decl.name}>(json),\n`;
    });
  return `${HEADER}

//! Maps each fixture folder to the type generated for it, for the fixture tests.

use serde_json::Value;

/// Decodes \`json\` as the type generated for \`schema\` and \`def\` (\`None\` for the root), then
/// encodes it again. Returns \`None\` when no type is generated for that pair.
#[allow(clippy::too_many_lines, reason = "one arm per generated def")]
pub fn round_trip(schema: &str, def: Option<&str>, json: &str) -> Option<Result<Value, String>> {
    let result = match (schema, def) {
${arms.join("")}        _ => return None,
    };
    Some(result)
}

fn run<T>(json: &str) -> Result<Value, String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let decoded: T = serde_json::from_str(json).map_err(|error| error.to_string())?;
    serde_json::to_value(decoded).map_err(|error| error.to_string())
}
`;
}

/**
 * Emits `roots.rs`, declared as `pub mod roots`: decodes JSON strictly by schema name into the
 * root type generated for that schema, for the conformance runner's `json.decode`.
 */
export function emitRustRoots(model: Model): EmittedFile {
  const arms = model.decls
    .filter((d) => d.source !== undefined && d.source.def === undefined)
    .sort((a, b) => compare(a.source?.schema ?? "", b.source?.schema ?? ""))
    .map(
      (d) =>
        `        ${JSON.stringify(d.source?.schema ?? "")} => run::<crate::${d.name}>(bytes),\n`,
    );
  return {
    name: "roots.rs",
    contents: `${HEADER}

//! Decodes JSON by schema name, into the root type generated for that schema.

use serde_json::Value;

use crate::json::DecodeError;

/// Decodes \`bytes\` strictly (\`crate::json::decode\`) as the root type generated for \`schema\`,
/// like \`site\`, then encodes it again. Returns \`None\` for a schema with no root type, like a
/// definitions-only schema.
#[must_use]
pub fn decode(schema: &str, bytes: &[u8]) -> Option<Result<Value, DecodeError>> {
    Some(match schema {
${arms.join("")}        _ => return None,
    })
}

fn run<T>(bytes: &[u8]) -> Result<Value, DecodeError>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let decoded: T = crate::json::decode(bytes)?;
    Ok(serde_json::to_value(decoded)?)
}
`,
  };
}

/** Rustdoc lines, with `extra` lines after a blank line. */
function docs(lines: readonly string[], indent: string, extra: readonly string[]): string {
  const all =
    lines.length > 0 && extra.length > 0 ? [...lines, "", ...extra] : [...lines, ...extra];
  return all.map((line) => `${indent}///${line === "" ? "" : ` ${line}`}\n`).join("");
}
