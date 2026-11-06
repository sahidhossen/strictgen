export type { BuildOptions, IdRule } from "./build.js";
export { buildModel, isIdDef } from "./build.js";
export type { Difference, DifferenceKind } from "./check.js";
export { differences } from "./check.js";
export type { EmittedFile } from "./common.js";
export { commentHeader, DEFAULT_HEADER, HEADER } from "./common.js";
export type {
  Config,
  ConfigFolder,
  DocsConfig,
  DocsFormat,
  FormatConfig,
  GoConfig,
  LlmConfig,
  LlmProfileRef,
  ReadMode,
  RustConfig,
  RustFixtures,
  Targets,
  TypeScriptConfig,
} from "./config.js";
export {
  CONFIG_FILE,
  ConfigError,
  configFolders,
  DOCS_FORMATS,
  loadConfig,
  parseConfig,
} from "./config.js";
export { DOCS_HTML, DOCS_INDEX, docsFiles, docsTarget } from "./docs.js";
export type { GoOptions } from "./emit-go.js";
export { emitGo, emitGoAttributes, emitGoFixtures, GO_FIXTURES, GO_PACKAGE } from "./emit-go.js";
export type { LintAllow, RustOptions } from "./emit-rust.js";
export { DEFAULT_ALLOW, emitRust, emitRustFixtures } from "./emit-rust.js";
export { emitRustSchemas } from "./emit-schemas.js";
export type { TypeScriptOptions } from "./emit-ts.js";
export { emitTypeScript } from "./emit-ts.js";
export type { ExamplesOptions } from "./examples.js";
export { configModel, examples, UnknownTypeError, writeDocs } from "./examples.js";
export type { Explanation, Failure, TargetExplanation } from "./explain.js";
export { explain, ExplainError, explanationLines } from "./explain.js";
export type {
  FixedFile,
  FixInput,
  FixNote,
  FixOptions,
  FixResult,
  FixRuleId,
} from "./fix.js";
export { FIX_RULES, fixSchemas, noteText } from "./fix.js";
export type { FormatOptions, Formatter } from "./format.js";
export {
  FORMAT_TIMEOUT,
  formatFiles,
  formatterFor,
  FormatterFailedError,
  FormatterMissingError,
} from "./format.js";
export { emitLlm, LlmError, llmProjection } from "./llm.js";
export type { BoundedKeyword, Profile, ProfileKeyword, ProfileLimits, ProfileSource } from "./llm-profile.js";
export {
  BUILTIN_PROFILES,
  builtinProfile,
  configProfiles,
  loadProfile,
  parseProfile,
  PROFILE_KEYWORDS,
} from "./llm-profile.js";
export type { LlmChange, LlmChangeKind, Projection } from "./llm-project.js";
export { projectedTypes, projectType, schemaText, WRAP_KEY } from "./llm-project.js";
export type { Log, MainOptions, OutputFile, Target } from "./main.js";
export {
  generate,
  generateProject,
  isGenerated,
  main,
  targetDirs,
  writeError,
  writeOutput,
} from "./main.js";
export type * from "./model.js";
export type { GeneratorOptions, NearMiss, Payload } from "./payloads.js";
export { canonical, GenerateError, inFormat, PayloadGenerator, pointer, Random } from "./payloads.js";
export type { Json, JsonObject, SchemaFile, SchemaOptions, SchemaSet } from "./schema.js";
export { CodegenError, idBaseOf, loadSchemas, schemaSet } from "./schema.js";
export type { RuleId } from "./rules.js";
export { isRuleId, RULE_IDS, RULES } from "./rules.js";
export type { Io } from "./run.js";
export { EXIT_FAILED, EXIT_OK, EXIT_USAGE, run, version } from "./run.js";
export { configTargets, mainOptions, RUST_FIXTURES } from "./targets.js";
export type { Breaking, Change, ChangeKind, Impact } from "./breaking.js";
export { breaking, BreakingError, breakingJson, breakingLines, classify, diffModels } from "./breaking.js";
