/**
 * The one request and result format every conformance driver speaks: the Rust and Go binaries
 * over JSON lines, TypeScript in process. A driver reads many requests per process, so the
 * differential fuzzer can reuse it.
 *
 * A request is one line: `{"id": 0, "type": "Order", "mode": "strict", "decoder": "normal",
 * "entry": "public", "package": "strict", "hex": "7b7d"}`. The input is hex, since a case may be
 * bytes that aren't UTF-8. `package` names the generated code that decodes it, one per read mode
 * and LLM configuration (see {@link packageName}). A result is one line per request, in request
 * order:
 *
 * ```json
 * {"id": 0, "accepted": false, "unknown": null, "encoded": null, "encodeError": null,
 *  "error": {"path": "/id", "code": "missing_key", "expected": null, "found": null, "message": "/id: missing key"}}
 * ```
 *
 * `unknown` is the list of unknown key paths when the value decoded (always empty in strict
 * mode), `encoded` the JSON the value encodes to again, or `encodeError` why it didn't. For the
 * cleanup step, `encoded` is the text it returned.
 */

/** The languages, in the order tables show them. */
export const LANGUAGES = ["rust", "go", "ts"] as const;
export type Language = (typeof LANGUAGES)[number];

/** The read modes of spec section 8. */
export const MODES = ["strict", "report"] as const;
export type Mode = (typeof MODES)[number];

/**
 * Which function reads the input: the normal decoder, the LLM decoder of a provider-ready
 * payload (`decodeXFromLlm`, `DecodeXFromLlm`, `decode_x_from_llm`), or the cleanup step that
 * LLM decoders run first when `llm.cleanup` is on (`cleanLlmJson`, `CleanLLMJSON`,
 * `clean_llm_json`), whose output text a result carries in `encoded`.
 */
export type Decoder = "normal" | "llm" | "cleanup";
export const DECODERS: readonly Decoder[] = ["normal", "llm", "cleanup"];

/**
 * The map shapes the LLM decoders of a generated package read, from the profiles it was
 * generated with: `entries` from a profile that gives maps as `[{key, value}]` (openai),
 * `objects` from one that keeps them as objects (gemini), `both` from all three built in ones.
 */
export type Maps = "entries" | "objects" | "both";
export const MAPS: readonly Maps[] = ["both", "entries", "objects"];

/** How an LLM payload gives its maps: as an array of entries, or as objects. */
export type Shape = "entries" | "objects";

/**
 * Which function decodes: `public`, the entry point users call (Go's `json.Unmarshal` into the
 * type, `DecodeX` for a tagged union, `Report[T]` or `ReportX` in report mode; Rust's
 * `T::from_json` and `T::report_from_json`; TypeScript's `decodeXFromJson` and
 * `reportXFromJson`), or `registry`, the fixture registry the generated tests use. Go's registry
 * calls the shared decoder directly; Rust's and TypeScript's fixture entry points are their public
 * ones, so for them both entries run the same function.
 */
export type Entry = "public" | "registry";
export const ENTRIES: readonly Entry[] = ["public", "registry"];

/**
 * One way of reading a case: a read mode, a decoder and an entry point, and the LLM
 * configuration of the generated code. `maps` is absent for code generated without `llm`, and
 * `shape` gives how the payloads of an LLM decoder give their maps. `vectors` marks the code
 * generated for `examples/llm`, whose shared vectors and cleanup vectors run too.
 */
export interface Variant {
  readonly mode: Mode;
  readonly decoder: Decoder;
  readonly entry: Entry;
  readonly maps?: Maps;
  readonly shape?: Shape;
  readonly vectors?: true;
}

/**
 * A variant as tables show it, like `strict`, `report/registry`, `strict/with-llm` for the
 * normal decoder of code generated with `llm`, `report/llm/both:entries` for the LLM decoder of
 * code that reads both map shapes, given entries, or `report/llm/vectors`.
 */
export function variantName(v: Variant): string {
  const parts: string[] = [v.mode];
  if (v.vectors === true) parts.push(v.decoder === "normal" ? "vectors" : `${v.decoder}/vectors`);
  else if (v.decoder === "normal" && v.maps !== undefined) parts.push("with-llm");
  else if (v.decoder !== "normal") {
    parts.push(v.decoder);
    if (v.maps !== undefined) parts.push(v.maps === "both" && v.shape !== undefined ? `both:${v.shape}` : v.maps);
  }
  if (v.entry !== "public") parts.push(v.entry);
  return parts.join("/");
}

/**
 * The generated package a variant's requests decode with: `strict` or `report` for code
 * generated without `llm`, like `strict_llm_both` for code generated with profiles that give
 * those map shapes, and `report_llm_vectors` for `examples/llm`.
 */
export function packageName(v: Variant): string {
  if (v.vectors === true) return `${v.mode}_llm_vectors`;
  return v.maps === undefined ? v.mode : `${v.mode}_llm_${v.maps}`;
}

/** The error code a driver reports when a decoder threw or panicked instead of returning an error. */
export const CRASH = "crash";

/**
 * The error code the Go driver reports when `json.Unmarshal` refused the input with its own
 * `*json.SyntaxError`, before the generated decoder ran.
 */
export const GO_SYNTAX_ERROR = "json.SyntaxError";

export interface Request {
  readonly id: number;
  /** The generated type, by its name in the model, like `Order`. */
  readonly type: string;
  readonly mode: Mode;
  readonly decoder: Decoder;
  readonly entry: Entry;
  /** The generated package that decodes, from {@link packageName}. */
  readonly package: string;
  /** The input bytes, as lowercase hex. */
  readonly hex: string;
}

/** The five fields of a decode error, the same in every language. Absent fields are null. */
export interface ErrorFields {
  readonly path: string;
  readonly code: string;
  readonly expected: string | null;
  readonly found: string | null;
  readonly message: string;
}

export interface Result {
  readonly id: number;
  readonly accepted: boolean;
  /** Set when the input was rejected. */
  readonly error: ErrorFields | null;
  /** The unknown key paths, in input order, when the input was accepted. */
  readonly unknown: readonly string[] | null;
  /** The JSON the decoded value encodes to, when it was accepted and encoded. */
  readonly encoded: string | null;
  /** Why the decoded value failed to encode. */
  readonly encodeError: string | null;
}

/** A driver that broke the protocol, crashed or couldn't be built. */
export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriverError";
  }
}

/** The request line a binary driver reads. */
export function requestLine(request: Request): string {
  return JSON.stringify({
    id: request.id,
    type: request.type,
    mode: request.mode,
    decoder: request.decoder,
    entry: request.entry,
    package: request.package,
    hex: request.hex,
  });
}

const RESULT_KEYS = ["accepted", "encodeError", "encoded", "error", "id", "unknown"];
const ERROR_KEYS = ["code", "expected", "found", "message", "path"];

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const isTextOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

/**
 * Reads one result line of `language`, checking every field: a driver that writes anything
 * else is broken, and the run stops rather than compare half a result.
 */
export function parseResult(line: string, language: Language, id: number): Result {
  const broken = (why: string): never => {
    throw new DriverError(`the ${language} driver wrote a bad result for request ${String(id)}: ${why}`);
  };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return broken("not JSON");
  }
  if (!isObject(value) || !exactKeys(value, RESULT_KEYS)) return broken(`expected the keys ${RESULT_KEYS.join(", ")}`);
  const { accepted, error, unknown, encoded, encodeError } = value;
  if (value.id !== id) return broken(`it has id ${JSON.stringify(value.id)}`);
  if (typeof accepted !== "boolean") return broken("accepted is not a boolean");
  if (!isTextOrNull(encoded) || !isTextOrNull(encodeError)) return broken("encoded and encodeError are strings or null");
  if (accepted) {
    if (error !== null) return broken("an accepted input has an error");
    if (!Array.isArray(unknown) || !unknown.every(isText)) return broken("an accepted input needs a list of unknown paths");
    if ((encoded === null) === (encodeError === null)) return broken("an accepted input has one of encoded and encodeError");
    return { id, accepted, error: null, unknown, encoded, encodeError };
  }
  if (unknown !== null || encoded !== null || encodeError !== null) return broken("a rejected input has only an error");
  if (!isObject(error) || !exactKeys(error, ERROR_KEYS)) return broken(`the error needs the keys ${ERROR_KEYS.join(", ")}`);
  const { path, code, expected, found, message } = error;
  if (!isText(path) || !isText(code) || !isText(message) || !isTextOrNull(expected) || !isTextOrNull(found)) {
    return broken("path, code and message are strings, expected and found strings or null");
  }
  return { id, accepted, error: { path, code, expected, found, message }, unknown: null, encoded: null, encodeError: null };
}
