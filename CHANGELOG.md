# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project setup: license, contributing guide, code of conduct, security policy, issue and pull request templates, and CI
- Generator core: schema loader, model builder, naming, and the Rust, Go and TypeScript emitters, driven by `generate(schemas, targets)`
- `idBase` option: every schema `$id` must be `<idBase><file>.json`, with the base derived from the first schema when not given
- `ids` option, like `{ "file": "common", "suffix": "Id" }`, to generate ID types. Off by default
- `examples/basic`: a webhook event, a user and a payment method schema, their generated Rust, Go and TypeScript output, and fixtures that round trip through the Rust and Go output. `pnpm examples` regenerates it and `pnpm examples:check` fails when the committed output is out of date, both through the CLI
- `strictgen.json` config, described by `strictgen.schema.json` (JSON Schema 2020-12). `loadConfig` reads and validates it, applies defaults and resolves paths against the config file's folder, and reports a bad option as a `ConfigError` naming the option path. Only the targets listed under `targets` are generated: Rust (`out`, `fixtures`, `allow`, `embedSchemas`), Go (`out`, `package`, `shared`, `fixtures`) and TypeScript (`out`). Neither Rust nor Go writes a fixture registry unless `fixtures` asks for one. `header` sets the first line of every generated file. Options for later phases (`validation`, `read`, `decoders`, `llm`, `docs`) are validated but not yet active
- Before clearing a folder it owns, strictgen checks, with symlinks resolved and case ignored, that the folder holds neither the project, the config file nor the schemas. It never overwrites a hand written file, like a `.gitattributes`, in a shared folder
- `targets.rust.embedSchemas` writes `schemas.rs` with every schema as minified ASCII JSON. Off by default
- `examples/basic/strictgen.json`: the example is generated from its config
- The `strictgen` command line, with a `bin` entry: `strictgen` or `strictgen generate` writes every target, `strictgen check` exits 1 and lists every file that differs, is missing or is stale, without writing, and `strictgen dirs [--json]` prints the folders the targets write to. Every command takes `--config <path>` and `--help`, and `strictgen --version` prints the version. Exit codes: 0 success, 1 generation failed or `check` found a difference, 2 bad usage or a config error
- Formatters: `format.rust` (`rustfmt`, the default, or `none`) and `format.go` (`gofmt`, the default, or `none`) run on the generated files in memory, on stdin, before anything is written. `rustfmt` runs with its defaults and edition 2024, ignoring any `rustfmt.toml`, so `check` gives the same result on every machine. A formatter that isn't installed, or a `rustfmt` whose `--version` fails, is skipped with a notice by `generate` and fails `check`. One that fails, prints nothing, prints something without the generated header, or runs longer than 60 seconds exits 1 with its output, and nothing is written
- `strictgen explain <file.json#/pointer>` prints the model of one type and its declaration in each configured language, formatted like `generate` writes it, or the rule, reason and hint when it can't be generated. `--json` prints the same as JSON. Unknown files and pointers exit 2
- Every generation error carries a stable rule id, like `open-object`, `unsupported-keyword` or `reserved-name`, and a fix hint when there is an obvious one: `user.json#/$defs/address: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false`. `RULES` lists every id with a summary
- Reserved names per language: a type named like a Rust keyword (`Self`), like a global type the TypeScript output uses (`Record`, `Partial`, `NonNullable`) or a schema file named like a crate the Rust output uses (`serde`, `std`) now fails with `reserved-name` instead of producing code that doesn't compile. Only the configured targets' lists apply. Fields named like keywords stay escaped (`r#match` in Rust)
- A type name that would start with a digit, like one from `$defs/1st`, fails with `unsupported-name`
- `examples/basic/schemas/subscription.json`: a schema whose keys are keywords in Rust, Go or TypeScript (`match`, `async`, `default`, `select`, `self`), with fixtures

### Changed

- Generation errors read `<file>#<pointer>: <rule>: <reason>`, with `. Hint: <fix>` when there is one, instead of `<file>#<pointer>: <reason>` with an inline `Fix:`. `CodegenError` has `rule` and `hint` fields
- A key that maps to a Go method or the `Rest` field fails with `reserved-name` instead of reading as a clash between two keys
- The generated example output is formatted with `rustfmt` and `gofmt`. CI checks it with `strictgen check` and installs both formatters
- Errors while reading schemas or the config, or while writing the output, like a folder where a generated file should go or an `out` path through a symlink that points nowhere, are reported as one line naming the path, never a stack trace

### Removed

- The unused `emitRustRoots`, whose output referenced a module the generator does not write
- `scripts/examples.ts`, replaced by `strictgen check` and `strictgen generate`

### Fixed

- The generated Go JSON parser declares its own error codes in `helpers.go`, `invalid_json`, `duplicate_key` and `too_deep`, so the Go output compiles

[Unreleased]: https://github.com/sahidhossen/strictgen/commits/main
