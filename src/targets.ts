import { relative, sep } from "node:path";

import type { EmittedFile } from "./common.js";
import type { Config, GoConfig, LlmConfig, RustConfig, TypeScriptConfig } from "./config.js";
import { emitGo, emitGoAttributes, emitGoFixtures, GO_FIXTURES } from "./emit-go.js";
import { emitRust, emitRustFixtures } from "./emit-rust.js";
import { emitRustSchemas } from "./emit-schemas.js";
import { emitTypeScript } from "./emit-ts.js";
import { emitLlm, llmProfiles } from "./llm.js";
import type { MainOptions, OutputFile, Target } from "./main.js";

/** The name of the Rust fixture registry, in the folder `targets.rust.fixtures.out` names. */
export const RUST_FIXTURES = "registry.rs";
/** The Rust module {@link emitRustSchemas} writes, when `targets.rust.embedSchemas` is on. */
const SCHEMAS_MODULE = "schemas";

/** `path` relative to `root`, with `/` separators, as output paths are. */
function under(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join("/");
  return rel === "" ? "." : rel;
}

function placed(dir: string, files: readonly EmittedFile[]): OutputFile[] {
  return files.map((f) => ({ path: `${dir}/${f.name}`, contents: f.contents }));
}

function typescriptTarget(config: Config, ts: TypeScriptConfig): Target {
  const out = under(config.root, ts.out);
  return {
    name: "typescript",
    dirs: [out],
    emit: (model) =>
      placed(
        out,
        emitTypeScript(model, {
          header: config.header,
          decoders: ts.decoders,
          read: ts.read,
          cleanup: cleanup(config),
        }),
      ),
  };
}

function rustTarget(config: Config, rust: RustConfig): Target {
  const { header } = config;
  const out = under(config.root, rust.out);
  const fixtures = rust.fixtures;
  const fixturesOut = fixtures === undefined ? undefined : under(config.root, fixtures.out);
  return {
    name: "rust",
    dirs: fixturesOut === undefined ? [out] : [out, fixturesOut],
    emit: (model, schemas) => [
      ...placed(
        out,
        emitRust(model, {
          header,
          allow: rust.allow,
          read: rust.read,
          cleanup: cleanup(config),
          publicModules: rust.embedSchemas ? [SCHEMAS_MODULE] : [],
        }),
      ),
      ...(rust.embedSchemas ? placed(out, [emitRustSchemas(schemas, { header })]) : []),
      ...(fixtures === undefined || fixturesOut === undefined
        ? []
        : [
            {
              path: `${fixturesOut}/${RUST_FIXTURES}`,
              contents: emitRustFixtures(model, fixtures.crate, { header, read: rust.read }),
            },
          ]),
    ],
  };
}

/**
 * Go writes one package: a file per schema, `helpers.go`, the fixture registry when it is on,
 * and a `.gitattributes` that marks them. A shared folder keeps its hand written files.
 */
function goTarget(config: Config, go: GoConfig): Target {
  const out = under(config.root, go.out);
  const options = {
    header: config.header,
    package: go.package,
    read: go.read,
    cleanup: cleanup(config),
  };
  return {
    name: "go",
    dirs: go.shared ? [] : [out],
    ...(go.shared ? { shared: [out] } : {}),
    emit: (model) => {
      const files = [
        ...emitGo(model, options),
        ...(go.fixtures ? [{ name: GO_FIXTURES, contents: emitGoFixtures(model, options) }] : []),
      ];
      return [
        ...placed(out, files),
        {
          path: `${out}/.gitattributes`,
          contents: emitGoAttributes(
            files.map((f) => f.name),
            options,
          ),
        },
      ];
    },
  };
}

/** True when `llm.cleanup` asks for the cleanup helper in every language. */
function cleanup(config: Config): boolean {
  return config.llm?.cleanup === true;
}

/** The LLM output: a folder per profile, with one provider-ready schema per type. */
function llmTarget(config: Config, llm: LlmConfig): Target {
  const out = under(config.root, llm.out);
  const profiles = llmProfiles(config, llm);
  return {
    name: "llm",
    dirs: [out],
    emit: (model, schemas) => placed(out, emitLlm(model, profiles, schemas)),
  };
}

/**
 * The targets a config lists, in a fixed order: TypeScript, Rust, Go, then the LLM schemas. Their folders are
 * relative to the folder that holds the config file.
 */
export function configTargets(config: Config): Target[] {
  const { rust, go, typescript } = config.targets;
  return [
    ...(typescript === undefined ? [] : [typescriptTarget(config, typescript)]),
    ...(rust === undefined ? [] : [rustTarget(config, rust)]),
    ...(go === undefined ? [] : [goTarget(config, go)]),
    ...(config.llm === undefined ? [] : [llmTarget(config, config.llm)]),
  ];
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
