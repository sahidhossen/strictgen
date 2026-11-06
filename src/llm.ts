/**
 * The LLM output: one provider-ready schema per type and profile, written to `llm.out`, and the
 * `strictgen llm` command, which prints one of them.
 */
import { basename } from "node:path";

import type { Config, LlmConfig } from "./config.js";
import { configModel } from "./examples.js";
import type { Profile } from "./llm-profile.js";
import { configProfiles, namedProfile } from "./profile-files.js";
import type { Projection } from "./llm-project.js";
import { projectedTypes, projectType } from "./llm-project.js";

export { emitLlm } from "./llm-emit.js";

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

/** The profiles `llm` lists, loaded and checked. */
export function llmProfiles(config: Config, llm: LlmConfig): Profile[] {
  return configProfiles(llm.profiles, basename(config.file));
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
  const { schemas, model } = configModel(config);
  const types = projectedTypes(model).map((d) => d.name);
  if (!types.includes(type)) {
    const some = types.slice(0, 8).join(", ");
    throw new LlmError(
      `no type ${JSON.stringify(type)} in the schemas. Give the name of a schema root or $defs ` +
        `entry as the generated code names it, like ${some}${types.length > 8 ? ", ..." : ""}`,
    );
  }
  return projectType(model, type, profile, schemas);
}
