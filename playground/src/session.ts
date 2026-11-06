/**
 * What the playground's worker does, without the worker: generates every language from the
 * schemas in memory and decodes a payload with the generated TypeScript. The tests run it in
 * Node; `worker.ts` runs it in the browser.
 */
import { ConfigError } from "../../src/config-error.js";
import type { OutputFile } from "../../src/generate.js";
import type { Profile } from "../../src/llm-profile.js";
import { builtinProfileFromText } from "../../src/llm-profile.js";
import { defaultSettings, generateInMemory, MEMORY_DIRS } from "../../src/memory.js";
import { CodegenError } from "../../src/schema.js";
import type { Decoder, Evaluate, Outcome, Package, ReadMode, Transpile } from "./decode.js";
import { decodableTypes, decodePayload, evaluate, loadPackage } from "./decode.js";
import type { SchemaText, State } from "./state.js";

/** The generator settings of a state: everything but the payload. */
export interface GenerateInput {
  readonly schemas: readonly SchemaText[];
  readonly read: ReadMode;
  readonly profiles: readonly string[];
  readonly cleanup: boolean;
  readonly ids: State["ids"];
}

/** What generation gave: the files of every language, or the one error that stopped it. */
export type Generated =
  | {
      readonly ok: true;
      /** Every generated file, by output, with paths relative to its folder. */
      readonly outputs: Outputs;
      readonly count: number;
      /** The types with a normal decoder, and those with an LLM decoder. */
      readonly types: readonly string[];
      readonly llmTypes: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/** What decoding gave, or why there is nothing to decode with. */
export type Decoded = Outcome | { readonly kind: "unavailable"; readonly reason: string };

/** The outputs, in the order the page shows them. */
export const OUTPUTS = ["typescript", "rust", "go", "llm"] as const;
export type Output = (typeof OUTPUTS)[number];
export type Outputs = Readonly<Record<Output, readonly OutputFile[]>>;

/** The files of each output, as `defaultSettings` places them, with paths relative to its folder. */
export function outputsOf(files: readonly OutputFile[]): Outputs {
  const out: Record<Output, OutputFile[]> = { typescript: [], rust: [], go: [], llm: [] };
  for (const f of files) {
    const output = OUTPUTS.find((o) => f.path.startsWith(`${MEMORY_DIRS[o]}/`));
    if (output === undefined) throw new Error(`the generated file ${f.path} is in no output folder`);
    out[output].push({ path: f.path.slice(MEMORY_DIRS[output].length + 1), contents: f.contents });
  }
  return out;
}

/** Generation and decoding for one page. Keeps the last package, so a new payload doesn't transpile again. */
export class Session {
  private key: string | undefined;
  private generated: Generated | undefined;
  private pkg: Package | undefined;
  private read: ReadMode = "strict";
  private readonly profiles = new Map<string, Profile>();

  /** `profileTexts` holds the text of each built in profile file, by name. */
  constructor(
    private readonly transpile: Transpile,
    private readonly profileTexts: Readonly<Record<string, string>>,
    private readonly run: Evaluate = evaluate,
  ) {}

  private profile(name: string): Profile {
    let p = this.profiles.get(name);
    if (p === undefined) {
      const text = this.profileTexts[name];
      if (text === undefined) throw new Error(`no built in profile ${name}`);
      p = builtinProfileFromText(name, text);
      this.profiles.set(name, p);
    }
    return p;
  }

  /** Generates from `input`, or returns the last result when the input is the same. */
  generate(input: GenerateInput): Generated {
    const key = JSON.stringify([input.schemas, input.read, input.profiles, input.cleanup, input.ids]);
    if (key === this.key && this.generated !== undefined) return this.generated;
    this.key = key;
    this.pkg = undefined;
    this.read = input.read;
    this.generated = this.build(input);
    return this.generated;
  }

  private build(input: GenerateInput): Generated {
    let files: readonly OutputFile[];
    try {
      const profiles = input.profiles.map((p) => this.profile(p));
      files = generateInMemory({
        schemas: input.schemas,
        settings: defaultSettings({ read: input.read, profiles, cleanup: input.cleanup }),
        ...(input.ids === null ? {} : { ids: input.ids }),
      }).files;
    } catch (error) {
      if (error instanceof CodegenError || error instanceof ConfigError) return { ok: false, error: error.message };
      return { ok: false, error: `internal error: ${error instanceof Error ? error.message : String(error)}` };
    }
    let pkg: Package;
    try {
      pkg = loadPackage(files, MEMORY_DIRS.typescript, this.transpile, this.run);
    } catch (error) {
      return { ok: false, error: `the generated TypeScript didn't load: ${error instanceof Error ? error.message : String(error)}` };
    }
    this.pkg = pkg;
    return {
      ok: true,
      outputs: outputsOf(files),
      count: files.length,
      types: decodableTypes(pkg, "normal"),
      llmTypes: decodableTypes(pkg, "llm"),
    };
  }

  /** Decodes `payload` as `type` with the package of the last {@link generate}. */
  decode(type: string, decoder: Decoder, payload: string): Decoded {
    const g = this.generated;
    if (g === undefined || !g.ok || this.pkg === undefined) return { kind: "unavailable", reason: "the schemas don't generate" };
    const types = decoder === "llm" ? g.llmTypes : g.types;
    if (!types.includes(type)) {
      return {
        kind: "unavailable",
        reason:
          decoder === "llm" && g.llmTypes.length === 0
            ? "pick an LLM profile to get the LLM decoders"
            : `no ${decoder === "llm" ? "LLM decoder" : "decoder"} for a type ${JSON.stringify(type)}`,
      };
    }
    return decodePayload(this.pkg, type, this.read, decoder, payload);
  }
}

/** What the page asks the worker: generate from `input`, then decode `payload` as `type`. */
export interface Request {
  readonly id: number;
  readonly input: GenerateInput;
  readonly type: string;
  readonly decoder: Decoder;
  readonly payload: string;
}

/**
 * The worker's answer to a {@link Request}. `type` is the type decoded: the one asked for when
 * the decoder has it, else the first it has. `decoded` is null when there is no payload or no type.
 */
export interface Response {
  readonly id: number;
  readonly generated: Generated;
  readonly type: string;
  readonly decoded: Decoded | null;
}

/** Answers one request. */
export function respond(session: Session, request: Request): Response {
  const generated = session.generate(request.input);
  if (!generated.ok) return { id: request.id, generated, type: request.type, decoded: null };
  const types = request.decoder === "llm" ? generated.llmTypes : generated.types;
  const type = types.includes(request.type) ? request.type : (types[0] ?? request.type);
  const decoded = request.payload.trim() === "" ? null : session.decode(type, request.decoder, request.payload);
  return { id: request.id, generated, type, decoded };
}
