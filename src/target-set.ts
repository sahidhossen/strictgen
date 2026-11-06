/**
 * The targets of a config, without a file system: which emitters run, with which options, and
 * where their files go. `targets.ts` builds the settings from a loaded config; `memory.ts` builds
 * them for schemas held in memory.
 */
import type { EmittedFile } from "./common.js";
import type { GoConfig, RustConfig, Targets, TypeScriptConfig } from "./config.js";
import { emitGo, emitGoAttributes, emitGoFixtures, GO_FIXTURES } from "./emit-go.js";
import { emitRust, emitRustFixtures } from "./emit-rust.js";
import { emitRustSchemas } from "./emit-schemas.js";
import { emitTypeScript } from "./emit-ts.js";
import type { OutputFile, Target } from "./generate.js";
import type { LlmMaps } from "./llm-decoders.js";
import { llmMaps } from "./llm-decoders.js";
import { emitLlm } from "./llm-emit.js";
import type { Profile } from "./llm-profile.js";

/** The name of the Rust fixture registry, in the folder `targets.rust.fixtures.out` names. */
export const RUST_FIXTURES = "registry.rs";
/** The Rust module {@link emitRustSchemas} writes, when `targets.rust.embedSchemas` is on. */
const SCHEMAS_MODULE = "schemas";

/** The LLM output of {@link TargetSettings}, with its profiles loaded and checked. */
export interface LlmSettings {
  readonly out: string;
  readonly cleanup: boolean;
  readonly profiles: readonly Profile[];
}

/**
 * What the targets emit. Every `out` folder, `targets.rust.fixtures.out` too, is relative to the
 * output root, with `/` separators, as output paths are.
 */
export interface TargetSettings {
  readonly header: string;
  readonly targets: Targets;
  readonly llm?: LlmSettings;
}

function placed(dir: string, files: readonly EmittedFile[]): OutputFile[] {
  return files.map((f) => ({ path: `${dir}/${f.name}`, contents: f.contents }));
}

/** True when `llm.cleanup` asks for the cleanup helper in every language. */
function cleanup(settings: TargetSettings): boolean {
  return settings.llm?.cleanup === true;
}

/** The LLM decoders every language gets when `llm` lists profiles: the map shapes those profiles give. */
function llmOption(settings: TargetSettings): { llm?: LlmMaps } {
  return settings.llm === undefined ? {} : { llm: llmMaps(settings.llm.profiles) };
}

function typescriptTarget(settings: TargetSettings, ts: TypeScriptConfig): Target {
  const out = ts.out;
  return {
    name: "typescript",
    dirs: [out],
    emit: (model) =>
      placed(
        out,
        emitTypeScript(model, {
          header: settings.header,
          decoders: ts.decoders,
          read: ts.read,
          cleanup: cleanup(settings),
          ...llmOption(settings),
        }),
      ),
  };
}

function rustTarget(settings: TargetSettings, rust: RustConfig): Target {
  const { header } = settings;
  const out = rust.out;
  const fixtures = rust.fixtures;
  const fixturesOut = fixtures?.out;
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
          serdeBridge: rust.serdeBridge,
          cleanup: cleanup(settings),
          ...llmOption(settings),
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
function goTarget(settings: TargetSettings, go: GoConfig): Target {
  const out = go.out;
  const options = {
    header: settings.header,
    package: go.package,
    read: go.read,
    cleanup: cleanup(settings),
    ...llmOption(settings),
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

/** The LLM output: a folder per profile, with one provider-ready schema per type. */
function llmTarget(llm: LlmSettings): Target {
  return {
    name: "llm",
    dirs: [llm.out],
    emit: (model, schemas) => placed(llm.out, emitLlm(model, llm.profiles, schemas)),
  };
}

/** The targets the settings list, in a fixed order: TypeScript, Rust, Go, then the LLM schemas. */
export function settingsTargets(settings: TargetSettings): Target[] {
  const { rust, go, typescript } = settings.targets;
  return [
    ...(typescript === undefined ? [] : [typescriptTarget(settings, typescript)]),
    ...(rust === undefined ? [] : [rustTarget(settings, rust)]),
    ...(go === undefined ? [] : [goTarget(settings, go)]),
    ...(settings.llm === undefined ? [] : [llmTarget(settings.llm)]),
  ];
}
