# LLM example

One order schema, as a model would read it out of a customer's message, projected into a provider-ready schema for each built in profile, with the cleanup step in every language. [`docs/llm.md`](../../docs/llm.md) describes both.

| Path | What it is |
| ---- | ---------- |
| `strictgen.json` | The config: the three targets, and `llm` with the `openai`, `anthropic` and `gemini` profiles and `cleanup` on |
| `schemas/order.json` | An order: a customer with an optional email and a way to reach them (an untagged union), lines with a pattern, numeric bounds and unique tags, a payment picked by its `method` key, a date, a note of at most 80 characters, a priority and labels (a map with a key limit) |
| `llm/<profile>/` | The provider-ready schema of every type for that profile, generated |
| `rust/src/generated/` | The Rust types, with `clean_llm_json`. `rust/` is a crate; `tests/cleanup.rs` is written by hand |
| `go/` | The Go types, with `CleanLLMJSON`. `go.mod` and `cleanup_test.go` are written by hand |
| `ts/generated/` | The TypeScript types and decoders, with `cleanLlmJson` |
| `cleanup-vectors.json` | Inputs and the output the cleanup step must give for each, which the Rust, Go and TypeScript tests all run. `scripts/cleanup-vectors.mjs` writes it |

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
```
