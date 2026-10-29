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

## Command line

```bash
strictgen                 # same as strictgen generate
strictgen generate        # write every target, then run the formatters
strictgen check           # exit 1 if the generated files on disk are out of date, for CI
strictgen dirs [--json]   # print the folders the targets write to
```

Every command takes `--config <path>` to read a config other than `strictgen.json` in the current folder, and `--help`. `strictgen --version` prints the version.

Exit codes: `0` success, `1` generation failed or `check` found a difference, `2` bad usage or a config error. Errors name the file, and the option or JSON pointer, with one line per problem.

### Formatters

After writing, `generate` runs `rustfmt` on the Rust output and `gofmt` on the Go output. Turn either off with `"format": { "rust": "none", "go": "none" }`. TypeScript output is not formatted. A formatter that isn't installed is skipped with a notice, and one that fails stops with exit code 1 and its output.

`check` formats in memory the same way before comparing, so it needs every configured formatter installed and fails without one. To give the same result on every machine, `rustfmt` runs with its defaults and edition 2024 and ignores any `rustfmt.toml`, and both formatters read the file on stdin.

### `dirs`

`strictgen dirs` prints one folder per line, relative to the current folder, in config order: Rust (and its fixture folder), Go, TypeScript. strictgen clears an owned folder before writing. In a shared folder, like a Go package with hand written tests, it only replaces the files it generated. `--json` prints them as `{ "target", "dir", "shared" }` objects.

## License

[Apache License 2.0](LICENSE)
