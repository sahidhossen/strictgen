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

### Fixed

- The generated Go JSON parser declares its own error codes in `helpers.go`, `invalid_json`, `duplicate_key` and `too_deep`, so the Go output compiles

[Unreleased]: https://github.com/sahidhossen/strictgen/commits/main
