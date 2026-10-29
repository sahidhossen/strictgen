# strictgen

**One JSON Schema. Rust, Go and TypeScript that accept and reject exactly the same JSON, and never drop data silently.**

strictgen generates types and strict decoders from a subset of JSON Schema 2020-12, and proves with a shared conformance suite that every language agrees.

> **Status:** early development. Nothing is released yet, and the interface will change.

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

Neither Rust nor Go writes a fixture registry for tests unless asked: Go takes `"fixtures": true`, Rust takes `"fixtures": { "out": "...", "crate": "..." }`. [`strictgen.schema.json`](strictgen.schema.json) documents every option and its default. [`examples/basic`](examples/basic) has a full example.

## License

[Apache License 2.0](LICENSE)
