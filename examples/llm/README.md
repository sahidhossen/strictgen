# LLM example

One order schema, as a model would read it out of a customer's message, projected into a provider-ready schema for each built in profile, with the LLM decoders and the cleanup step in every language. [`docs/llm.md`](../../docs/llm.md) describes them.

| Path | What it is |
| ---- | ---------- |
| `strictgen.json` | The config: the three targets, and `llm` with the `openai`, `anthropic` and `gemini` profiles and `cleanup` on |
| `schemas/order.json` | An order: a customer with an optional email and a way to reach them (an untagged union), lines with a pattern, numeric bounds and unique tags, a payment picked by its `method` key, a date, a note of at most 80 characters, a priority and labels (a map with a key limit). Beside it, a type of every other kind a root can be, each wrapped as `{ "value": ... }` in the projection: `billing` (an alias of the payment union), `stock` (a map keyed by stock keeping unit), `picks` (an array), `status` (an enum), `boxes` (an integer with bounds) and `remark` (a string) |
| `llm/<profile>/` | The provider-ready schema of every type for that profile, generated |
| `rust/src/generated/` | The Rust types, with `clean_llm_json` and a `decode_x_from_llm` per type. `rust/` is a crate; `tests/cleanup.rs` and `tests/llm.rs` are written by hand |
| `go/` | The Go types, with `CleanLLMJSON` and a `DecodeXFromLlm` per type. `go.mod`, `cleanup_test.go` and `llm_test.go` are written by hand |
| `ts/generated/` | The TypeScript types and decoders, with `cleanLlmJson` and a `decodeXFromLlm` per type |
| `cleanup-vectors.json` | Inputs and the output the cleanup step must give for each, which the Rust, Go and TypeScript tests all run. `scripts/cleanup-vectors.mjs` writes it |
| `llm-vectors.json` | Payloads in the form a model sends, each with the normal JSON of its value or the error it must give, which the Rust, Go and TypeScript tests all run. `pnpm vectors:llm` writes it from the TypeScript output |

```bash
cd examples/llm/rust && cargo test
cd examples/llm/go && go test ./...
```

## Regenerating

From the repository root, after `pnpm build`:

```bash
node dist/cli.js generate --config examples/llm/strictgen.json
node dist/cli.js check --config examples/llm/strictgen.json
node dist/cli.js llm --config examples/llm/strictgen.json --profile anthropic OrderRequest
node scripts/cleanup-vectors.mjs
pnpm vectors:llm
```
