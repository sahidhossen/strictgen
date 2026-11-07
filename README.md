# strictgen

**One JSON Schema. Rust, Go and TypeScript that accept and reject exactly the same JSON, and never drop data silently.**

> **Status:** early development. Nothing is released yet, and the interface may change.

## Why

In August 2026, a pull request to the dstack SDKs described a bug in the [compose hash](https://github.com/Dstack-TEE/dstack/pull/1024), the hash that identifies an app. For the same document, the Go SDK computed a different hash than the JavaScript and Python SDKs. Go's `encoding/json` escaped `<`, `>` and `&`, which JavaScript and Python write as they are, and it marshalled a fixed struct, so keys the struct didn't declare were gone before hashing. In the words of the pull request, "the SDK registers one hash, the guest measures another, attestation fails with nothing pointing at the cause". A [follow-up fix](https://github.com/Dstack-TEE/dstack/pull/1479) for U+2028 and U+2029, which Go escapes even with HTML escaping off, was merged in October.

Nothing crashed. Each language read the same JSON a little differently, and data changed quietly. That is the bug strictgen is built to rule out.

## What it does

- **One schema, three languages.** A strict subset of JSON Schema 2020-12 becomes types and decoders in Rust, Go and TypeScript. Use two of them or all three
- **Never silent.** An unknown key fails the decode, or in `report` mode is reported with its path. No mode drops it
- **Same answer everywhere.** The same accept or reject, the same JSON Pointer, error code and message, and the same bytes when a value is written again, through the generated `Encode` in Go. Only a number with a fraction or an exponent, and the key order inside a value of any JSON type, may be spelled differently, with the same canonical (RFC 8785) bytes
- **Proven, not promised.** A conformance suite of hundreds of cases and a differential fuzzer run every language on every pull request and fail on any difference
- **Change safety.** `strictgen breaking` lists who a schema change breaks before it merges
- **LLM-ready.** The same schema becomes the subset each LLM provider accepts, with decoders that check what the provider couldn't

## 30 seconds

A schema, from [`examples/quickstart`](examples/quickstart):

<!-- snippet: file examples/quickstart/schemas/order.json -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/v1/order.json",
  "title": "Order",
  "description": "An order placed in the shop.",
  "type": "object",
  "properties": {
    "id": { "description": "The order's id.", "type": "string" },
    "quantity": { "description": "How many items.", "type": "integer", "minimum": 1, "maximum": 100 },
    "status": { "$ref": "#/$defs/status" },
    "note": { "description": "A note for the packer.", "type": "string", "maxLength": 40 }
  },
  "required": ["id", "quantity", "status"],
  "additionalProperties": false,
  "$defs": {
    "status": { "description": "Where the order is.", "enum": ["pending", "paid", "shipped"] }
  }
}
```
<!-- /snippet -->

A `strictgen.json` next to it names the targets:

<!-- snippet: file examples/quickstart/strictgen.json -->
```json
{
  "$schema": "../../strictgen.schema.json",
  "schemas": "schemas",
  "targets": {
    "rust": { "out": "rust/src/generated" },
    "go": { "out": "go/types", "package": "types" },
    "typescript": { "out": "ts/generated" }
  },
  "llm": { "profiles": ["openai"], "out": "llm" }
}
```
<!-- /snippet -->

Then one command writes the types and their decoders, formatted with `rustfmt` and `gofmt`:

```bash
strictgen generate   # writes rust/src/generated, go/types, ts/generated and llm/openai
```

In Rust, Go and TypeScript:

<!-- snippet: decl examples/quickstart/rust/src/generated/order.rs Order -->
```rust
/// An order placed in the shop.
///
/// Schema: `order.json#`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    /// The order's id.
    pub id: String,
    /// How many items.
    pub quantity: i64,
    /// The `status` key.
    pub status: Status,
    /// A note for the packer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
```
<!-- /snippet -->

<!-- snippet: decl examples/quickstart/go/types/order.go Order -->
```go
// Order is generated from order.json#.
//
// An order placed in the shop.
type Order struct {
	// The order's id.
	Id string `json:"id"`
	// How many items.
	Quantity int64 `json:"quantity"`
	// The status key.
	Status Status `json:"status"`
	// A note for the packer.
	Note *string `json:"note,omitempty"`
}
```
<!-- /snippet -->

<!-- snippet: decl examples/quickstart/ts/generated/order.ts Order -->
```ts
/** An order placed in the shop. */
export interface Order {
  /** The order's id. */
  id: string;
  /** How many items. */
  quantity: number;
  status: Status;
  /** A note for the packer. */
  note?: string;
}
```
<!-- /snippet -->

Each language decodes with its usual call:

<!-- snippet: region examples/quickstart/rust/src/main.rs decode -->
```rust
let result = match decoder.as_str() {
    "llm" => decode_order_from_llm(&text),
    _ => Order::from_json(&text),
};
```
<!-- /snippet -->

<!-- snippet: region examples/quickstart/go/main.go decode -->
```go
var order types.Order
if decoder == "llm" {
	order, err = types.DecodeOrderFromLlm(data)
} else {
	err = json.Unmarshal(data, &order)
}
```
<!-- /snippet -->

<!-- snippet: region examples/quickstart/ts/decode.ts decode -->
```ts
const order = decoder === "llm" ? decodeOrderFromLlm(text) : decodeOrderFromJson(text);
```
<!-- /snippet -->

Here is what each language prints for a valid order, an order with a quantity of 0, and an order where `note` is misspelled `notes`:

<!-- snippet: decode json message payloads/valid.json payloads/zero-quantity.json payloads/misspelled-key.json -->
```text
payloads/valid.json
  Rust        ok {"id":"ord_7d2k","quantity":2,"status":"paid","note":"Leave at the door"}
  Go          ok {"id":"ord_7d2k","quantity":2,"status":"paid","note":"Leave at the door"}
  TypeScript  ok {"id":"ord_7d2k","quantity":2,"status":"paid","note":"Leave at the door"}

payloads/zero-quantity.json
  Rust        /quantity: too small, expected >= 1, found 0
  Go          /quantity: too small, expected >= 1, found 0
  TypeScript  /quantity: too small, expected >= 1, found 0

payloads/misspelled-key.json
  Rust        /notes: unknown key
  Go          /notes: unknown key
  TypeScript  /notes: unknown key
```
<!-- /snippet -->

These lines are not typed by hand. `pnpm docs:check` runs the three programs in [`examples/quickstart`](examples/quickstart) in CI and fails when the output changes. The misspelled key is the bug from the story: a decoder that skips unknown keys would have dropped the note without a word. To accept such keys and log them instead, set `"read": "report"` ([read modes](docs/read-modes.md)).

## Install

After the first release (nothing is published yet):

```bash
npm install --save-dev strictgen    # Node 22 or later; or: npx strictgen generate
```

Rust and Go projects can use a single binary instead, which needs no Node. Each GitHub release has one for macOS (arm64, x64), Linux (x64, arm64, glibc) and Windows (x64), and a `SHA256SUMS` file to check the download against:

```bash
sha256sum --check --ignore-missing SHA256SUMS    # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
chmod +x strictgen-linux-x64 && ./strictgen-linux-x64 --version
```

The binaries aren't signed by Apple or Microsoft yet, so macOS and Windows may warn on first run. On macOS, `xattr -d com.apple.quarantine strictgen-macos-arm64` clears the warning for a file you have checked. `rustfmt` and `gofmt` stay separate installs, as with npm.

Generated code needs no strictgen package at run time: Rust uses `serde` and `serde_json` (and `regex` when a schema has a `pattern`), Go the standard library, and TypeScript nothing.

## Docs

| Page | What it covers |
| ---- | -------------- |
| [Command line and config](docs/cli.md) | `strictgen.json`, every command, formatters, exit codes |
| [Supported schemas](docs/schemas.md) | The subset strictgen accepts, every generation rule with an example and its fix, and moving a schema in with `strictgen fix` |
| [Mapping](docs/mapping.md) | Every construct and what it becomes in Rust, Go, TypeScript and an LLM schema |
| [Error codes](docs/error-codes.md) | The error shape and every code, with an example in each language |
| [Read modes](docs/read-modes.md) | `strict` and `report`, and the unknown key hook |
| [TypeScript](docs/typescript.md) | The TypeScript decoders and encoders, and their number limits |
| [LLM profiles](docs/llm.md) | Provider-ready schemas, each profile, the LLM decoders and the cleanup step |
| [Breaking changes](docs/breaking-changes.md) | `strictgen breaking` and who each change breaks |
| [Comparison](docs/comparison.md) | quicktype, typify, json-schema-to-typescript, go-jsonschema, typeshare, JSON Type Definition and BAML, and when to pick each |
| [Rust serde bridge](docs/serde-bridge.md) | The optional `Deserialize` impl, so generated Rust types fit inside your own serde types, still strict |
| [Playground](playground/README.md) | A static page that runs the generator and the TypeScript decoders in the browser. `pnpm playground:build && pnpm playground:serve` runs it locally |
| [Conformance suite](conformance/README.md) | The cross-language proof and the fuzzer |
| [Contributing](CONTRIBUTING.md) | Setup, ground rules, and how to run the proof suite |

## License

[Apache License 2.0](LICENSE)
