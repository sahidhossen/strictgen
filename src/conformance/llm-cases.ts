/**
 * The conformance cases in the form a model sends for a type's provider-ready schema, so every
 * case also runs through the LLM decoders, with an expectation worked out from the case's own.
 *
 * A case is projected the way src/llm-project.ts projects schemas (and src/llm-vectors.ts
 * payloads): `null` for every optional key that is absent, a type that isn't a struct wrapped as
 * `{"value": ...}`, and maps as entries (`[{"key": ..., "value": ...}]`) or kept as objects, by
 * the shape the variant gives. It is projected on the lossless tree of `canonical.ts`, so number
 * spellings and 64-bit integers reach the decoders as the case wrote them.
 *
 * - A valid case stays valid, and its LLM decode must encode to the case itself: the LLM value
 *   equals the normal value, compared by canonical bytes.
 * - An invalid case keeps its strict error (LLM decoders are strict in every read mode), with the
 *   path moved into the payload: `/value/...` under the wrapper, `/labels/0/value` for a map
 *   member read from entries, `/labels/0/key` when the member's key itself breaks the key type.
 *   Cases the projection changes the meaning of are left out, each for a stated reason
 *   ({@link SKIPS}): text the tree can't hold (not JSON, a key given twice), `null` for an
 *   optional key, which means absent in the LLM form, and a value whose nesting crosses the
 *   depth limit only in one of the two forms.
 * - Near misses of what only the LLM form has come from each valid case: the object around a
 *   wrapped type, the entries of maps, a payload cut short, a key given twice, and, for code that
 *   reads one map shape only, a payload that gives its one map in the other shape.
 * - Each invalid case that fails a constraint also gets a third key in its first entry, which
 *   must fail first with unknown_key there: the structure of the whole value is checked before
 *   any constraint, in entries as in objects.
 */

import type { Model, TypeExpr } from "../model.js";
import { WRAP_KEY } from "../llm-project.js";
import { isWrapped } from "../llm-decoders.js";
import type { Json } from "./canonical.js";
import { CanonicalError, JsonNumber, parseJson } from "./canonical.js";
import type { Case, Mark } from "./cases.js";
import type { Shape } from "./protocol.js";
import { depth, ModelWalk, segment, writeJson } from "./walk.js";
import { MAX_DEPTH } from "../errors.js";

/** Why an invalid case doesn't run through the LLM decoders, by reason. */
export const SKIPS = {
  text: "its text is not one JSON value the projection can read, like a key given twice",
  null: "null for an optional key means absent in the LLM form",
  depth: "the LLM form nests deeper or less deep across the depth limit",
  entries: "an array where a map goes is the map's entries in the LLM form, for code that reads entries",
} as const;

/** Where a map read from entries is in a projected payload. */
interface EntriesAt {
  readonly path: string;
  /** Inside an untagged union, where a broken entry fails the union, not the entry. */
  readonly inUnion: boolean;
}

/** A payload in its LLM form, and how its paths map from the case's. */
export interface Projected {
  readonly payload: Json;
  /** The payload path of each value of the case, by its path in the case. */
  readonly paths: ReadonlyMap<string, string>;
  /** The payload path of the key of each map member read from entries, by the member's path. */
  readonly keys: ReadonlyMap<string, string>;
  /** The case paths of the optional keys that were null, which the LLM form reads as absent. */
  readonly nulls: ReadonlySet<string>;
  /** The case path of each map, with its payload path, in the order the projection met them. */
  readonly maps: readonly { readonly from: string; readonly to: string; readonly inUnion: boolean }[];
  readonly entries: readonly EntriesAt[];
  /** The case paths of arrays where a map goes, which read as entries in the LLM form. */
  readonly arrayMaps: ReadonlySet<string>;
}

class Projector {
  readonly paths = new Map<string, string>();
  readonly keys = new Map<string, string>();
  readonly nulls = new Set<string>();
  readonly maps: { from: string; to: string; inUnion: boolean }[] = [];
  readonly entries: EntriesAt[] = [];
  readonly arrayMaps = new Set<string>();
  unions = 0;

  constructor(
    readonly walk: ModelWalk,
    readonly shape: Shape,
  ) {}

  /** `json` in the LLM form. A value that doesn't fit the type stays as it is, so invalid cases keep their change. */
  value(type: TypeExpr, json: Json, from: string, to: string): Json {
    this.paths.set(from, to);
    switch (type.kind) {
      case "ref":
        return this.decl(type.name, json, from, to);
      case "array":
        return Array.isArray(json) ? json.map((item, i) => this.value(type.items, item, `${from}${segment(i)}`, `${to}${segment(i)}`)) : json;
      case "map": {
        if (Array.isArray(json)) this.arrayMaps.add(from);
        if (!(json instanceof Map)) return json;
        this.maps.push({ from, to, inUnion: this.unions > 0 });
        if (this.shape === "objects") {
          return new Map([...json].map(([k, v]) => [k, this.value(type.value, v, `${from}${segment(k)}`, `${to}${segment(k)}`)]));
        }
        this.entries.push({ path: to, inUnion: this.unions > 0 });
        return [...json].map(([k, v], i) => {
          const at = `${to}${segment(i)}`;
          this.keys.set(`${from}${segment(k)}`, `${at}/key`);
          return new Map<string, Json>([
            ["key", k],
            ["value", this.value(type.value, v, `${from}${segment(k)}`, `${at}/value`)],
          ]);
        });
      }
      default:
        return json;
    }
  }

  decl(name: string, json: Json, from: string, to: string): Json {
    const decl = this.walk.decl(name);
    switch (decl.kind) {
      case "struct": {
        if (!(json instanceof Map)) return json;
        const out = new Map<string, Json>();
        for (const f of decl.fields) {
          const at = `${from}${segment(f.name)}`;
          const v = json.get(f.name);
          if (v !== undefined) {
            if (v === null && !f.required) this.nulls.add(at);
            out.set(f.name, this.value(f.type, v, at, `${to}${segment(f.name)}`));
          } else if (!f.required) {
            out.set(f.name, null);
          }
        }
        // Keys the type doesn't name stay, after the named ones, with the rest of the struct.
        for (const [k, v] of json) {
          if (decl.fields.some((f) => f.name === k)) continue;
          const at = `${from}${segment(k)}`;
          out.set(k, decl.rest === undefined ? v : this.value(decl.rest.value, v, at, `${to}${segment(k)}`));
        }
        return out;
      }
      case "tagged": {
        const tag = json instanceof Map ? json.get(decl.tag) : undefined;
        const variant = decl.variants.find((v) => v.value === tag);
        return variant === undefined ? json : this.decl(variant.type, json, from, to);
      }
      case "untagged": {
        // The variant the decoders pick, by the structure of the case.
        const variant = decl.variants.find((v) => this.walk.fits(v.type, json));
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

/** Projects a case's value of the type `name` to the LLM form of `shape`. */
export function project(walk: ModelWalk, name: string, json: Json, shape: Shape): Projected {
  const p = new Projector(walk, shape);
  const wrapped = isWrapped(walk.decl(name));
  const inner = p.value({ kind: "ref", name }, json, "", wrapped ? `/${WRAP_KEY}` : "");
  const payload = wrapped ? new Map<string, Json>([[WRAP_KEY, inner]]) : inner;
  return { payload, paths: p.paths, keys: p.keys, nulls: p.nulls, maps: p.maps, entries: p.entries, arrayMaps: p.arrayMaps };
}

/** The payload path of a case path: the longest prefix the projection mapped, then the rest as it is. */
export function moved(projected: Projected, path: string): string {
  const parts = path === "" ? [] : path.slice(1).split("/");
  for (let n = parts.length; n >= 0; n--) {
    const prefix = parts
      .slice(0, n)
      .map((s) => `/${s}`)
      .join("");
    const at = projected.paths.get(prefix);
    if (at !== undefined) return at + parts.slice(n).map((s) => `/${s}`).join("");
  }
  return path;
}

/** The value at a case path, if there is one. */
function at(root: Json, path: string): { parent: Json; key: string } | undefined {
  const parts = path === "" ? [] : path.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  const key = parts.pop();
  if (key === undefined) return undefined;
  let current: Json | undefined = root;
  for (const s of parts) {
    if (Array.isArray(current)) current = current[Number(s)];
    else if (current instanceof Map) current = current.get(s);
    else return undefined;
    if (current === undefined) return undefined;
  }
  return { parent: current, key };
}

/** The map type a case path's parent is, when the path is a map member: for telling a key's error from its value's. */
function memberKeyType(walk: ModelWalk, type: string, root: Json, path: string): TypeExpr | undefined {
  // Walk the model along the path to the parent of the member.
  const parts = path === "" ? [] : path.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
  parts.pop();
  let t: TypeExpr = { kind: "ref", name: type };
  let value: Json | undefined = root;
  const step = (s: string): boolean => {
    for (;;) {
      if (t.kind === "ref") {
        const d = walk.decl(t.name);
        if (d.kind === "alias") {
          t = d.type;
          continue;
        }
        if (d.kind === "tagged") {
          const tag = value instanceof Map ? value.get(d.tag) : undefined;
          const v = d.variants.find((x) => x.value === tag);
          if (v === undefined) return false;
          t = { kind: "ref", name: v.type };
          continue;
        }
        if (d.kind === "untagged") {
          const fit = d.variants.find((x) => value !== undefined && walk.fits(x.type, value));
          if (fit === undefined) return false;
          t = fit.type;
          continue;
        }
        if (d.kind === "struct") {
          const f = d.fields.find((x) => x.name === s);
          if (f !== undefined) t = f.type;
          else if (d.rest !== undefined) t = d.rest.value;
          else return false;
          value = value instanceof Map ? value.get(s) : undefined;
          return true;
        }
        return false;
      }
      if (t.kind === "array") {
        t = t.items;
        value = Array.isArray(value) ? value[Number(s)] : undefined;
        return true;
      }
      if (t.kind === "map") {
        t = t.value;
        value = value instanceof Map ? value.get(s) : undefined;
        return true;
      }
      return false;
    }
  };
  for (const s of parts) if (!step(s)) return undefined;
  // Resolve the parent itself to a map.
  for (;;) {
    if (t.kind === "map") return t.key;
    if (t.kind !== "ref") return undefined;
    const d = walk.decl(t.name);
    if (d.kind === "alias") t = d.type;
    else if (d.kind === "untagged") {
      const fit = d.variants.find((x) => value !== undefined && walk.fits(x.type, value));
      if (fit === undefined) return undefined;
      t = fit.type;
    } else return undefined;
  }
}

/** One case to run through the LLM decoders of a variant, with its marks moved into the payload. */
export interface LlmCase {
  readonly case: Case;
  readonly marks: readonly Mark[];
  /** The marks the moved ones stand for, by moved mark. */
  readonly origin: ReadonlyMap<Mark, Mark>;
}

/** Why a case was left out, by case id, for the run's summary. */
export type Skipped = Map<string, string>;

const TEXT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function parse(c: Case): Json | undefined {
  try {
    return parseJson(TEXT.decode(c.bytes));
  } catch (error) {
    if (error instanceof CanonicalError || error instanceof TypeError) return undefined;
    throw error;
  }
}

/** Marks that take a language out of the comparison, which near misses of the case can't carry. */
const EXCLUDING: ReadonlySet<string> = new Set(["ts-unsafe-integer", "ts-no-bytes-api", "go-unmarshal-syntax"]);

export interface LlmCaseOptions {
  /** The map shape the payloads give. */
  readonly shape: Shape;
  /** True when the decoders read maps as entries, whatever shape the payloads give. */
  readonly readsEntries: boolean;
  /**
   * For code that reads only `shape`: also give each valid case with exactly one map in the
   * other shape, which must fail with wrong_type at the map.
   */
  readonly otherShape?: boolean;
}

/**
 * Every case of the types `walk`'s model has an LLM decoder for, in the LLM form of one shape,
 * with the near misses only that form has. `skipped` collects why a case was left out.
 */
export function llmCases(
  model: Model,
  cases: readonly Case[],
  marks: readonly Mark[],
  types: ReadonlySet<string>,
  options: LlmCaseOptions,
  skipped: Skipped = new Map(),
): LlmCase[] {
  const walk = new ModelWalk(model);
  const out: LlmCase[] = [];
  const firsts = new Set<string>();
  for (const c of cases) {
    if (!types.has(c.type)) continue;
    const json = parse(c);
    if (json === undefined) {
      skipped.set(c.id, SKIPS.text);
      continue;
    }
    const p = project(walk, c.type, json, options.shape);
    const own = marks.filter((m) => m.case === c.id);
    if ((depth(json) >= MAX_DEPTH - 1 || depth(p.payload) >= MAX_DEPTH - 1) && depth(json) !== depth(p.payload)) {
      skipped.set(c.id, SKIPS.depth);
      continue;
    }
    const movedMarks = own.map((m) => (m.path === undefined ? m : { ...m, path: moved(p, m.path) }));
    const origin = new Map(movedMarks.map((m, i) => [m, own[i] as Mark]));
    const text = writeJson(p.payload);
    if (c.valid) {
      out.push({ case: { ...c, bytes: bytes(text), encodes: c.bytes }, marks: movedMarks, origin });
      if (own.some((m) => EXCLUDING.has(m.kind))) continue;
      for (const miss of misses(c, p, text, !firsts.has(c.type))) out.push({ case: miss, marks: [], origin: new Map() });
      firsts.add(c.type);
      if (options.otherShape === true) {
        const single = p.maps.length === 1 ? p.maps[0] : undefined;
        if (single !== undefined && !single.inUnion) {
          const other = project(walk, c.type, json, options.shape === "entries" ? "objects" : "entries");
          out.push({
            case: llmMiss(c, `the map at ${single.to} as ${options.shape === "entries" ? "an object" : "entries"}`, writeJson(other.payload), single.to, "wrong_type"),
            marks: [],
            origin: new Map(),
          });
        }
      }
      continue;
    }
    const want = c.strict;
    if (want.accepted) throw new Error(`${c.id}: an invalid case without an error`);
    if (want.code === "null_not_allowed" && p.nulls.has(want.path)) {
      skipped.set(c.id, SKIPS.null);
      continue;
    }
    if (options.readsEntries && [...p.arrayMaps].some((a) => want.path === a || want.path.startsWith(`${a}/`))) {
      skipped.set(c.id, SKIPS.entries);
      continue;
    }
    let path = moved(p, want.path);
    const key = p.keys.get(want.path);
    if (key !== undefined) {
      const member = at(json, want.path);
      const keyType = memberKeyType(walk, c.type, json, want.path);
      if (member !== undefined && keyType !== undefined && walk.stringViolation(keyType, member.key) === want.code) path = key;
    }
    const outcome = { accepted: false as const, path, code: want.code };
    out.push({ case: { ...c, bytes: bytes(text), strict: outcome, report: outcome }, marks: movedMarks, origin });
    if (CONSTRAINTS.has(want.code) && own.length === 0) {
      const miss = structureFirst(c, p);
      if (miss !== undefined) out.push({ case: miss, marks: [], origin: new Map() });
    }
  }
  return out;
}

/** The codes of constraints, which decoders check once the structure of the whole value holds. */
const CONSTRAINTS: ReadonlySet<string> = new Set(["too_short", "too_long", "too_small", "too_large", "not_multiple_of", "pattern_mismatch", "bad_format", "not_unique"]);

/**
 * An invalid case that fails a constraint, with a third key in the first entry of its first map
 * read from entries, outside any untagged union: the unknown key is a problem of the structure,
 * so it is the first error wherever the constraint is.
 */
function structureFirst(c: Case, p: Projected): Case | undefined {
  for (const e of p.entries) {
    if (e.inUnion) continue;
    const list = get(p.payload, e.path);
    if (!Array.isArray(list) || !(list[0] instanceof Map)) continue;
    const entry = `${e.path}/0`;
    const third = changed(p.payload, entry, (v) => (v instanceof Map ? new Map([...v, ["note", "x"]]) : v));
    return llmMiss(c, `a third key in the entry at ${entry}, which fails before the ${c.strict.accepted ? "" : c.strict.code}`, writeJson(third), `${entry}/note`, "unknown_key");
  }
  return undefined;
}

/** A near miss of a case's LLM form, with the error it must give. */
function llmMiss(c: Case, change: string, text: string, path: string, code: string): Case {
  const outcome = { accepted: false as const, path, code };
  return { id: `${c.id} (llm: ${change})`, type: c.type, valid: false, bytes: bytes(text), strict: outcome, report: outcome };
}

/** The near misses of what only the LLM form of a valid case has. `first` adds those one case per type is enough for. */
function misses(c: Case, p: Projected, text: string, first: boolean): Case[] {
  const out: Case[] = [];
  const root = p.payload;
  const wrapped = root instanceof Map && p.paths.get("") === `/${WRAP_KEY}`;
  if (wrapped) {
    const inner = root.get(WRAP_KEY) ?? null;
    out.push(llmMiss(c, "no value key", "{}", `/${WRAP_KEY}`, "missing_key"));
    out.push(llmMiss(c, "a key beside value", writeJson(new Map<string, Json>([[WRAP_KEY, inner], ["extra", new JsonNumber("1")]])), "/extra", "unknown_key"));
    out.push(
      llmMiss(
        c,
        "the value without the object around it",
        writeJson(inner),
        inner instanceof Map ? `/${WRAP_KEY}` : "",
        inner instanceof Map ? "missing_key" : inner === null ? "null_not_allowed" : "wrong_type",
      ),
    );
  }
  for (const e of p.entries) {
    if (e.inUnion) continue;
    const list = get(root, e.path);
    if (!Array.isArray(list)) continue;
    out.push(llmMiss(c, `a string for the entries at ${e.path}`, writeJson(changed(root, e.path, () => "text")), e.path, "wrong_type"));
    const first0 = list[0];
    if (!(first0 instanceof Map)) continue;
    const entry = `${e.path}/0`;
    const again = changed(root, e.path, (v) => (Array.isArray(v) ? [...v, first0] : v));
    out.push(llmMiss(c, `the first entry at ${e.path} again`, writeJson(again), `${e.path}/${String(list.length)}/key`, "duplicate_key"));
    out.push(llmMiss(c, `no key in the entry at ${entry}`, writeJson(changed(root, `${entry}/key`, () => undefined)), `${entry}/key`, "missing_key"));
    out.push(llmMiss(c, `no value in the entry at ${entry}`, writeJson(changed(root, `${entry}/value`, () => undefined)), `${entry}/value`, "missing_key"));
    const third = changed(root, entry, (v) => (v instanceof Map ? new Map([...v, ["note", "x"]]) : v));
    out.push(llmMiss(c, `a third key in the entry at ${entry}`, writeJson(third), `${entry}/note`, "unknown_key"));
    out.push(llmMiss(c, `a number for the key at ${entry}`, writeJson(changed(root, `${entry}/key`, () => new JsonNumber("12"))), `${entry}/key`, "wrong_type"));
    out.push(llmMiss(c, `an array for the entry at ${entry}`, writeJson(changed(root, entry, () => [])), entry, "wrong_type"));
  }
  if (first && root instanceof Map && root.size > 0) {
    // Text that is cut short fails while the root object is read; every payload is an object.
    out.push(llmMiss(c, "the last character cut off", text.slice(0, -1), "", "invalid_json"));
    const [k, v] = [...root][0] ?? ["", null];
    const twice = `{${JSON.stringify(k)}:${writeJson(v)},${text.slice(1)}`;
    out.push(llmMiss(c, `the key ${JSON.stringify(k)} twice`, twice, segment(k), "duplicate_key"));
  }
  return out;
}

function get(root: Json, path: string): Json | undefined {
  let current: Json | undefined = root;
  for (const s of path === "" ? [] : path.slice(1).split("/").map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (Array.isArray(current)) current = current[Number(s)];
    else if (current instanceof Map) current = current.get(s);
    else return undefined;
  }
  return current;
}

/** A copy of root with the value at path changed, or removed when `change` gives undefined. */
function changed(root: Json, path: string, change: (value: Json) => Json | undefined): Json {
  const parts = path === "" ? [] : path.slice(1).split("/").map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"));
  const [head, ...rest] = parts;
  if (head === undefined) return change(root) ?? null;
  const tail = rest.map((s) => segment(s)).join("");
  if (Array.isArray(root)) return root.map((item, i) => (String(i) === head ? changed(item, tail, change) : item));
  if (!(root instanceof Map)) return root;
  const out = new Map<string, Json>();
  for (const [k, v] of root) {
    if (k !== head) out.set(k, v);
    else if (rest.length > 0) out.set(k, changed(v, tail, change));
    else {
      const next = change(v);
      if (next !== undefined) out.set(k, next);
    }
  }
  return out;
}
