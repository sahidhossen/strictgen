# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-17

The first release: one JSON Schema in, strict Rust, Go and TypeScript out, which accept and reject the same JSON and report the same errors.

### Added

- **Generator and targets.** A strict subset of JSON Schema 2020-12 becomes types and decoders in Rust, Go and TypeScript: closed objects, optional and required keys, maps, enums, consts, tagged and untagged unions, recursion, aliases and ID types. A `strictgen.json` config, described by the shipped `strictgen.schema.json`, picks the targets. Output is deterministic and formatted with `rustfmt` and `gofmt`. Generated Rust needs only `serde` and `serde_json` (and `regex` when a schema uses `pattern`), Go only the standard library, and TypeScript nothing: its helpers are generated
- **Fail-closed generation.** A schema that can't be checked the same way in every language fails generation with its location, a stable rule id and a fix hint, like `user.json#/$defs/address: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false`. `docs/schemas.md` lists every rule
- **Command line.** `strictgen generate`, `strictgen check` (exit 1 when the generated files on disk are out of date, for CI) and `strictgen dirs`. Exit codes: 0 success, 1 generation failed or `check` found a difference, 2 bad usage or a config error
- **Strict decoders.** The standard entry point of each language decodes strictly: `T::from_json` in Rust, `json.Unmarshal` in Go and `decodeXFromJson` in TypeScript. Unknown keys, missing required keys, `null` for an optional key, wrong types and unknown tags fail. Each language reads the JSON text itself, so a key given twice, data after the value, a lone surrogate, nesting 128 deep and an integer spelled `12.0`, `1e2` or `-0` fail the same way everywhere
- **Shared errors.** One error shape, `{ path, code, expected?, found? }`, with a JSON Pointer path and 19 fixed codes, and the same message and compact form in every language, like `/items/2/price: wrong type, expected a number, found "5"`. `docs/error-codes.md` lists the codes
- **Encoders.** Every language writes keys in the same order. TypeScript encoders refuse values Rust and Go couldn't hold, like `NaN`, `-0`, an integer past 2^53 - 1 or an unknown key
- **Validation.** `minLength` and `maxLength` (counted in code points), `minimum`, `maximum` and their exclusive forms, `multipleOf` on integers, `minItems`, `maxItems`, `minProperties`, `maxProperties`, `pattern`, `format` (`date-time`, `date`, `uuid`) and `uniqueItems` are checked by every decoder, in one documented order. `"validation": false` leaves the checks out
- **Portable patterns.** `pattern` is read as ECMAScript and rewritten into one form that Rust's `regex`, Go's RE2 and JavaScript read the same way. Anything they would read differently, like lookarounds or backreferences, fails generation with `unsupported-pattern`
- **Read modes.** `"read": "strict"` (the default) fails on unknown keys. `"read": "report"` accepts them and returns their JSON Pointers, the same paths in the same order in every language, through a hook and the report functions. Everything else stays strict (`docs/read-modes.md`)
- **LLM profiles.** `openai`, `anthropic` and `gemini` profiles ship as versioned data files. `llm.out` writes, per type and profile, the schema the provider accepts for structured output, projected from the real one, and a type over a provider's limits fails with `llm-limit` or `llm-unsupported`. `strictgen llm --profile <name> <Type>` prints one (`docs/llm.md`)
- **LLM decoders.** `decodeXFromLlm` (TypeScript), `DecodeXFromLlm` (Go) and `decode_x_from_llm` (Rust) read what the model sent: `null` as absent, a wrapped `{ "value": ... }` and maps as entries or objects, then check every constraint of the real type, including those the provider's schema can't express. `llm.cleanup` adds an optional step that removes a code fence, a byte order mark, surrounding white space and trailing commas, and nothing else
- **`strictgen breaking`** compares the schemas with a git ref or a folder and lists each change with who it breaks: all consumers, strict consumers, producers or nobody. Exit 1 when anything breaks (`docs/breaking-changes.md`)
- **`strictgen fix`** rewrites schemas into the supported subset (close objects, tag unions, merge `allOf`, move nested defs into `$defs`) as a diff, or in place with `--write`, keeping the formatting of untouched parts, and lists what is left to change by hand
- **`strictgen examples`** prints valid payloads of a type for a seed, or near misses with the error every decoder gives for them
- **`strictgen docs`** writes a Markdown page per type, or one HTML page, with each type in every language, its constraints and a valid example
- **`strictgen explain`** shows how one type maps in each configured language, or why it can't be generated
- **Proof suite.** `pnpm conformance` runs about 400 cases through every entry point of the three languages, in strict, report and LLM modes, and fails on any difference in accept or reject, the error, the unknown keys or the bytes written. Every mapping rule and error code must have a case. `pnpm fuzz` is a differential fuzzer that shrinks a disagreement to a small case. CI runs the suite and a fixed-seed fuzz run on every pull request
- **Rust serde bridge.** `targets.rust.serdeBridge` (off by default) gives the generated Rust types serde's `Deserialize`, running the same strict decoder, so they can sit inside your own serde types (`docs/serde-bridge.md`)
- **Go `Encode`.** Each generated Go package has `Encode(v any) ([]byte, error)`, which writes the same bytes as Rust and TypeScript, where `json.Marshal` escapes `<`, `>`, `&`, U+2028 and U+2029
- **Playground.** A static page, `playground/`, runs the real generator and the TypeScript decoders in the browser, with no server
- **npm package.** `npm install --save-dev strictgen`, for Node 22 or later, published with provenance. It ships the CLI, the API, the built in profiles and `strictgen.schema.json`
- **Single binaries.** For Rust and Go projects without Node: macOS (arm64, x64), Linux (x64, arm64, glibc) and Windows (x64), as `.tar.gz` and `.zip` archives on the GitHub release with a `SHA256SUMS` file. The binaries aren't signed by Apple or Microsoft, so macOS and Windows may warn on first run

[Unreleased]: https://github.com/sahidhossen/strictgen/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sahidhossen/strictgen/releases/tag/v0.1.0
