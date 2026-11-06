/** The files of the LLM output, without a file system: one provider-ready schema per type and profile. */
import type { EmittedFile } from "./common.js";
import type { Profile } from "./llm-profile.js";
import { projectedTypes, projectType, schemaText } from "./llm-project.js";
import type { Model } from "./model.js";
import type { SchemaSet } from "./schema.js";
import { CodegenError } from "./schema.js";

/**
 * The files of the LLM output, relative to `llm.out`: `<profile>/<Type>.json` for every schema
 * root and `$defs` entry. Throws a {@link CodegenError} when a type can't be projected for a
 * profile, or two type names differ only in case, which would be one file on some systems.
 * `schemas`, the set the model was built from, lets errors point at a field's own place.
 */
export function emitLlm(model: Model, profiles: readonly Profile[], schemas: SchemaSet = []): EmittedFile[] {
  const types = projectedTypes(model);
  const seen = new Map<string, string>();
  for (const decl of types) {
    const key = decl.name.toLowerCase();
    const other = seen.get(key);
    if (other !== undefined) {
      throw new CodegenError(
        decl.path,
        "name-clash",
        `type ${decl.name} and type ${other} differ only in case, so their LLM schema files would clash`,
        "rename one of them",
      );
    }
    seen.set(key, decl.name);
  }
  return profiles.flatMap((profile) =>
    types.map((decl) => ({
      name: `${profile.name}/${decl.name}.json`,
      contents: schemaText(projectType(model, decl.name, profile, schemas).schema),
    })),
  );
}
