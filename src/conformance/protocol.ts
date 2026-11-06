/**
 * The one request and result format every conformance driver speaks: the Rust and Go binaries
 * over JSON lines, TypeScript in process. A driver reads many requests per process, so the
 * differential fuzzer can reuse it.
 *
 * A request is one line: `{"id": 0, "type": "Order", "mode": "strict", "decoder": "normal",
 * "hex": "7b7d"}`. The input is hex, since a case may be bytes that aren't UTF-8. A result is
 * one line per request, in request order:
 *
 * ```json
 * {"id": 0, "accepted": false, "unknown": null, "encoded": null, "encodeError": null,
 *  "error": {"path": "/id", "code": "missing_key", "expected": null, "found": null, "message": "/id: missing key"}}
 * ```
 *
 * `unknown` is the list of unknown key paths when the value decoded (always empty in strict
 * mode), `encoded` the JSON the value encodes to again, or `encodeError` why it didn't.
 */

/** The languages, in the order tables show them. */
export const LANGUAGES = ["rust", "go", "ts"] as const;
export type Language = (typeof LANGUAGES)[number];

/** The read modes of spec section 8. */
export const MODES = ["strict", "report"] as const;
export type Mode = (typeof MODES)[number];

/**
 * Which decoder reads the input: the normal one, or the LLM decoder of a provider-ready
 * payload. Only the normal decoder runs yet; the drivers refuse the others.
 */
export type Decoder = "normal" | "llm";
export const DECODERS: readonly Decoder[] = ["normal"];

/** The error code a driver reports when a decoder threw or panicked instead of returning an error. */
export const CRASH = "crash";

export interface Request {
  readonly id: number;
  /** The generated type, by its name in the model, like `Order`. */
  readonly type: string;
  readonly mode: Mode;
  readonly decoder: Decoder;
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
