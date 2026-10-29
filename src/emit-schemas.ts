import { ANNOTATIONS } from "./build.js";
import type { EmittedFile } from "./common.js";
import { commentHeader, DEFAULT_HEADER } from "./common.js";
import type { Json, SchemaSet } from "./schema.js";
import { isObject } from "./schema.js";

/** Keywords whose value is a schema. */
const SCHEMA = new Set([
  "items",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
]);

/** Keywords whose value is a list of schemas. */
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Keywords whose value maps names to schemas. */
const SCHEMA_MAP = new Set(["properties", "$defs", "patternProperties", "dependentSchemas"]);

function strip(schema: Json): Json {
  if (!isObject(schema)) return schema;
  const out: Record<string, Json> = {};
  // Object.entries lists integer-like keys first. Validation never depends on a schema's key
  // order, and the schemas' keys are camelCase words.
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA.has(key)) {
      out[key] = strip(value);
    } else if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
      out[key] = value.map(strip);
    } else if (SCHEMA_MAP.has(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, s]) => [name, strip(s)]));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A schema as minified JSON without annotations, in ASCII: every other character is a `\u`
 * escape, so the Rust source holds no invisible or bidi characters.
 */
export function minified(schema: Json): string {
  return JSON.stringify(strip(schema)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** A Rust raw string literal for `text`, with enough hashes that `text` can't end it. */
function rawString(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/"(#*)/g)].map((m) => (m[1] ?? "").length));
  const hashes = "#".repeat(longest + 1);
  return `r${hashes}"${text}"${hashes}`;
}

function entries(set: SchemaSet): string {
  return set
    .map((file) => `    (${JSON.stringify(file.name)}, ${rawString(minified(file.root))}),\n`)
    .join("");
}

/**
 * Emits `schemas.rs`, declared as `pub mod schemas`: every schema's JSON text by name, minified
 * and without annotations, so a Rust validator can load them without file access.
 */
export function emitRustSchemas(
  set: SchemaSet,
  options: { readonly header?: string } = {},
): EmittedFile {
  return {
    name: "schemas.rs",
    contents: `${commentHeader(options.header ?? DEFAULT_HEADER)}

//! The JSON Schemas of the set, minified and without annotations, for a validator.

/// Every schema's name, like \`order\`, and its JSON text, sorted by name.
pub const ALL: &[(&str, &str)] = &[
${entries(set)}];

/// The JSON text of the schema called \`name\`, like \`order\`.
#[must_use]
pub fn get(name: &str) -> Option<&'static str> {
    ALL.iter()
        .find(|(schema, _)| *schema == name)
        .map(|(_, text)| *text)
}
`,
  };
}
