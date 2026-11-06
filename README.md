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

Neither Rust nor Go writes a fixture registry for tests unless asked: Go takes `"fixtures": true`, Rust takes `"fixtures": { "out": "...", "crate": "..." }`. TypeScript gets strict decoders next to the types, `decodeXFromJson`, `decodeX`, `encodeX` and their variants, unless `"decoders": false`; [`docs/typescript.md`](docs/typescript.md) explains them and their number limits. Rust types implement a `Decode` trait, so `User::from_json(text)` decodes strictly. Generated Rust depends on `serde` and `serde_json`, and on the `regex` crate as well when a schema uses `pattern` ([`docs/error-codes.md`](docs/error-codes.md#patterns)). Rust, Go and TypeScript report the same decode errors, described in [`docs/error-codes.md`](docs/error-codes.md). Each target reads `strict` by default, failing on unknown keys, or with `"read": "report"` accepts them and reports their paths through one hook and the report functions, the same paths in every language ([`docs/read-modes.md`](docs/read-modes.md)). [`strictgen.schema.json`](strictgen.schema.json) documents every option and its default. [`examples/basic`](examples/basic) has a full example, [`examples/report`](examples/report) one in report mode, and [`examples/llm`](examples/llm) one with LLM provider schemas and the cleanup step.

With `"llm": { "profiles": ["openai", "anthropic", "gemini"], "out": "llm" }`, strictgen also writes the schema each LLM provider accepts for structured output, per type, projected from the real one: optional fields become nullable, unions become `anyOf`, and constraints a provider doesn't accept move into the description and the decoder. Each language gets an LLM decoder per type, `decodeXFromLlm`, `DecodeXFromLlm` and `decode_x_from_llm`, which reads what the model sends back, maps it to the real type (`null` back to absent) and checks every constraint, with errors in the compact form ready to send back to the model. Profiles are data files that a path in `llm.profiles` can replace. `"cleanup": true` adds a helper to every language that removes a code fence, a byte order mark and trailing commas from model output, and nothing else, which the LLM decoders run first ([`docs/llm.md`](docs/llm.md)).

## Command line

```bash
strictgen                 # same as strictgen generate
strictgen generate        # write every target, formatted
strictgen check           # exit 1 if the generated files on disk are out of date, for CI
strictgen dirs [--json]   # print the folders the targets write to
strictgen explain user.json#/$defs/address   # show how one type maps in each language
strictgen fix [--write]   # rewrite the schemas into the supported subset, as a diff or in place
strictgen examples Order --count 3 [--invalid] [--seed 7] [--array]   # print sample payloads
strictgen docs [--format markdown|html]   # write a page per type into docs.out
strictgen breaking --base main   # list changes since main and who each one breaks
strictgen llm --profile openai Order         # print the provider-ready schema of one type
```

Every command takes `--config <path>` to read a config other than `strictgen.json` in the current folder, and `--help`. `strictgen --version` prints the version.

Exit codes: `0` success, `1` generation failed, `check` found a difference or `breaking` found a breaking change, `2` bad usage or a config error. Errors name the file, and the option or JSON pointer, with one line per problem.

A schema the generator can't map fails with its location, a stable rule id, the reason and, when there is an obvious fix, a hint:

```text
error: user.json#/$defs/address: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false
```

The rule ids, like `open-object`, `unsupported-keyword`, `unsupported-format`, `union-tag` or `reserved-name`, don't change between releases. `RULES` in the package lists every one with a one line summary.

### Formatters

`generate` runs `rustfmt` on the Rust output and `gofmt` on the Go output, in memory, and writes only when every file formatted cleanly. Turn either off with `"format": { "rust": "none", "go": "none" }`. TypeScript output is not formatted. A formatter that isn't installed, or a `rustfmt` whose `--version` fails (a rustup proxy without the component), is skipped with a notice. One that fails, prints nothing, prints something that doesn't start with the generated header, or runs longer than 60 seconds stops with exit code 1 and its output, and nothing is written.

`check` formats in memory the same way before comparing, so it needs every configured formatter installed and fails without one. To give the same result on every machine, `rustfmt` runs with its defaults and edition 2024 and ignores any `rustfmt.toml`, and both formatters read the file on stdin.

### `breaking`

`strictgen breaking --base <ref or folder>` compares the schemas with an older version and lists every change by who it breaks: all consumers, strict consumers only (an added optional field, which `report` mode accepts), producers, or nobody. The comparison runs on the generated model, so renaming a def or an internal name doesn't show, and each change has its JSON pointer in both versions. A ref is read from the repository without a checkout. It exits 1 when anything breaks; `--json` prints a stable form for CI. [`docs/breaking-changes.md`](docs/breaking-changes.md) has the full rule table.

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

### `fix`

`strictgen fix` rewrites messy schemas into the supported subset. Its rules run until nothing changes:

- `close-objects` adds `"additionalProperties": false` to open objects, or `"unevaluatedProperties": false` beside `allOf`, `oneOf`, `anyOf` or `if`. An `allOf` base, an `allOf` part and an `if`/`then` branch stay open. An object with no properties stays open too, since closing it would allow only `{}`
- `tag-unions` turns a `oneOf` whose branches each have a `const` property into a tagged union: the tag becomes required, a one value `enum` becomes a `const`, each branch gets `"type": "object"` and the `oneOf` loses the `"type": "object"` beside it. A branch written as a `$ref` is only reported, since other schemas may use it
- `merge-allof` inlines an `allOf` whose parts are plain schemas (types, properties, required keys, constraints) that don't disagree. When they do, it leaves the `allOf` and says where
- `hoist-defs` turns `definitions` into `$defs`, moves `$defs` written inside a schema up to the root, moves a schema a `$ref` points into, like `#/properties/shipping/properties/address`, into `$defs` under a name taken from its path, like `address` or `shippingAddress` when that is taken, and renames a def a `$ref` can't name, like `order-item` to `orderItem`. Every `$ref` to a moved schema, in any file, follows it

By default it prints a unified diff and writes nothing, so `strictgen fix > fix.patch` gives a patch. `--write` writes the changed files in place instead, even when generation still fails afterwards and the exit code is 1. Only files in the schemas folder are written, and only once every file was rewritten and read back. Each goes to a temporary file first, then all are renamed into place. The renames aren't atomic as a group: if one fails, the error names the files already written. `fix` rejects a schema file with a duplicate key, which generation accepts (it keeps the last value), since a rewrite would drop one of them. A rewritten file keeps its key order, indentation, line endings and the formatting of every part no rule touched. Then `fix` generates every target in memory and prints the first error left, with the file, JSON pointer, rule and hint, and a notice for each thing a rule left as it was. It exits 1 when generation still fails, and 0 when the schemas generate.

### `examples`

`strictgen examples <type>` prints payloads of a type, named as in the generated code, one JSON value per line, or one JSON array with `--array`. They keep every rule and constraint of the schema and hold in the read mode of every configured target. `--count` sets how many (default 1) and `--seed` the seed (default 0): the same seed always gives the same output. `--invalid` prints near misses instead, each a valid payload with one thing changed and the error every decoder must report for it:

```text
$ strictgen examples Order --invalid --count 2
{"path":"/note","code":"too_long","change":"a string of 6 characters, one past the maximum","payload":{...}}
{"path":"/unexpected","code":"unknown_key","change":"added the key \"unexpected\"","payload":{...}}
```

Strings for a `pattern` are built from the pattern and kept only when it matches them within the length limits. A type the generator can't make a sure payload for, like a pattern no string matches, or a format longer than `maxLength`, exits 1 with the reason rather than print a payload that may be invalid.

### `docs`

`strictgen docs` writes a Markdown page per type and an `index.md` into the folder `docs.out` names, like `"docs": { "out": "docs/types" }`: the type's description, its type in each configured language, its fields with their constraints, a valid example, and links to the types it uses and that use it. `"format": "html"`, or `--format html`, writes one self-contained `index.html` with every type instead, with no external assets. Schema text is escaped for Markdown and HTML. The folder is shared, like a Go package: strictgen only replaces or removes the files it generated, which start with the header as an HTML comment, so hand-written pages beside them stay.

### Reserved names

A field named like a keyword is escaped where the language allows it: `r#type` and `r#match` in Rust (`self_` and `crate_` for the keywords that can't be raw), the exported field name in Go (`Type`, `Func`, `Default`), and the key as it is in TypeScript, which allows keywords as property names. A type named like a keyword, or like a name the generated code uses itself (`Self`, `Option` or `DecodeError` in Rust, `DecodeError` in Go, `Record`, `Partial` or `DecodeError` in TypeScript), fails with `reserved-name` and a hint to rename it. Only the configured targets' names apply, so a type named `Record` is fine when TypeScript isn't a target.

## Conformance

[`conformance/`](conformance) holds the cross-language proof: schemas, and cases each language must accept or reject with the same first error. `pnpm conformance` generates every language, decodes every case in Rust, Go and TypeScript in strict and report mode, and fails on any difference in the result, the error, the unknown keys or the re-encoded bytes after RFC 8785 canonicalisation. Known differences, like TypeScript integers past 2^53 - 1, are marked with a reason, never skipped. [`conformance/README.md`](conformance/README.md) describes the layout and how to add a case.

## License

[Apache License 2.0](LICENSE)
