import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fsReason, isFsError } from "./fs-error.js";
import type { JsonObject, SchemaOptions, SchemaSet } from "./schema.js";
import { CodegenError, parseSchemaFile, schemaSet } from "./schema.js";

/** Reads every `*.json` schema in `dir`, sorted by file name. */
export function loadSchemas(dir: string, options: SchemaOptions = {}): SchemaSet {
  const files: Record<string, JsonObject> = {};
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (error) {
    if (!isFsError(error)) throw error;
    throw new CodegenError(dir, "read-failed", `can't read the schemas folder: ${fsReason(error)}`);
  }
  for (const file of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch (error) {
      if (!isFsError(error)) throw error;
      throw new CodegenError(file, "read-failed", `can't read it: ${fsReason(error)}`);
    }
    files[file.slice(0, -5)] = parseSchemaFile(file, text);
  }
  return schemaSet(files, options);
}
