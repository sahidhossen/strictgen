/**
 * Runs the generated TypeScript decoders: transpiles the files `generateInMemory` gave with the
 * TypeScript compiler, links them as modules and calls the entry points users call. The worker
 * runs this in the browser and the tests run it in Node, with the same compiler options as the
 * conformance runner (`src/conformance/drivers.ts`): ES2023, types removed, nothing else changed.
 */
import type ts from "typescript";

import type { OutputFile } from "../../src/generate.js";

/** Turns the text of one TypeScript module into a CommonJS module body. */
export type Transpile = (source: string, fileName: string) => string;

/** A transpiler that uses the given TypeScript compiler. */
export function transpiler(compiler: typeof ts): Transpile {
  return (source, fileName) =>
    compiler.transpileModule(source, {
      fileName,
      compilerOptions: { target: compiler.ScriptTarget.ES2023, module: compiler.ModuleKind.CommonJS },
    }).outputText;
}

/** Runs a CommonJS module body with its `exports` and `require`. */
export type Evaluate = (body: string, exports: Record<string, unknown>, require: (spec: string) => unknown) => void;

/** Evaluates a module body as a function of its own, in strict mode as the transpiler writes it. */
export const evaluate: Evaluate = (body, exports, require) => {
  const run = new Function("exports", "require", "module", body) as (
    e: Record<string, unknown>,
    r: (spec: string) => unknown,
    m: { exports: Record<string, unknown> },
  ) => void;
  run(exports, require, { exports });
};

/** The exports of a generated TypeScript package, from its `index.ts`. */
export type Package = Readonly<Record<string, unknown>>;

/**
 * Transpiles and links the TypeScript files directly in `dir`, like `ts/`, and returns what its
 * `index.ts` exports. A module may only import the other files of the package, by `./<name>.js`,
 * as generated code does.
 */
export function loadPackage(files: readonly OutputFile[], dir: string, transpile: Transpile, run: Evaluate = evaluate): Package {
  const sources = new Map<string, string>();
  for (const f of files) {
    if (f.path.startsWith(`${dir}/`) && f.path.endsWith(".ts") && !f.path.slice(dir.length + 1).includes("/")) {
      sources.set(f.path.slice(dir.length + 1), f.contents);
    }
  }
  const loaded = new Map<string, Record<string, unknown>>();
  const load = (name: string): Record<string, unknown> => {
    const done = loaded.get(name);
    if (done !== undefined) return done;
    const source = sources.get(name);
    if (source === undefined) throw new Error(`the generated TypeScript has no ${name}`);
    const exports: Record<string, unknown> = {};
    loaded.set(name, exports);
    run(transpile(source, name), exports, (spec) => {
      const match = /^\.\/([A-Za-z0-9_-]+)\.js$/.exec(spec);
      if (match?.[1] === undefined) throw new Error(`${name} imports ${spec}, which is not a generated module`);
      return load(`${match[1]}.ts`);
    });
    return exports;
  };
  return load("index.ts");
}

/** Which decoder reads the payload: the normal one, or the LLM one of a provider-ready payload. */
export type Decoder = "normal" | "llm";

/** How a decoder treats unknown keys. */
export type ReadMode = "strict" | "report";

/** The shared error shape, with the compact form. */
export interface ErrorFields {
  readonly path: string;
  readonly code: string;
  readonly expected: string | null;
  readonly found: string | null;
  readonly message: string;
  readonly compact: string;
}

/** What one decode gave. */
export type Outcome =
  | {
      readonly kind: "accepted";
      /** The unknown key paths report mode found, in input order; empty in strict mode. */
      readonly unknown: readonly string[];
      /** The value encoded again, or null when the encoder refused it. */
      readonly encoded: string | null;
      readonly encodeError: string | null;
    }
  | { readonly kind: "rejected"; readonly error: ErrorFields }
  /** The decoder threw something other than its DecodeError: always a bug. */
  | { readonly kind: "crash"; readonly message: string };

/** The names of the functions that decode and encode a type. */
export function entryNames(type: string, read: ReadMode, decoder: Decoder): { decode: string; encode: string } {
  const decode =
    decoder === "llm" ? `decode${type}FromLlm` : read === "report" ? `report${type}FromJson` : `decode${type}FromJson`;
  return { decode, encode: `encode${type}ToJson` };
}

/** The types a package has a decoder for, sorted, read with `decoder`. */
export function decodableTypes(pkg: Package, decoder: Decoder): string[] {
  const pattern = decoder === "llm" ? /^decode([A-Z][A-Za-z0-9]*)FromLlm$/ : /^decode([A-Z][A-Za-z0-9]*)FromJson$/;
  const types: string[] = [];
  for (const name of Object.keys(pkg)) {
    const type = pattern.exec(name)?.[1];
    if (type !== undefined && typeof pkg[name] === "function") types.push(type);
  }
  return types.sort();
}

type Fn = (...args: unknown[]) => unknown;

function fn(pkg: Package, name: string): Fn {
  const value = pkg[name];
  if (typeof value !== "function") throw new Error(`the generated TypeScript exports no ${name}`);
  return value as Fn;
}

/**
 * Decodes `text` as `type` with the entry point users call: `decodeXFromJson` in strict mode,
 * `reportXFromJson` in report mode (the package must be generated in that mode), or
 * `decodeXFromLlm`, which is strict in every mode. An accepted value is encoded again with
 * `encodeXToJson`. Throws an Error when the package has no such entry point.
 */
export function decodePayload(pkg: Package, type: string, read: ReadMode, decoder: Decoder, text: string): Outcome {
  const names = entryNames(type, read, decoder);
  const decode = fn(pkg, names.decode);
  const encode = fn(pkg, names.encode);
  const DecodeError = pkg.DecodeError;
  if (typeof DecodeError !== "function") throw new Error("the generated TypeScript exports no DecodeError");
  let value: unknown;
  let unknown: readonly string[] = [];
  try {
    const decoded = decode(text);
    if (read === "report" && decoder === "normal") {
      ({ value, unknown } = decoded as { value: unknown; unknown: string[] });
    } else {
      value = decoded;
    }
  } catch (error) {
    if (!(error instanceof (DecodeError as abstract new (...args: never[]) => Error))) {
      return { kind: "crash", message: String(error) };
    }
    const e = error as unknown as {
      path: string;
      code: string;
      expected?: string;
      found?: string;
      message: string;
      compact: () => string;
    };
    return {
      kind: "rejected",
      error: {
        path: e.path,
        code: e.code,
        expected: e.expected ?? null,
        found: e.found ?? null,
        message: e.message,
        compact: e.compact(),
      },
    };
  }
  try {
    return { kind: "accepted", unknown: [...unknown], encoded: encode(value) as string, encodeError: null };
  } catch (error) {
    return {
      kind: "accepted",
      unknown: [...unknown],
      encoded: null,
      encodeError: error instanceof Error ? error.message : String(error),
    };
  }
}
