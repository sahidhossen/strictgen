# Command line and config

## Config

A `strictgen.json` at the project root drives everything. Paths are relative to it, and only the targets you list are generated:

```json
{
  "$schema": "https://raw.githubusercontent.com/sahidhossen/strictgen/main/strictgen.schema.json",
  "schemas": "schemas",
  "targets": {
    "rust": { "out": "rust/src/generated" },
    "go": { "out": "go/types", "package": "types", "fixtures": true },
    "typescript": { "out": "src/generated" }
  }
}
```

[`strictgen.schema.json`](../strictgen.schema.json) documents every option and its default. The npm package ships it, so with strictgen installed, `"$schema": "./node_modules/strictgen/strictgen.schema.json"` gives an editor the schema of the version you use, without a network request. [`examples/basic`](../examples/basic) has a full example, [`examples/report`](../examples/report) one in report mode, and [`examples/llm`](../examples/llm) one with LLM provider schemas and the cleanup step.

### Each language

- **Rust.** Types implement a `Decode` trait, so `User::from_json(text)` decodes strictly. Generated Rust depends on `serde` and `serde_json`, and also on the `regex` crate when a schema uses `pattern` ([error-codes.md](error-codes.md#patterns)). `"serdeBridge": true` also gives the types serde's `Deserialize`, running the same strict decoder, so they can sit inside your own serde types. Plain aliases of standard types, like `Vec<String>`, can't get the impl and use serde's own, which is not strict; `generate` lists them in a notice ([serde-bridge.md](serde-bridge.md))
- **Go.** `json.Unmarshal` into a generated type decodes strictly, and `DecodeX` decodes a tagged union. Only the standard library is used
- **TypeScript.** Strict decoders sit next to the types, `decodeXFromJson`, `decodeX`, `encodeX` and their variants, unless `"decoders": false`. [typescript.md](typescript.md) explains them and their number limits
- **Fixtures.** Neither Rust nor Go writes a fixture registry for tests unless asked: Go takes `"fixtures": true`, Rust takes `"fixtures": { "out": "...", "crate": "..." }`

All three report the same decode errors ([error-codes.md](error-codes.md)). Each target reads in `strict` mode by default, failing on unknown keys. With `"read": "report"` it accepts them and reports their paths, through one hook and the report functions, with the same paths in every language ([read-modes.md](read-modes.md)).

### LLM output

With `"llm": { "profiles": ["openai", "anthropic", "gemini"], "out": "llm" }`, strictgen also writes, per type, the schema each LLM provider accepts for structured output, projected from the real one. Optional fields become nullable, unions become `anyOf`, and constraints a provider doesn't accept move into the description and the decoder.

Each language gets an LLM decoder per type: `decodeXFromLlm`, `DecodeXFromLlm` and `decode_x_from_llm`. It reads what the model sends back, maps it to the real type (`null` back to absent) and checks every constraint, with errors in the compact form, ready to send back to the model. Profiles are data files, and a path in `llm.profiles` can replace one. `"cleanup": true` adds a helper to every language that removes a code fence, a byte order mark and trailing commas from model output, and nothing else; the LLM decoders run it first ([llm.md](llm.md)).

## Command line

```bash
strictgen                 # same as strictgen generate
strictgen generate        # write every target, formatted
strictgen check           # exit 1 if the generated files on disk are out of date, for CI
strictgen dirs [--json]   # print the folders the targets write to
strictgen explain user.json#/$defs/address   # show how one type maps in each language
strictgen fix [--write]   # rewrite the schemas into the supported subset, as a diff or in place
strictgen examples Order --count 3 [--invalid] [--seed 7] [--array]   # print sample payloads
strictgen docs [--format markdown|html]   # write a page per type into docs.out
strictgen breaking --base main   # list changes since main and who each one breaks
strictgen llm --profile openai Order         # print the provider-ready schema of one type
```

Every command takes `--config <path>` to read a config other than `strictgen.json` in the current folder, and `--help`. `strictgen --version` prints the version.

Exit codes: `0` success, `1` generation failed, `check` found a difference or `breaking` found a breaking change, `2` bad usage or a config error. Errors name the file, and the option or JSON pointer, with one line per problem.

A schema the generator can't map fails with its location, a stable rule id, the reason and, when there is an obvious fix, a hint. The rule ids, like `open-object`, `unsupported-keyword` or `union-tag`, don't change between releases. `RULES` in the package lists every one with a one line summary, and [schemas.md](schemas.md#generation-rules) has each with an example and its fix.

### Formatters

`generate` runs `rustfmt` on the Rust output and `gofmt` on the Go output, in memory, and writes only when every file formatted cleanly. Turn either off with `"format": { "rust": "none", "go": "none" }`. TypeScript output is not formatted. A formatter that isn't installed, or a `rustfmt` whose `--version` fails (a rustup proxy without the component), is skipped with a notice. One that fails, prints nothing, prints something that doesn't start with the generated header, or runs longer than 60 seconds stops with exit code 1 and its output, and nothing is written.

`check` formats in memory the same way before comparing, so it needs every configured formatter installed and fails without one. To give the same result on every machine, `rustfmt` runs with its defaults and edition 2024 and ignores any `rustfmt.toml`, and both formatters read the file on stdin.

### `breaking`

`strictgen breaking --base <ref or folder>` compares the schemas with an older version and lists every change by who it breaks: all consumers, strict consumers only (an added optional field, which `report` mode accepts), producers, or nobody. The comparison runs on the generated model, so renaming a def or an internal name doesn't show, and each change has its JSON pointer in both versions. A ref is read from the repository without a checkout. It exits 1 when anything breaks; `--json` prints a stable form for CI. [breaking-changes.md](breaking-changes.md) has the full rule table.

### `dirs`

`strictgen dirs` prints one folder per line, relative to the current folder, in config order: Rust (and its fixture folder), Go, TypeScript. strictgen clears an owned folder before writing. In a shared folder, like a Go package with hand written tests, it only replaces the files it generated. `--json` prints them as `{ "target", "dir", "shared" }` objects.

### `explain`

`strictgen explain <file.json#/pointer>` shows how one type maps: its model (a struct and its fields, an enum and its values, a union and its branches), then its declaration in Rust, Go and TypeScript, for the targets the config lists only, formatted the way `generate` writes it. Give `user.json` alone for a schema's root type. When a configured formatter isn't installed, the heading says the code is unformatted.

In [`examples/quickstart`](../examples/quickstart):

<!-- snippet: command examples/quickstart explain order.json#/$defs/status -->
```text
$ strictgen explain order.json#/$defs/status
order.json#/$defs/status

Model:
  enum Status: "pending", "paid", "shipped"

Rust:
/// Where the order is.
///
/// Schema: `order.json#/$defs/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Status {
    /// `pending`
    #[serde(rename = "pending")]
    Pending,
    /// `paid`
    #[serde(rename = "paid")]
    Paid,
    /// `shipped`
    #[serde(rename = "shipped")]
    Shipped,
}

impl Status {
    /// The value as it is in JSON.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Paid => "paid",
            Self::Shipped => "shipped",
        }
    }
}

/// Orders by the JSON value, by code point, so a map keyed by the enum encodes its keys in
/// the order Go and TypeScript write them.
impl Ord for Status {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.as_str().cmp(other.as_str())
    }
}

impl PartialOrd for Status {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl helpers::Decode for Status {
    fn decode_node(node: &helpers::Node<'_>) -> Result<Self, helpers::DecodeError> {
        match helpers::string(node)? {
            "pending" => Ok(Self::Pending),
            "paid" => Ok(Self::Paid),
            "shipped" => Ok(Self::Shipped),
            other => Err(helpers::not_in_enum(other, &["pending", "paid", "shipped"])),
        }
    }
}

/// Reads the JSON text a model gave for a provider-ready schema of `Status`.
/// It undoes the projection: null for an optional key is absent, and a map is read in the
/// shapes the profiles give.
/// The type isn't an object, so the schema wraps it, and it is read from the "value" key.
/// Then every constraint of the type is checked.
///
/// # Errors
///
/// A `DecodeError` at the JSON Pointer of the first problem in the model's payload, whose
/// compact form is made for asking the model to retry.
pub fn decode_status_from_llm(text: &str) -> Result<Status, helpers::DecodeError> {
    helpers::from_llm(text, true)
}

Go:
// Status is generated from order.json#/$defs/status.
//
// Where the order is.
type Status string

// Values of Status.
const (
	// StatusPending is "pending".
	StatusPending Status = "pending"
	// StatusPaid is "paid".
	StatusPaid Status = "paid"
	// StatusShipped is "shipped".
	StatusShipped Status = "shipped"
)

// MarshalText fails on a value the type doesn't list, so it is never written.
func (v Status) MarshalText() ([]byte, error) {
	return encodeEnum(v, StatusPending, StatusPaid, StatusShipped)
}

// UnmarshalJSON fails on a value the type doesn't list.
func (v *Status) UnmarshalJSON(data []byte) error { return unmarshal(data, v) }

func (v *Status) decode(n *node) *DecodeError {
	return decodeEnum(n, v, StatusPending, StatusPaid, StatusShipped)
}

// DecodeStatusFromLlm reads the JSON text a model gave for a provider-ready schema of Status.
// It undoes the projection: null for an optional key is absent, and a map is read in the
// shapes the profiles give.
// The type isn't an object, so the schema wraps it, and it is read from the "value" key.
// Then every constraint of the type is checked. The error is a *DecodeError at the JSON Pointer
// of the first problem in the model's payload, whose Compact form is made for asking the model
// to retry.
func DecodeStatusFromLlm(data []byte) (Status, error) {
	return decodeLlm(data, true, decodeType[Status])
}

TypeScript:
/** Where the order is. */
export type Status = "pending" | "paid" | "shipped";

/**
 * Decodes parsed JSON as Status, strictly. Throws a DecodeError at the JSON Pointer of
 * the first problem, under `path` when given.
 */
export function decodeStatus(json: unknown, path = ""): Status {
  return h.enumValue(json, path, ["pending", "paid", "shipped"] as const);
}

/** Like decodeStatus, but returns the DecodeError instead of throwing it. */
export function tryDecodeStatus(json: unknown): h.DecodeResult<Status> {
  return h.attempt(decodeStatus, json);
}

/**
 * Reads JSON text as Status, strictly. Throws a DecodeError for text that is not JSON, or
 * not JSON Rust and Go read, like a key given twice or 12.0 for an integer, and for a value
 * that doesn't fit, at the JSON Pointer of the first problem.
 */
export function decodeStatusFromJson(text: string): Status {
  return h.fromJson(text, decodeStatus);
}

/** Like decodeStatusFromJson, but returns the DecodeError instead of throwing it. */
export function tryDecodeStatusFromJson(text: string): h.DecodeResult<Status> {
  return h.attemptJson(decodeStatus, text);
}

/**
 * Encodes Status as a JSON value, ready for JSON.stringify.
 * Throws an EncodeError for a value Rust and Go could not hold, like an unknown key.
 */
export function encodeStatus(value: Status): unknown {
  return h.encodeEnum(value, ["pending", "paid", "shipped"] as const);
}

/**
 * Encodes Status as JSON text, keys in the order Rust and Go write them.
 * Throws an EncodeError like encodeStatus.
 */
export function encodeStatusToJson(value: Status): string {
  return h.toJson(encodeStatus(value));
}

/**
 * Reads the JSON text a model gave for a provider-ready schema of Status, and undoes the
 * projection: null for an optional key is absent, and a map is read in the shapes the
 * profiles give.
 * The type isn't an object, so the schema wraps it, and it is read from the "value" key.
 * Then every constraint of the type is checked. Throws a DecodeError at the JSON Pointer of
 * the first problem in the model's payload, whose compact form is made for asking the model to
 * retry.
 */
export function decodeStatusFromLlm(text: string): Status {
  return h.fromLlm(text, h.unwrapped(decodeStatus));
}

/** Like decodeStatusFromLlm, but returns the DecodeError instead of throwing it. */
export function tryDecodeStatusFromLlm(text: string): h.DecodeResult<Status> {
  return h.attemptText(decodeStatusFromLlm, text);
}
```
<!-- /snippet -->

When the type can't be generated, `explain` prints the rule it breaks, the reason and the hint, per language for a name one language reserves, and exits 1. An unknown file or pointer, or one that names no generated type, exits 2. `--json` prints the model and each target's code or error as JSON.

### `fix`

`strictgen fix` rewrites messy schemas into the supported subset; [schemas.md](schemas.md#moving-an-existing-schema-in) walks through an example. Its rules run until nothing changes:

- `close-objects` adds `"additionalProperties": false` to open objects, or `"unevaluatedProperties": false` beside `allOf`, `oneOf`, `anyOf` or `if`. An `allOf` base, an `allOf` part and an `if`/`then` branch stay open. An object with no properties stays open too, since closing it would allow only `{}`
- `tag-unions` turns a `oneOf` whose branches each have a `const` property into a tagged union: the tag becomes required, a one value `enum` becomes a `const`, each branch gets `"type": "object"` and the `oneOf` loses the `"type": "object"` beside it. A branch written as a `$ref` is only reported, since other schemas may use it
- `merge-allof` inlines an `allOf` whose parts are plain schemas (types, properties, required keys, constraints) that don't disagree. When they do, it leaves the `allOf` and says where
- `hoist-defs` turns `definitions` into `$defs`, moves `$defs` written inside a schema up to the root, moves a schema a `$ref` points into, like `#/properties/shipping/properties/address`, into `$defs` under a name taken from its path, like `address` or `shippingAddress` when that is taken, and renames a def a `$ref` can't name, like `order-item` to `orderItem`. Every `$ref` to a moved schema, in any file, follows it

By default it prints a unified diff and writes nothing, so `strictgen fix > fix.patch` gives a patch. `--write` writes the changed files in place instead, even when generation still fails afterwards and the exit code is 1. Only files in the schemas folder are written, and only once every file was rewritten and read back. Each goes to a temporary file first, then all are renamed into place. The renames aren't atomic as a group: if one fails, the error names the files already written. `fix` rejects a schema file with a duplicate key, which generation accepts (it keeps the last value), since a rewrite would drop one of them. A rewritten file keeps its key order, indentation, line endings and the formatting of every part no rule touched. Then `fix` generates every target in memory and prints the first error left, with the file, JSON pointer, rule and hint, and a notice for each thing a rule left as it was. It exits 1 when generation still fails, and 0 when the schemas generate.

### `examples`

`strictgen examples <type>` prints payloads of a type, named as in the generated code, one JSON value per line, or one JSON array with `--array`. They keep every rule and constraint of the schema and hold in the read mode of every configured target. `--count` sets how many (default 1) and `--seed` the seed (default 0): the same seed always gives the same output. `--invalid` prints near misses instead, each a valid payload with one thing changed and the error every decoder must report for it:

<!-- snippet: command examples/quickstart examples Order --invalid --count 3 -->
```text
$ strictgen examples Order --invalid --count 3
{"path":"/status","code":"missing_key","change":"removed the required key \"status\"","payload":{"id":"al","quantity":15,"note":"YxDme"}}
{"path":"","code":"wrong_type","change":"12 in place of the value","payload":12}
{"path":"/id","code":"wrong_type","change":"12 in place of the value","payload":{"id":12,"quantity":15,"status":"paid","note":"YxDme"}}
```
<!-- /snippet -->

Strings for a `pattern` are built from the pattern and kept only when it matches them within the length limits. A type the generator can't make a sure payload for, like a pattern no string matches, or a format longer than `maxLength`, exits 1 with the reason rather than print a payload that may be invalid.

### `docs`

`strictgen docs` writes a Markdown page per type and an `index.md` into the folder `docs.out` names, like `"docs": { "out": "docs/types" }`: the type's description, its type in each configured language, its fields with their constraints, a valid example, and links to the types it uses and that use it. `"format": "html"`, or `--format html`, writes one self-contained `index.html` with every type instead, with no external assets. Schema text is escaped for Markdown and HTML. The folder is shared, like a Go package: strictgen only replaces or removes the files it generated, which start with the header as an HTML comment, so hand-written pages beside them stay.
