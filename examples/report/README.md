# Report mode example

One schema generated in report mode for every language: unknown keys are accepted and their paths reported, while everything else stays strict. [`docs/read-modes.md`](../../docs/read-modes.md) describes the mode.

| Path | What it is |
| ---- | ---------- |
| `strictgen.json` | The config: the three targets, each with `"read": "report"` |
| `schemas/order.json` | An order a shop sends in a webhook: a customer reachable by email or by phone, exactly one, lines of items, a payment picked by its `type` key, a delivery by courier or pickup (an untagged union), notes by team (a map of objects), attributes (named keys beside a map of the others), tags (a list with limits), generated as a type of its own in Rust and Go, a coupon with a pattern, a date-time and gifts, a list of unique items |
| `rust/src/generated/` | The Rust types. `rust/` is a crate that depends on `serde`, `serde_json` and, since the schema uses `pattern`, `regex`. `tests/fixtures.rs` and `tests/aliases.rs` are written by hand |
| `go/` | The Go types, standard library only. `go.mod`, `fixtures_test.go` and `aliases_test.go` are written by hand |
| `ts/generated/` | The TypeScript types and their decoders, with `helpers.ts` |
| `fixtures/` | A few JSON documents each language must accept (`valid/`) or reject (`invalid/`), to show the fixture tests. The full set is in [`conformance/`](../../conformance) |

## Fixtures

Fixtures are laid out as in [`examples/basic`](../basic). Every case has a `<case>.expect.json` next to it:

- A valid case lists the paths of its unknown keys in input order, like `{ "unknown": ["/source", "/lines/0/giftWrap"] }`, or `{ "unknown": [] }`. It must decode with exactly those paths, give them to the hook once (or not call it for none), and encode again to the input without those keys
- An invalid case has the `path` and `code` it must fail with, as in strict mode, and must not call the hook

The Rust and Go tests and the repository's TypeScript tests check every fixture. The full set of report mode cases, compared across the three languages, is in [`conformance/`](../../conformance) (`pnpm conformance`).

```bash
cd examples/report/rust && cargo test
cd examples/report/go && go test ./...
```

## Regenerating

From the repository root, after `pnpm build`:

```bash
node dist/cli.js generate --config examples/report/strictgen.json
node dist/cli.js check --config examples/report/strictgen.json
```

`pnpm examples` and `pnpm examples:check` regenerate and check both examples.
