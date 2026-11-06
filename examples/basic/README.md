# Basic example

Seven schemas and what strictgen generates from them.

| Path | What it is |
| ---- | ---------- |
| `strictgen.json` | The config: where the schemas are and which targets to write |
| `schemas/` | A webhook event envelope (`event.json`), a user with a contact that is an email or a phone, exactly one (`user.json`), a payment method picked by its `type` key (`payment-method.json`), a webhook subscription whose keys are keywords in Rust, Go or TypeScript (`subscription.json`), an order with a limit of every kind (`order.json`), a shipment with patterns, formats and unique items (`shipment.json`) and shared IDs (`common.json`) |
| `rust/src/generated/` | The Rust types, a module per schema. `rust/` is a crate that depends on `serde`, `serde_json` and, since the schemas use `pattern`, `regex`. `tests/fixtures.rs` and `tests/errors.rs` are written by hand |
| `go/` | The Go types (`*.go` other than tests), standard library only. `go.mod`, `fixtures_test.go`, `aliases_test.go` (every fixture through `json.Unmarshal` too), `codes_test.go` and `encode_test.go` are written by hand |
| `ts/generated/` | The TypeScript types and their decoders, with `helpers.ts`, which they share |
| `fixtures/` | JSON documents each language must accept (`valid/`) or reject (`invalid/`) |

`strictgen.json` configures the three targets. IDs are on, with `{ "file": "common", "suffix": "Id" }`, so `userId` and `eventId` become their own types.

## Fixtures

A fixture for a schema's root type lives in `fixtures/<schema>/valid` or `fixtures/<schema>/invalid`, and one for a def in `fixtures/<schema>/<def>/valid` or `invalid`. The Rust and Go tests decode every fixture with the type generated for its folder. The repository tests run them through the TypeScript decoders too, from the JSON text. A valid case must decode and encode again to the same JSON value, and an invalid case must fail with the `path` and `code` in the `<case>.expect.json` next to it, which the Rust, Go and TypeScript runs check (see [`docs/error-codes.md`](../../docs/error-codes.md)).

```bash
cd examples/basic/rust && cargo test
cd examples/basic/go && go test ./...
```

## Regenerating

From the repository root, after `pnpm build`:

```bash
node dist/cli.js generate --config examples/basic/strictgen.json   # regenerate the output
node dist/cli.js check --config examples/basic/strictgen.json      # fail if it is out of date
```

`pnpm examples` and `pnpm examples:check` build and run the same commands. The output goes through `rustfmt` and `gofmt`, so install both before regenerating.
