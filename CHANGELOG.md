# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project setup: license, contributing guide, code of conduct, security policy, issue and pull request templates, and CI
- Generator core: schema loader, model builder, naming, and the Rust, Go and TypeScript emitters, driven by `generate(schemas, targets)`
- `idBase` option: every schema `$id` must be `<idBase><file>.json`, with the base derived from the first schema when not given
- `ids` option, like `{ "file": "common", "suffix": "Id" }`, to generate ID types. Off by default
- `examples/basic`: a webhook event, a user and a payment method schema, their generated Rust, Go and TypeScript output, and fixtures that round trip through the Rust and Go output. `pnpm examples` regenerates it and `pnpm examples:check` fails when the committed output is out of date
- `strictgen.json` config, described by `strictgen.schema.json` (JSON Schema 2020-12). `loadConfig` reads and validates it, applies defaults and resolves paths against the config file's folder, and reports a bad option as a `ConfigError` naming the option path. Only the targets listed under `targets` are generated: Rust (`out`, `fixtures`, `allow`, `embedSchemas`), Go (`out`, `package`, `shared`, `fixtures`) and TypeScript (`out`). Neither Rust nor Go writes a fixture registry unless `fixtures` asks for one. `header` sets the first line of every generated file. Options for later phases (`validation`, `read`, `decoders`, `llm`, `docs`, `format`) are validated but not yet active
- Before clearing a folder it owns, strictgen checks, with symlinks resolved and case ignored, that the folder holds neither the project, the config file nor the schemas. It never overwrites a hand written file, like a `.gitattributes`, in a shared folder
- `targets.rust.embedSchemas` writes `schemas.rs` with every schema as minified ASCII JSON. Off by default
- `examples/basic/strictgen.json`: the example is generated from its config

### Removed

- The unused `emitRustRoots`, whose output referenced a module the generator does not write

### Fixed

- The generated Go JSON parser declares its own error codes in `helpers.go`, `invalid_json`, `duplicate_key` and `too_deep`, so the Go output compiles

[Unreleased]: https://github.com/sahidhossen/strictgen/commits/main
