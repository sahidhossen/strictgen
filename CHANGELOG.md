# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project setup: license, contributing guide, code of conduct, security policy, issue and pull request templates, and CI
- Generator core: schema loader, model builder, naming, and the Rust, Go and TypeScript emitters, driven by `generate(schemas, targets)`
- `idBase` option: every schema `$id` must be `<idBase><file>.json`, with the base derived from the first schema when not given
- `ids` option, like `{ "file": "common", "suffix": "Id" }`, to generate ID types. Off by default

[Unreleased]: https://github.com/sahidhossen/strictgen/commits/main
