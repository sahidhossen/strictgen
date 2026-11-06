import { relative, sep } from "node:path";

import type { Config, Targets } from "./config.js";
import { llmProfiles } from "./llm.js";
import type { MainOptions, Target } from "./main.js";
import type { TargetSettings } from "./target-set.js";
import { settingsTargets } from "./target-set.js";

export { RUST_FIXTURES } from "./target-set.js";

/** `path` relative to `root`, with `/` separators, as output paths are. */
function under(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/**
 * What the targets of a config emit, with every folder relative to the folder that holds the
 * config file and the LLM profiles loaded. A profile that doesn't load fails here.
 */
export function targetSettings(config: Config): TargetSettings {
  const { rust, go, typescript } = config.targets;
  const targets: Targets = {
    ...(typescript === undefined ? {} : { typescript: { ...typescript, out: under(config.root, typescript.out) } }),
    ...(rust === undefined
      ? {}
      : {
          rust: {
            ...rust,
            out: under(config.root, rust.out),
            ...(rust.fixtures === undefined
              ? {}
              : { fixtures: { ...rust.fixtures, out: under(config.root, rust.fixtures.out) } }),
          },
        }),
    ...(go === undefined ? {} : { go: { ...go, out: under(config.root, go.out) } }),
  };
  const { llm } = config;
  return {
    header: config.header,
    targets,
    ...(llm === undefined
      ? {}
      : { llm: { out: under(config.root, llm.out), cleanup: llm.cleanup, profiles: llmProfiles(config, llm) } }),
  };
}

/**
 * The targets a config lists, in a fixed order: TypeScript, Rust, Go, then the LLM schemas. Their folders are
 * relative to the folder that holds the config file.
 */
export function configTargets(config: Config): Target[] {
  return settingsTargets(targetSettings(config));
}

/** What {@link main} needs to regenerate the project a config describes. */
export function mainOptions(config: Config): MainOptions {
  return {
    schemaDir: config.schemas,
    rootDir: config.root,
    configFile: config.file,
    targets: configTargets(config),
    header: config.header,
    ...(config.idBase === undefined ? {} : { idBase: config.idBase }),
    ...(config.ids === undefined ? {} : { ids: config.ids }),
    validation: config.validation,
  };
}
