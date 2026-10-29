# Basic example

Four schemas and what strictgen generates from them.

| Path | What it is |
| ---- | ---------- |
| `schemas/` | A webhook event envelope (`event.json`), a user (`user.json`), a payment method picked by its `type` key (`payment-method.json`) and shared IDs (`common.json`) |
| `rust/src/generated/` | The Rust types, a module per schema. `rust/` is a crate that depends on `serde` and `serde_json` only |
| `go/` | The Go types (`*.go` other than tests), standard library only. `go.mod`, `fixtures_test.go` and `codes_test.go` are written by hand |
| `ts/generated/` | The TypeScript types |
| `fixtures/` | JSON documents each language must accept (`valid/`) or reject (`invalid/`) |

IDs are on, with `{ "file": "common", "suffix": "Id" }`, so `userId` and `eventId` become their own types.

## Fixtures

A fixture for a schema's root type lives in `fixtures/<schema>/valid` or `fixtures/<schema>/invalid`, and one for a def in `fixtures/<schema>/<def>/valid` or `invalid`. The Rust and Go tests decode every fixture with the type generated for its folder. A valid case must decode and encode again to the same JSON value, and an invalid case must fail.

```bash
cd examples/basic/rust && cargo test
cd examples/basic/go && go test ./...
```

## Regenerating

From the repository root:

```bash
pnpm examples         # regenerate the output
pnpm examples:check   # fail if the committed output is out of date
```
