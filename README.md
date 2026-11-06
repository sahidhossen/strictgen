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

Neither Rust nor Go writes a fixture registry for tests unless asked: Go takes `"fixtures": true`, Rust takes `"fixtures": { "out": "...", "crate": "..." }`. TypeScript gets strict decoders next to the types, `decodeXFromJson`, `decodeX`, `encodeX` and their variants, unless `"decoders": false`; [`docs/typescript.md`](docs/typescript.md) explains them and their number limits. Rust types implement a `Decode` trait, so `User::from_json(text)` decodes strictly. Rust, Go and TypeScript report the same decode errors, described in [`docs/error-codes.md`](docs/error-codes.md). Each target reads `strict` by default, failing on unknown keys, or with `"read": "report"` accepts them and reports their paths through one hook and the report functions, the same paths in every language ([`docs/read-modes.md`](docs/read-modes.md)). [`strictgen.schema.json`](strictgen.schema.json) documents every option and its default. [`examples/basic`](examples/basic) has a full example, and [`examples/report`](examples/report) one in report mode.

## Command line

```bash
strictgen                 # same as strictgen generate
strictgen generate        # write every target, formatted
strictgen check           # exit 1 if the generated files on disk are out of date, for CI
strictgen dirs [--json]   # print the folders the targets write to
strictgen explain user.json#/$defs/address   # show how one type maps in each language
```

Every command takes `--config <path>` to read a config other than `strictgen.json` in the current folder, and `--help`. `strictgen --version` prints the version.

Exit codes: `0` success, `1` generation failed or `check` found a difference, `2` bad usage or a config error. Errors name the file, and the option or JSON pointer, with one line per problem.

A schema the generator can't map fails with its location, a stable rule id, the reason and, when there is an obvious fix, a hint:

```text
error: user.json#/$defs/address: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false
```

The rule ids, like `open-object`, `unsupported-keyword`, `unsupported-format`, `union-tag` or `reserved-name`, don't change between releases. `RULES` in the package lists every one with a one line summary.

### Formatters

`generate` runs `rustfmt` on the Rust output and `gofmt` on the Go output, in memory, and writes only when every file formatted cleanly. Turn either off with `"format": { "rust": "none", "go": "none" }`. TypeScript output is not formatted. A formatter that isn't installed, or a `rustfmt` whose `--version` fails (a rustup proxy without the component), is skipped with a notice. One that fails, prints nothing, prints something that doesn't start with the generated header, or runs longer than 60 seconds stops with exit code 1 and its output, and nothing is written.

`check` formats in memory the same way before comparing, so it needs every configured formatter installed and fails without one. To give the same result on every machine, `rustfmt` runs with its defaults and edition 2024 and ignores any `rustfmt.toml`, and both formatters read the file on stdin.

### `dirs`

`strictgen dirs` prints one folder per line, relative to the current folder, in config order: Rust (and its fixture folder), Go, TypeScript. strictgen clears an owned folder before writing. In a shared folder, like a Go package with hand written tests, it only replaces the files it generated. `--json` prints them as `{ "target", "dir", "shared" }` objects.

### `explain`

`strictgen explain <file.json#/pointer>` shows how one type maps: its model (a struct and its fields, an enum and its values, a union and its branches), then its declaration in Rust, Go and TypeScript, for the targets the config lists only, formatted the way `generate` writes it. Give `user.json` alone for a schema's root type. When a configured formatter isn't installed, the heading says the code is unformatted.

```text
$ strictgen explain user.json#/$defs/role
user.json#/$defs/role

Model:
  enum Role: "owner", "admin", "member"

Rust:
/// What the user may do.
...
```

When the type can't be generated, `explain` prints the rule it breaks, the reason and the hint, per language for a name one language reserves, and exits 1. An unknown file or pointer, or one that names no generated type, exits 2. `--json` prints the model and each target's code or error as JSON.

### Reserved names

A field named like a keyword is escaped where the language allows it: `r#type` and `r#match` in Rust (`self_` and `crate_` for the keywords that can't be raw), the exported field name in Go (`Type`, `Func`, `Default`), and the key as it is in TypeScript, which allows keywords as property names. A type named like a keyword, or like a name the generated code uses itself (`Self`, `Option` or `DecodeError` in Rust, `DecodeError` in Go, `Record`, `Partial` or `DecodeError` in TypeScript), fails with `reserved-name` and a hint to rename it. Only the configured targets' names apply, so a type named `Record` is fine when TypeScript isn't a target.

## License

[Apache License 2.0](LICENSE)
