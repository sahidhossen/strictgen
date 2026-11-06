/**
 * The shared test vectors of the LLM decoders: payloads in the form a model sends for a
 * provider-ready schema, each with what every language must make of it. The TypeScript, Go and
 * Rust tests of `examples/llm` run the same file, `examples/llm/llm-vectors.json`, and must give
 * the same result for every vector.
 *
 * A valid vector comes from a valid payload of the payload generator, projected the way each map
 * shape of the profiles gives it: null for every optional key that is absent, a type that isn't an
 * object wrapped as `{ "value": ... }`, and maps as entries or objects. Decoding it through the
 * LLM decoder must give the same value as decoding the payload itself with the normal decoder.
 *
 * An invalid vector is a near miss, with the `{ path, code }` its error must have, in the terms of
 * the model's payload. Some come from the generator's near misses, projected the same way, with
 * the path moved to the payload; the rest change what only the LLM form has: the object around a
 * wrapped type and the entries of maps. A near miss whose meaning the LLM form changes, null for
 * an optional key, is left out, since null stands for absent there. The labels are worked out
 * here from each change, never by a decoder.
 */
import type { Profile } from "./llm-profile.js";
import { isWrapped, llmTypes } from "./llm-decoders.js";
import { WRAP_KEY } from "./llm-project.js";
import type { Decl, MapType, Model, TypeExpr } from "./model.js";
import type { Payload } from "./payloads.js";
import { PayloadGenerator } from "./payloads.js";

/** A map shape: entries or objects. */
export type MapShape = "entries" | "object";

/** One vector before a decoder ran it: the payload, and the normal JSON or the expected error. */
export interface LlmCandidate {
  readonly name: string;
  readonly type: string;
  /** The JSON text the model sends. */
  readonly llm: string;
  /** For a valid vector, the same value as normal JSON. */
  readonly json?: string;
  /** For an invalid vector, the error's path in the payload and its code. */
  readonly expect?: { readonly path: string; readonly code: string };
}

/** One vector as the file holds it. */
export interface LlmVector {
  readonly name: string;
  readonly type: string;
  readonly llm: string;
  /** For a valid vector: the normal JSON of the same value. */
  readonly json?: string;
  /** For an invalid vector: the error's compact form. */
  readonly error?: string;
}

type JsonObject = { [key: string]: Payload };

const BOM = String.fromCodePoint(0xfeff);
const FENCE = "`".repeat(3);

function isObject(value: Payload | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets an own key, so `__proto__` stays data. */
function put(target: JsonObject, key: string, value: Payload): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function segment(s: string | number): string {
  return `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function segments(path: string): string[] {
  return path === "" ? [] : path.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** The entries arrays of a projected payload: where each is, and the map's limits. */
interface EntriesAt {
  readonly path: string;
  readonly type: MapType;
  /** Inside an untagged union, where a broken entry fails the union, not the entry. */
  readonly inUnion: boolean;
}

/** A payload in its LLM form, and how its paths map from the normal payload's. */
interface Projected {
  readonly payload: Payload;
  /** The payload path of each value of the normal payload, by its path. */
  readonly paths: ReadonlyMap<string, string>;
  /** The payload path of the key of each map member read from entries, by the member's normal path. */
  readonly keys: ReadonlyMap<string, string>;
  /** The normal paths of the optional keys that were null, which the LLM form reads as absent. */
  readonly nulls: ReadonlySet<string>;
  readonly entries: readonly EntriesAt[];
}

/** Projects normal JSON values into the form a model sends, by the type, as src/llm-project.ts projects schemas. */
class Projector {
  readonly paths = new Map<string, string>();
  readonly keys = new Map<string, string>();
  readonly nulls = new Set<string>();
  readonly entries: EntriesAt[] = [];
  /** How many untagged unions the value being projected is inside. */
  unions = 0;

  constructor(
    readonly decls: ReadonlyMap<string, Decl>,
    readonly generator: PayloadGenerator,
    readonly shape: MapShape,
  ) {}

  /** `json` in the LLM form. A value that doesn't fit the type stays as it is, so near misses keep their change. */
  value(type: TypeExpr, json: Payload, from: string, to: string): Payload {
    this.paths.set(from, to);
    switch (type.kind) {
      case "ref":
        return this.decl(this.decl$(type.name), json, from, to);
      case "array":
        return Array.isArray(json) ? json.map((item, i) => this.value(type.items, item, `${from}${segment(i)}`, `${to}${segment(i)}`)) : json;
      case "map": {
        if (!isObject(json)) return json;
        if (this.shape === "object") {
          const out: JsonObject = {};
          for (const [k, v] of Object.entries(json)) put(out, k, this.value(type.value, v, `${from}${segment(k)}`, `${to}${segment(k)}`));
          return out;
        }
        this.entries.push({ path: to, type, inUnion: this.unions > 0 });
        return Object.entries(json).map(([k, v], i) => {
          const at = `${to}${segment(i)}`;
          this.keys.set(`${from}${segment(k)}`, `${at}/key`);
          return { key: k, value: this.value(type.value, v, `${from}${segment(k)}`, `${at}/value`) };
        });
      }
      default:
        return json;
    }
  }

  decl$(name: string): Decl {
    const decl = this.decls.get(name);
    if (decl === undefined) throw new Error(`no type ${name}`);
    return decl;
  }

  decl(decl: Decl, json: Payload, from: string, to: string): Payload {
    switch (decl.kind) {
      case "struct": {
        if (!isObject(json)) return json;
        const out: JsonObject = {};
        for (const f of decl.fields) {
          const at = `${from}${segment(f.name)}`;
          if (Object.hasOwn(json, f.name)) {
            const v = json[f.name] ?? null;
            if (v === null && !f.required) this.nulls.add(at);
            put(out, f.name, this.value(f.type, v, at, `${to}${segment(f.name)}`));
          } else if (!f.required) {
            put(out, f.name, null);
          }
        }
        // Keys the type doesn't name stay, after the named ones, as a near miss adds them.
        for (const [k, v] of Object.entries(json)) if (!decl.fields.some((f) => f.name === k)) put(out, k, v);
        return out;
      }
      case "tagged": {
        const tag = isObject(json) ? json[decl.tag] : undefined;
        const variant = decl.variants.find((v) => v.value === tag);
        return variant === undefined ? json : this.decl(this.decl$(variant.type), json, from, to);
      }
      case "untagged": {
        // The variant the decoders pick, by the structure of the normal payload.
        const variant = decl.variants.find((v) => this.generator.fits(v.type, json));
        if (variant === undefined) return json;
        this.unions++;
        try {
          return this.value(variant.type, json, from, to);
        } finally {
          this.unions--;
        }
      }
      case "alias":
        return this.value(decl.type, json, from, to);
      case "enum":
      case "id":
        return json;
    }
  }
}

/** Projects a normal payload of the type `name` to the LLM form of `shape`. */
function project(model: Model, generator: PayloadGenerator, name: string, json: Payload, shape: MapShape): Projected {
  const decls = new Map(model.decls.map((d) => [d.name, d]));
  const p = new Projector(decls, generator, shape);
  const decl = p.decl$(name);
  const wrapped = isWrapped(decl);
  const inner = p.value({ kind: "ref", name }, json, "", wrapped ? `/${WRAP_KEY}` : "");
  const payload = wrapped ? { [WRAP_KEY]: inner } : inner;
  return { payload, paths: p.paths, keys: p.keys, nulls: p.nulls, entries: p.entries };
}

/**
 * The payload path of a normal path: the longest prefix the projection mapped, then the rest as
 * it is. A member of a map read from entries is its key, for an error of the key itself.
 */
function moved(projected: Projected, path: string, key: boolean): string {
  if (key) {
    const at = projected.keys.get(path);
    if (at !== undefined) return at;
  }
  const parts = segments(path);
  for (let n = parts.length; n >= 0; n--) {
    const prefix = parts.slice(0, n).map((s) => segment(s)).join("");
    const at = projected.paths.get(prefix);
    if (at !== undefined) return at + parts.slice(n).map((s) => segment(s)).join("");
  }
  return path;
}

/** The value at a normal path, if there is one. */
function at(root: Payload, path: string): Payload | undefined {
  let current: Payload | undefined = root;
  for (const s of segments(path)) {
    if (Array.isArray(current)) current = current[Number(s)];
    else if (isObject(current) && Object.hasOwn(current, s)) current = current[s];
    else return undefined;
  }
  return current;
}

/** A copy of root with the value at path changed. */
function changed(root: Payload, path: string, change: (value: Payload) => Payload | undefined): Payload {
  const [head, ...rest] = segments(path);
  if (head === undefined) return change(root) ?? null;
  const tail = rest.map((s) => segment(s)).join("");
  if (Array.isArray(root)) return root.map((item, i) => (String(i) === head ? changed(item, tail, change) : item));
  if (!isObject(root)) return root;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(root)) {
    if (k !== head) put(out, k, v);
    else if (rest.length > 0) put(out, k, changed(v, tail, change));
    else {
      const next = change(v);
      if (next !== undefined) put(out, k, next);
    }
  }
  return out;
}

/** The names of the map shapes, by the profiles that give them, like `entries (openai, anthropic)`. */
function shapes(profiles: readonly Profile[]): { shape: MapShape; label: string }[] {
  const out: { shape: MapShape; label: string }[] = [];
  for (const shape of ["entries", "object"] as const) {
    const names = profiles.filter((p) => p.maps === shape).map((p) => p.name);
    if (names.length > 0) out.push({ shape, label: `${shape === "entries" ? "maps as entries" : "maps as objects"} (${names.join(", ")})` });
  }
  return out;
}

/** Options for {@link llmCandidates}. */
export interface CandidateOptions {
  readonly seed?: number;
  /** Valid payloads per type. */
  readonly count?: number;
  /**
   * Adds the first valid payload of each type with what the cleanup step removes: a byte order
   * mark, a code fence and a trailing comma.
   */
  readonly cleanup?: boolean;
}

/**
 * The vectors for every type with an LLM decoder, in a fixed order, before a decoder ran them:
 * valid payloads in each map shape the profiles give, the generator's near misses projected, and
 * near misses of the LLM form. `extra` adds hand made payloads, given in normal JSON.
 */
export function llmCandidates(
  model: Model,
  profiles: readonly Profile[],
  options: CandidateOptions = {},
  extra: readonly { readonly name: string; readonly type: string; readonly json: Payload }[] = [],
): LlmCandidate[] {
  const generator = new PayloadGenerator(model, { seed: options.seed ?? 1 });
  const out: LlmCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: LlmCandidate): void => {
    const key = `${c.type} ${c.llm}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  const forms = shapes(profiles);
  const bases: { name: string; type: string; json: Payload }[] = [];
  for (const decl of llmTypes(model)) {
    for (let i = 0; i < (options.count ?? 3); i++) bases.push({ name: `${decl.name} value ${String(i)}`, type: decl.name, json: generator.valid(decl.name) });
  }
  bases.push(...extra);
  const fenced = new Set<string>();
  for (const base of bases) {
    for (const { shape, label } of forms) {
      const p = project(model, generator, base.type, base.json, shape);
      const llm = JSON.stringify(p.payload);
      add({ name: `${base.name}, ${label}`, type: base.type, llm, json: JSON.stringify(base.json) });
      if (options.cleanup === true && !fenced.has(base.type) && llm.endsWith("}") && llm !== "{}") {
        fenced.add(base.type);
        const text = `${BOM}${FENCE}json\n${llm.slice(0, -1)},}\n${FENCE}\n`;
        add({ name: `${base.name}, ${label}, with a fence and a trailing comma`, type: base.type, llm: text, json: JSON.stringify(base.json) });
      }
    }
  }
  for (const base of bases) {
    for (const { shape, label } of forms) {
      const p = project(model, generator, base.type, base.json, shape);
      for (const miss of generator.nearMisses(base.type, base.json)) {
        const q = project(model, generator, base.type, miss.payload, shape);
        // null for an optional key is absent in the LLM form, so that change is no error there.
        if (miss.code === "null_not_allowed" && q.nulls.has(miss.path)) continue;
        // A change of a map key renames the member, so its path is a key the valid payload doesn't have.
        const key = at(base.json, miss.path) === undefined && q.keys.has(miss.path);
        add({
          name: `${base.name}, ${label}: ${miss.change}`,
          type: base.type,
          llm: JSON.stringify(q.payload),
          expect: { path: moved(q, miss.path, key), code: miss.code },
        });
      }
      for (const miss of llmMisses(p)) {
        add({ name: `${base.name}, ${label}: ${miss.change}`, type: base.type, llm: JSON.stringify(miss.payload), expect: { path: miss.path, code: miss.code } });
      }
    }
  }
  return out;
}

/** Near misses of what only the LLM form has: the object around a wrapped type, and the entries of maps. */
function llmMisses(p: Projected): { payload: Payload; path: string; code: string; change: string }[] {
  const out: { payload: Payload; path: string; code: string; change: string }[] = [];
  const root = p.payload;
  const wrapped = isObject(root) && p.paths.get("") === `/${WRAP_KEY}`;
  if (wrapped) {
    const inner = root[WRAP_KEY] ?? null;
    out.push({ payload: {}, path: `/${WRAP_KEY}`, code: "missing_key", change: "no value key" });
    out.push({ payload: { [WRAP_KEY]: inner, extra: 1 }, path: "/extra", code: "unknown_key", change: "a key beside value" });
    out.push({
      payload: inner,
      path: isObject(inner) ? `/${WRAP_KEY}` : "",
      code: isObject(inner) ? "missing_key" : inner === null ? "null_not_allowed" : "wrong_type",
      change: "the value without the object around it",
    });
  }
  for (const e of p.entries) {
    if (e.inUnion) continue;
    const list = at(root, e.path);
    if (!Array.isArray(list)) continue;
    out.push({ payload: changed(root, e.path, () => "text"), path: e.path, code: "wrong_type", change: `a string for the entries at ${e.path}` });
    const first = list[0];
    if (!isObject(first)) continue;
    const entry = `${e.path}/0`;
    out.push({ payload: changed(root, e.path, (v) => (Array.isArray(v) ? [...v, first] : v)), path: `${e.path}/${String(list.length)}/key`, code: "duplicate_key", change: `the first entry at ${e.path} again` });
    out.push({ payload: changed(root, `${entry}/key`, () => undefined), path: `${entry}/key`, code: "missing_key", change: `no key in the entry at ${entry}` });
    out.push({ payload: changed(root, `${entry}/value`, () => undefined), path: `${entry}/value`, code: "missing_key", change: `no value in the entry at ${entry}` });
    out.push({ payload: changed(root, entry, (v) => (isObject(v) ? { ...v, note: "x" } : v)), path: `${entry}/note`, code: "unknown_key", change: `a third key in the entry at ${entry}` });
    out.push({ payload: changed(root, `${entry}/key`, () => 12), path: `${entry}/key`, code: "wrong_type", change: `a number for the key at ${entry}` });
    out.push({ payload: changed(root, entry, () => []), path: entry, code: "wrong_type", change: `an array for the entry at ${entry}` });
  }
  return out;
}

/** A JSON string literal of text in ASCII only, every other UTF-16 unit as a \u escape. */
function ascii(text: string): string {
  const json = JSON.stringify(text);
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const unit = json.charCodeAt(i);
    out += unit < 0x7f ? json.charAt(i) : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** The vectors file: one vector per line in a JSON array, ASCII only, so no character is hard to see. */
export function vectorsText(vectors: readonly LlmVector[]): string {
  const lines = vectors.map((v) => {
    const fields = [`"name": ${ascii(v.name)}`, `"type": ${ascii(v.type)}`, `"llm": ${ascii(v.llm)}`];
    if (v.json !== undefined) fields.push(`"json": ${ascii(v.json)}`);
    if (v.error !== undefined) fields.push(`"error": ${ascii(v.error)}`);
    return `  { ${fields.join(", ")} }`;
  });
  return `[\n${lines.join(",\n")}\n]\n`;
}
