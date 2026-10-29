/**
 * Turns a schema name, title or enum value into PascalCase, like `cardPayment`
 * to `CardPayment`, `sans-serif` to `SansSerif` and `GET` to `Get`. Returns an
 * empty string when there are no letters or digits.
 */
export function pascal(text: string): string {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => {
      const shouted = word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
      const rest = shouted ? word.slice(1).toLowerCase() : word.slice(1);
      return word.charAt(0).toUpperCase() + rest;
    })
    .join("");
}

/**
 * Names a variant from a JSON value, like `_blank` to `Blank`. Names that would
 * start with a digit, be empty, or clash with a reserved word get a fixed fix:
 * `419` becomes `V419`, `""` becomes `Empty` and `_self` becomes `SelfValue`.
 */
export function variantName(value: string): string {
  const name = pascal(value);
  if (name === "") return "Empty";
  if (/^[0-9]/.test(name)) return `V${name}`;
  if (name === "Self") return "SelfValue";
  return name;
}

/** Splits a space separated word list into a set. */
function words(text: string): ReadonlySet<string> {
  return new Set(text.split(" "));
}

/**
 * Rust keywords: strict, reserved and edition 2024 ones. A field named like one is written as a
 * raw identifier (`r#type`), except the {@link RUST_NOT_RAW} ones. A type named like one fails.
 */
export const RUST_KEYWORDS = words(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut " +
    "pub ref return self Self static struct super trait true type unsafe use where while async await dyn " +
    "abstract become box do final gen macro override priv try typeof unsized virtual yield",
);

/** Rust keywords that can't be raw identifiers. A field named like one gets a trailing `_`. */
export const RUST_NOT_RAW = words("crate self super Self");

/**
 * Crates and standard library roots the generated Rust names by path, like `serde::Serialize`.
 * A module named like one would shadow them.
 */
export const RUST_CRATE_ROOTS = words("serde serde_json std core alloc");

/**
 * Go keywords. Generated Go type and field names are exported, so they start with a capital
 * letter and are never a keyword. Type names are checked against the list anyway.
 */
export const GO_KEYWORDS = words(
  "break case chan const continue default defer else fallthrough for func go goto if import " +
    "interface map package range return select struct switch type var",
);

/**
 * TypeScript reserved words, strict mode reserved words and the built in type names, none of
 * which can name a type. A property named like one needs no escaping: TypeScript takes any
 * identifier, keywords included, as a property name, so `default?: boolean` compiles.
 */
export const TS_RESERVED = words(
  "break case catch class const continue debugger default delete do else enum export extends false " +
    "finally for function if import in instanceof new null return super switch this throw true try " +
    "typeof var void while with implements interface let package private protected public static " +
    "yield any unknown never object string number boolean symbol bigint undefined",
);

/** The hint for a type name that is reserved in one language. */
export const RENAME_TYPE =
  "rename the $defs entry, or the schema's title, so the type gets another name";
