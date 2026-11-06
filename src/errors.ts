/**
 * The decode errors every language reports: one shape, one list of codes and one message
 * text, defined here once. The emitters write this table into the generated helpers, so the
 * languages can't drift apart. docs/error-codes.md describes the same rules for users.
 *
 * An error is `{ path, code, expected?, found? }`. Its message is
 * `<path>: <title>, expected <expected>, found <found>`, leaving out the path when it is the
 * whole input and each field that is absent. Its compact form is the same with the code in
 * place of the title and a space after the path: `/items/2/price too_small, expected >= 0,
 * found -5`.
 */

/** One error code. */
export interface ErrorCodeInfo {
  /** The code, like `unknown_key`. Codes are public API: changing one is a major version. */
  readonly code: string;
  /** The words for the code in a message, like `unknown key`. */
  readonly title: string;
  /** When it is reported, for the generated doc comments. */
  readonly doc: string;
}

/** Every code, in the order the docs list them. */
export const ERROR_CODES: readonly ErrorCodeInfo[] = [
  { code: "unknown_key", title: "unknown key", doc: "a key the type doesn't name, at the key's path" },
  { code: "missing_key", title: "missing key", doc: "a required key that is absent, at the key's path" },
  {
    code: "null_not_allowed",
    title: "null not allowed",
    doc: "null where the type doesn't take it, like for an optional key",
  },
  { code: "wrong_type", title: "wrong type", doc: "a value of another JSON type, or a fraction for an integer" },
  { code: "bad_tag", title: "bad tag", doc: "a tag that no branch of a tagged union has, at the tag's path" },
  { code: "not_in_enum", title: "not in enum", doc: "a string the enum doesn't list" },
  { code: "not_const", title: "not const", doc: "a value other than the const" },
  { code: "too_short", title: "too short", doc: "a string or array shorter than its minimum" },
  { code: "too_long", title: "too long", doc: "a string or array longer than its maximum" },
  { code: "too_small", title: "too small", doc: "a number below its minimum" },
  { code: "too_large", title: "too large", doc: "a number above its maximum" },
  { code: "pattern_mismatch", title: "pattern mismatch", doc: "a string that doesn't match its pattern" },
  { code: "bad_format", title: "bad format", doc: "a string that isn't in its format, like date-time" },
  { code: "not_unique", title: "not unique", doc: "an array whose items must be unique, with a repeat" },
  {
    code: "out_of_range_integer",
    title: "out of range integer",
    doc: "an integer the language can't hold exactly",
  },
  {
    code: "invalid_json",
    title: "invalid JSON",
    doc: "text that isn't JSON: a syntax error, invalid UTF-8, a lone surrogate, data after the value or a number out of range",
  },
  { code: "duplicate_key", title: "duplicate key", doc: "an object that gives the same key twice, at the key's path" },
  { code: "too_deep", title: "too deep", doc: "a value inside 128 or more arrays and objects" },
];

/** Strings in `found` are cut to this many code points, followed by `...`. */
export const FOUND_MAX = 64;

/** The deepest nesting readers take: a value inside this many arrays and objects fails. */
export const MAX_DEPTH = 128;

/** A code as a constant name, like `UnknownKey`, with `Json` spelled `JSON` when `go` is set. */
export function codeName(code: string, go: boolean): string {
  return code
    .split("_")
    .map((part) => (go && part === "json" ? "JSON" : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join("");
}
