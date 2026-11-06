/**
 * The LLM output: one provider-ready schema per type and profile, written to `llm.out`, and the
 * `strictgen llm` command, which prints one of them.
 */
import { basename } from "node:path";

import { buildModel } from "./build.js";
import type { Config, LlmConfig } from "./config.js";
import type { Profile } from "./llm-profile.js";
import { configProfiles, namedProfile } from "./llm-profile.js";
import type { Projection } from "./llm-project.js";
import { projectedTypes, projectType, schemaText } from "./llm-project.js";
import type { EmittedFile } from "./common.js";
import type { Model } from "./model.js";
import { CodegenError, loadSchemas } from "./schema.js";

/**
 * A request `strictgen llm` can't answer: a type the schemas don't define. The CLI exits 2 for
 * it.
 */
export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * The files of the LLM output, relative to `llm.out`: `<profile>/<Type>.json` for every schema
 * root and `$defs` entry. Throws a {@link CodegenError} when a type can't be projected for a
 * profile, or two type names differ only in case, which would be one file on some systems.
 */
export function emitLlm(model: Model, profiles: readonly Profile[]): EmittedFile[] {
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
      contents: schemaText(projectType(model, decl.name, profile).schema),
    })),
  );
}

/** The profiles `llm` lists, loaded and checked. */
export function llmProfiles(config: Config, llm: LlmConfig): Profile[] {
  return configProfiles(llm.profiles, basename(config.file));
}

/** The model of a config's schemas, as every target sees it. */
export function configModel(config: Config): Model {
  const schemas = loadSchemas(config.schemas, config.idBase === undefined ? {} : { idBase: config.idBase });
  return buildModel(schemas, {
    ...(config.ids === undefined ? {} : { ids: config.ids }),
    validation: config.validation,
  });
}

/**
 * The projection `strictgen llm --profile <profile> <type>` prints. `type` is a type name, like
 * `Order`, of a schema root or a `$defs` entry. `path` resolves a profile path given on the
 * command line.
 */
export function llmProjection(
  config: Config,
  profileName: string,
  type: string,
  path: (p: string) => string,
): Projection {
  const profile = namedProfile(config, profileName, path);
  const model = configModel(config);
  const types = projectedTypes(model).map((d) => d.name);
  if (!types.includes(type)) {
    const some = types.slice(0, 8).join(", ");
    throw new LlmError(
      `no type ${JSON.stringify(type)} in the schemas. Give the name of a schema root or $defs ` +
        `entry as the generated code names it, like ${some}${types.length > 8 ? ", ..." : ""}`,
    );
  }
  return projectType(model, type, profile);
}
