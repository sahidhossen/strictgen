# strictgen

**One JSON Schema. Rust, Go and TypeScript that accept and reject exactly the same JSON, and never drop data silently.**

[Docs](#docs) · [Playground](playground/README.md) · [Comparison](docs/comparison.md)

<!-- Badges (release, CI) come with the first release. -->

> **Status:** 0.1.0, the first release. Before 1.0, a minor version may break; see [CHANGELOG.md](CHANGELOG.md) and the [versioning policy](CONTRIBUTING.md#versioning).

A valid order, an order with a quantity of 0, and an order where `note` is misspelled `notes`, read by the generated Rust, Go and TypeScript:

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

These lines come from running the generated code in [`examples/quickstart`](examples/quickstart), and CI fails when they change. A decoder that skips unknown keys would have dropped the note without a word.

## Why

In August 2026, a [pull request to the dstack SDKs](https://github.com/Dstack-TEE/dstack/pull/1024) described a bug: the Go SDK computed a different compose hash, the hash that identifies an app, than the JavaScript and Python SDKs for the same document. Go's `encoding/json` escaped `<`, `>` and `&`, which the others write as they are, and a fixed struct dropped every key it didn't declare before hashing. Attestation then fails "with nothing pointing at the cause". A related [fix to the Go SDK](https://github.com/Dstack-TEE/dstack/pull/1479) for U+2028 and U+2029 was merged in October.

Nothing crashed. Each language read the same JSON a little differently. That is the bug strictgen rules out.

## What you get

- **One schema, three languages.** A strict subset of JSON Schema 2020-12 becomes types and decoders in Rust, Go and TypeScript
- **Never silent.** An unknown key fails the decode, or in [`report` mode](docs/read-modes.md) is reported with its path
- **Same answer everywhere.** The same accept or reject, error and bytes written again ([where spelling may differ](conformance/README.md#known-differences))
- **Proven, not promised.** Hundreds of conformance cases and a differential fuzzer run every language and fail on any difference
- **Change safety.** [`strictgen breaking`](docs/breaking-changes.md) lists who a schema change breaks before it merges
- **LLM-ready.** Each type also becomes the schema each [LLM provider](docs/llm.md) accepts, with decoders that check what the provider can't

## Quick start

Install:

```bash
npm install --save-dev strictgen    # Node 22 or later; or: npx strictgen generate
```

Rust and Go projects can use a single binary instead, which needs no Node. Each [GitHub release](https://github.com/sahidhossen/strictgen/releases) has one archive per platform: `strictgen-macos-arm64.tar.gz`, `strictgen-macos-x64.tar.gz`, `strictgen-linux-x64.tar.gz`, `strictgen-linux-arm64.tar.gz` (glibc) and `strictgen-windows-x64.zip`, and a `SHA256SUMS` file to check them against. Download the archive and `SHA256SUMS` into one folder, then:

```bash
sha256sum --check --ignore-missing SHA256SUMS    # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
tar -xzf strictgen-linux-x64.tar.gz              # Windows: Expand-Archive strictgen-windows-x64.zip .
./strictgen --version                            # Windows: .\strictgen.exe --version
```

The archive holds one file, `strictgen` (`strictgen.exe` on Windows), already executable; move it to a folder on your `PATH`. The binaries aren't signed by Apple or Microsoft, so macOS and Windows may warn on first run. On macOS, once you have checked the download, `xattr -d com.apple.quarantine strictgen` on the extracted file clears the warning. `rustfmt` and `gofmt` stay separate installs.

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

A `strictgen.json` next to it names the targets. Its `llm` key is optional; here it also asks for the OpenAI schema of each type.

<details>
<summary>The <code>strictgen.json</code> next to it</summary>

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

</details>

One command writes the types and their decoders, formatted with `rustfmt` and `gofmt`:

```bash
strictgen generate   # writes rust/src/generated, go/types, ts/generated and llm/openai
```

<details>
<summary>The generated <code>Order</code> in Rust, Go and TypeScript</summary>

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

</details>

<details>
<summary>Decoding with each language's usual call</summary>

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

</details>

Generated code needs no strictgen package at run time: Rust uses `serde` and `serde_json` (and `regex` when a schema has a `pattern`), Go the standard library, and TypeScript nothing.

## Commands

| Command | What it does |
| ------- | ------------ |
| `generate` | Writes every target, formatted (the default command) |
| `check` | Exits 1 if the generated files on disk are out of date, for CI |
| `breaking --base <ref>` | Compares the schemas with an older version and says who each change breaks |
| `fix [--write]` | Rewrites the schemas into the supported subset, as a diff or in place |
| `examples <type>` | Prints valid or near-miss sample payloads for one type |
| `docs` | Writes a documentation page per type, or one HTML page |
| `llm --profile <name> <type>` | Prints the provider-ready schema of one type |
| `explain <file#/pointer>` | Shows how one schema type maps in each configured language |
| `dirs` | Prints the folders the targets write to |

Options, config and exit codes are in [docs/cli.md](docs/cli.md).

## When to use it, and when not

strictgen is for Rust, Go and TypeScript services that share JSON and must agree on it exactly. It reads only a strict subset of JSON Schema and writes three languages.

If you need many languages, or types inferred from sample payloads, [quicktype](https://github.com/glideapps/quicktype) is the better pick.

[docs/comparison.md](docs/comparison.md) compares strictgen with other tools and says when each one fits best.

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
