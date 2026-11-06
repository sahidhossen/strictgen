# Quickstart example

The example of the [README](../../README.md#30-seconds) and of the [LLM worked example](../../docs/llm.md#a-worked-example): one schema, the Rust, Go and TypeScript code strictgen generates from it, and a small program in each language that decodes payloads with it.

| Path | What it is |
| ---- | ---------- |
| `strictgen.json` | The config: the three targets and the `openai` LLM profile |
| `schemas/order.json` | An order with a bounded quantity, a status and an optional note |
| `payloads/` | JSON the normal decoders read: a valid order, a quantity of 0, a misspelled key |
| `answers/` | Answers a model could give for the provider-ready schema: a note that is too long, and a `null` note |
| `llm/openai/` | The provider-ready schemas, generated |
| `rust/` | A crate with the generated types in `src/generated` and the program in `src/main.rs`, written by hand |
| `go/` | A module with the generated types in `types/` and the program in `main.go`, written by hand |
| `ts/` | The generated types in `generated/` and `decode.ts`, written by hand |

Each program decodes each file it is given and prints `ok` and the value written again, or the error and its compact form:

```bash
cd examples/quickstart/rust && cargo run -q -- json ../payloads/*.json
cd examples/quickstart/go && go run . llm ../answers/*.json
```

`decode.ts` exports a function rather than reading files, so it needs no Node types. `pnpm docs` runs all three programs, fails if they print anything different, and puts their output into the README and docs. `pnpm docs:check` runs in CI and fails when the docs are out of date.

## Regenerating

From the repository root, after `pnpm build`:

```bash
node dist/cli.js generate --config examples/quickstart/strictgen.json
node dist/cli.js check --config examples/quickstart/strictgen.json
```
