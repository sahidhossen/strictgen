/**
 * What the LLM decoders of every language share: which types get one, how each is named, and
 * which map shapes they read. docs/llm.md describes the same rules for users.
 *
 * An LLM decoder reads the JSON text a model gave for a type's provider-ready schema and undoes
 * the projection of src/llm-project.ts before it checks every constraint of the real type:
 *
 * - null for an optional field means the field is absent. For a union, null is one more branch,
 *   so the same rule covers it
 * - a type that isn't an object at the root is read from the `value` key of the object around it
 * - a map is read from an array of `{ "key": ..., "value": ... }` entries when a configured
 *   profile projects maps that way, from a JSON object when one keeps them as objects, or from
 *   either when the profiles differ. The JSON type tells the two apart, so this is never
 *   ambiguous. A key given twice in entries fails with duplicate_key at the later entry's key
 * - a tagged union keeps its JSON shape, so its tag picks the branch as in the normal decoders
 *
 * LLM decoders are always strict: the provider schema closes every object, so an unknown key
 * fails with unknown_key whatever read mode the target has. Errors have the shared shape, with
 * paths in the terms of the payload the model sent, like /value/2 or /labels/0/key, since that
 * is the text the model has to fix.
 */
import type { Profile } from "./llm-profile.js";
import { projectedTypes } from "./llm-project.js";
import type { Decl, Model } from "./model.js";
import { RENAME_TYPE } from "./naming.js";
import { CodegenError } from "./schema.js";

/** The map shapes the LLM decoders of an output read, from the profiles the config lists. */
export interface LlmMaps {
  /** A map as an array of `{ key, value }` entries, which some profile projects. */
  readonly entries: boolean;
  /** A map as a JSON object, which some profile keeps. */
  readonly objects: boolean;
}

/** The map shapes the profiles project maps as. */
export function llmMaps(profiles: readonly Profile[]): LlmMaps {
  return {
    entries: profiles.some((p) => p.maps === "entries"),
    objects: profiles.some((p) => p.maps === "object"),
  };
}

/** The map shapes as one number, 1 for entries plus 2 for objects, which the helpers read. */
export function mapBits(maps: LlmMaps): number {
  return (maps.entries ? 1 : 0) + (maps.objects ? 2 : 0);
}

/**
 * What a map's decoder expects when the JSON type is neither shape it reads: an array for entries
 * only, an object for objects only, either for both.
 */
export function mapExpected(maps: LlmMaps): string {
  if (maps.entries && maps.objects) return "an array or an object";
  return maps.entries ? "an array" : "an object";
}

/** The types with an LLM decoder: schema roots and `$defs` entries, the types with a schema. */
export function llmTypes(model: Model): Decl[] {
  return projectedTypes(model);
}

/** True when the projection wraps the type as `{ "value": ... }`: every type but a struct. */
export function isWrapped(decl: Decl): boolean {
  return decl.kind !== "struct";
}

/** The TypeScript LLM decoder of a type, like `decodeOrderFromLlm`. */
export function tsLlmName(type: string): string {
  return `decode${type}FromLlm`;
}

/** The Go LLM decoder of a type, like `DecodeOrderFromLlm`. */
export function goLlmName(type: string): string {
  return `Decode${type}FromLlm`;
}

/** A PascalCase type name in snake case, like `OrderRequest` to `order_request` and `HTTPServer` to `http_server`. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** The Rust LLM decoder of a type, like `decode_order_request_from_llm`. */
export function rustLlmName(type: string): string {
  return `decode_${snake(type)}_from_llm`;
}

/**
 * Fails when two LLM decoders would have the same name in a language, or one would have the name
 * of another generated function, like the normal decoder of a type named `OrderFromLlm`.
 * `taken` gives the names the language generates for a type besides its LLM decoder.
 */
export function checkLlmNames(
  model: Model,
  language: string,
  name: (type: string) => string,
  taken: (decl: Decl) => readonly string[],
): void {
  const owners = new Map<string, Decl>();
  for (const decl of model.decls) for (const n of taken(decl)) owners.set(n, decl);
  for (const decl of llmTypes(model)) {
    const fn = name(decl.name);
    const other = owners.get(fn);
    if (other !== undefined) {
      throw new CodegenError(
        decl.path,
        "name-clash",
        `the ${language} LLM decoder ${fn} of type ${decl.name} has the name of ` +
          (other === decl ? "another generated name of the type" : `a name generated for type ${other.name}`),
        RENAME_TYPE,
      );
    }
    owners.set(fn, decl);
  }
}
