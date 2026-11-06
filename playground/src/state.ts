/**
 * The playground's state, and how it is shared: compressed into the URL fragment, which the
 * browser never sends to a server. Reading a fragment is bounded in size and checks every field,
 * so a broken or hostile link fails with one clean message.
 */
import type { Decoder, ReadMode } from "./decode.js";

/** The built in LLM profiles the playground offers, in the order the CLI lists them. */
export const PROFILES = ["anthropic", "gemini", "openai"] as const;

/** One schema file of the playground. */
export interface SchemaText {
  readonly name: string;
  readonly text: string;
}

/** Everything the playground shows is worked out from this. */
export interface State {
  readonly schemas: readonly SchemaText[];
  readonly read: ReadMode;
  /** The LLM profiles, each one of {@link PROFILES}, in that order. */
  readonly profiles: readonly string[];
  readonly cleanup: boolean;
  /** `targets.rust.serdeBridge`. */
  readonly serdeBridge: boolean;
  /** The ID rule, or null for none. */
  readonly ids: { readonly file: string; readonly suffix: string } | null;
  /** The type the payload is decoded as, by its name in the generated code. */
  readonly type: string;
  readonly decoder: Decoder;
  readonly payload: string;
}

/** The fragment's version prefix. A later format gets a new one. */
export const FRAGMENT_PREFIX = "v1.";
/** The longest fragment read, in characters. */
export const MAX_FRAGMENT = 400_000;
/** The most bytes a fragment may decompress to. */
export const MAX_STATE_BYTES = 2_000_000;
/** The most schema files a state may hold. */
export const MAX_SCHEMAS = 64;

/** A fragment that can't be read. Its message is one line, fit to show. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A schema file name: lowercase letters, digits and dashes, then `.json`, as `$ref`s can name them. */
export const SCHEMA_NAME = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
/** A type name as the generated code writes it. */
const TYPE_NAME = /^([A-Z][A-Za-z0-9]{0,127})?$/;

/** Checks a parsed state, field by field. Throws a {@link StateError}. */
export function checkState(value: unknown): State {
  const fail = (what: string): never => {
    throw new StateError(`the link's state is broken: ${what}`);
  };
  if (!isObject(value)) return fail("not an object");
  const known = ["schemas", "read", "profiles", "cleanup", "serdeBridge", "ids", "type", "decoder", "payload"];
  for (const key of Object.keys(value)) if (!known.includes(key)) fail(`unknown field ${JSON.stringify(key)}`);
  const { schemas, read, profiles, cleanup, serdeBridge, ids, type, decoder, payload } = value;
  if (!Array.isArray(schemas) || schemas.length === 0 || schemas.length > MAX_SCHEMAS) {
    fail(`schemas must list 1 to ${String(MAX_SCHEMAS)} files`);
  }
  const files = (schemas as unknown[]).map((s, i): SchemaText => {
    if (!isObject(s) || Object.keys(s).length !== 2 || typeof s.name !== "string" || typeof s.text !== "string") {
      return fail(`schemas[${String(i)}] must be {"name", "text"}`);
    }
    if (!SCHEMA_NAME.test(s.name)) fail(`schemas[${String(i)}] has a bad file name`);
    return { name: s.name, text: s.text };
  });
  if (new Set(files.map((f) => f.name)).size !== files.length) fail("two schema files have the same name");
  if (read !== "strict" && read !== "report") fail('read must be "strict" or "report"');
  if (!Array.isArray(profiles) || !profiles.every((p) => typeof p === "string")) fail("profiles must be a list of names");
  const listed = profiles as string[];
  const ordered = PROFILES.filter((p) => listed.includes(p));
  if (ordered.length !== listed.length || ordered.some((p, i) => listed[i] !== p)) {
    fail(`profiles must be some of ${PROFILES.join(", ")}, in that order, each once`);
  }
  if (typeof cleanup !== "boolean") fail("cleanup must be true or false");
  if (typeof serdeBridge !== "boolean") fail("serdeBridge must be true or false");
  let rule: State["ids"] = null;
  if (ids !== null) {
    if (!isObject(ids) || Object.keys(ids).length !== 2 || typeof ids.file !== "string" || typeof ids.suffix !== "string") {
      return fail('ids must be null or {"file", "suffix"}');
    }
    if (ids.file === "" || ids.suffix === "" || ids.file.length > 64 || ids.suffix.length > 64) fail("ids has an empty or long field");
    rule = { file: ids.file, suffix: ids.suffix };
  }
  if (typeof type !== "string" || !TYPE_NAME.test(type)) fail("type must be a type name");
  if (decoder !== "normal" && decoder !== "llm") fail('decoder must be "normal" or "llm"');
  if (typeof payload !== "string") fail("payload must be a string");
  return {
    schemas: files,
    read: read as ReadMode,
    profiles: ordered,
    cleanup: cleanup as boolean,
    serdeBridge: serdeBridge as boolean,
    ids: rule,
    type: type as string,
    decoder: decoder as Decoder,
    payload: payload as string,
  };
}

/** The state as JSON, its fields in a fixed order. */
function stateJson(state: State): string {
  return JSON.stringify({
    schemas: state.schemas.map((s) => ({ name: s.name, text: s.text })),
    read: state.read,
    profiles: state.profiles,
    cleanup: state.cleanup,
    serdeBridge: state.serdeBridge,
    ids: state.ids === null ? null : { file: state.ids.file, suffix: state.ids.suffix },
    type: state.type,
    decoder: state.decoder,
    payload: state.payload,
  });
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new StateError(`the link's state is larger than ${String(limit)} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return readAll(stream, Number.MAX_SAFE_INTEGER);
}

async function inflate(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  try {
    return await readAll(stream, limit);
  } catch (error) {
    if (error instanceof StateError) throw error;
    throw new StateError("the link's state is not compressed data");
  }
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  if (!BASE64URL.test(text) || text.length % 4 === 1) throw new StateError("the link's state is not base64url");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The URL fragment, without `#`, that holds `state`. */
export async function encodeState(state: State): Promise<string> {
  const bytes = new TextEncoder().encode(stateJson(checkState(JSON.parse(stateJson(state)))));
  return FRAGMENT_PREFIX + toBase64url(await deflate(bytes));
}

/**
 * The state a URL fragment, without `#`, holds. Throws a {@link StateError} for a fragment that
 * is too long, isn't this format, decompresses past {@link MAX_STATE_BYTES}, or holds anything but
 * a valid state.
 */
export async function decodeState(fragment: string): Promise<State> {
  if (fragment.length > MAX_FRAGMENT) throw new StateError(`the link is longer than ${String(MAX_FRAGMENT)} characters`);
  if (!fragment.startsWith(FRAGMENT_PREFIX)) throw new StateError("the link's state is not in a format this page reads");
  const bytes = await inflate(fromBase64url(fragment.slice(FRAGMENT_PREFIX.length)), MAX_STATE_BYTES);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new StateError("the link's state is not UTF-8 text");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new StateError("the link's state is not JSON");
  }
  return checkState(value);
}
