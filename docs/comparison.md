# Comparison with other tools

strictgen does one narrow thing: from a strict subset of JSON Schema, it generates Rust, Go and TypeScript decoders that are proven to accept and reject the same JSON. Many good tools overlap with part of that, and several are the better pick for a job strictgen doesn't try to do. The facts below were checked against each tool's own docs in November 2026. Tools change, so follow the links for the current state.

## In short

| Tool | Reads | Writes | Checks data at run time | Unknown keys | Pick it when |
| ---- | ----- | ------ | ----------------------- | ------------ | ------------ |
| strictgen | A strict subset of JSON Schema 2020-12 | Rust, Go, TypeScript, LLM provider schemas | Yes, in every language, with the same errors | Rejected, or reported in `report` mode | Two or three of these languages share JSON and must agree |
| [quicktype](https://github.com/glideapps/quicktype) | JSON samples, JSON Schema, TypeScript, GraphQL | About 20 languages | In some targets, like JavaScript and TypeScript | Configurable in the TypeScript checks | You have samples rather than a schema, or need many languages |
| [typify](https://github.com/oxidecomputer/typify) | JSON Schema | Rust | Through `serde`; value constraints not enforced | `deny_unknown_fields` for a closed object | Rust only, with idiomatic `serde` types and broad schema support |
| [json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript) | JSON Schema | TypeScript types | No | An index signature unless the schema closes the object | TypeScript types for a large existing schema, validated elsewhere |
| [go-jsonschema](https://github.com/omissis/go-jsonschema) | JSON Schema | Go | Yes: required keys, enums and several constraints | Ignored by default | Go only, with YAML too and wider keyword support |
| [typeshare](https://github.com/1Password/typeshare) | Rust source | TypeScript, Swift, Kotlin, Scala, and Go and Python as experiments | No | Not its concern | Rust is the source of truth for mobile or web clients |
| [JSON Type Definition](https://www.rfc-editor.org/rfc/rfc8927.html) | JTD schemas (RFC 8927) | C#, Go, Java, Python, Rust, TypeScript, with [jtd-codegen](https://github.com/jsontypedef/json-typedef-codegen) | With separate validators | Rejected by default | You can adopt a small schema language that is strict by default |
| [BAML](https://github.com/BoundaryML/baml) | Its own language for LLM functions | Python, TypeScript, Ruby and Go clients, and others like Rust, Java and C# over REST | Yes, with lenient repair of model output | Repaired by lenient parsing | You want prompts, model calls, tests and parsing of LLM output in one tool |

## quicktype

[quicktype](https://github.com/glideapps/quicktype) ([site](https://quicktype.io)) infers types from JSON samples, JSON Schema, TypeScript (experimental) and GraphQL queries, and writes them in about 20 languages, among them Rust, Go, TypeScript, Swift, Kotlin, C# and Python. Its JavaScript and TypeScript output checks `JSON.parse` results at run time by default (`runtime-typecheck`), and unknown properties fail that check unless `runtime-typecheck-ignore-unknown-properties` is set. Its Go output is structs with `json` tags for `encoding/json`.

Pick quicktype when you have example payloads and no schema, when you need a language strictgen doesn't write, or when you want types quickly and the readers don't have to agree on every edge. strictgen differs in that the three languages are generated from one model and tested against each other: the same unknown key, `null` or integer spelling gets the same answer and the same error in Rust, Go and TypeScript, and that is checked by a conformance suite rather than left to each language's JSON library.

## typify

[typify](https://github.com/oxidecomputer/typify) turns JSON Schema into idiomatic Rust types with `serde`, through a macro (`import_types!`), the `cargo typify` command, or a builder for `build.rs`. A closed object (`additionalProperties: false`) gets `#[serde(deny_unknown_fields)]`, so unknown keys fail. Its README notes that value constraints, like bounded numbers, aren't enforced by the generated types.

Pick typify for a Rust-only project, for broad JSON Schema support, or when you want plain `serde` derives that fit the rest of your Rust code. strictgen accepts a smaller subset, and in return checks every constraint it accepts in the decoder, reports errors with a JSON Pointer and a stable code, and generates Go and TypeScript that agree with the Rust. Its Rust types use a strict decoder of their own (`from_json`). They get `serde` `Deserialize` only with the optional [serde bridge](serde-bridge.md), which runs that same strict decoder, so they can sit inside your own serde types.

## json-schema-to-typescript

[json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript) compiles JSON Schema to TypeScript declarations: types only, no run time checks. Its `additionalProperties` option defaults to `true` for a schema that doesn't set it, so open objects get an index signature. Its schema model is draft 4, with most of drafts 6 and 7, and a list of 2019-09 and 2020-12 keywords it ignores.

Pick it when you need types for a large or loose schema and validate data with a validator such as [Ajv](https://ajv.js.org), which supports drafts up to 2020-12. strictgen differs in generating the decoder too, so the type and the check can't drift, and in failing generation on keywords it can't check rather than ignoring them.

## go-jsonschema

[go-jsonschema](https://github.com/omissis/go-jsonschema) generates Go types from JSON Schema, with `UnmarshalJSON` code that checks the input against the schema's rules: required keys, `enum`, `const`, string lengths, `pattern` and number bounds, among others. Extra keys go into an `AdditionalProperties` map when the schema gives them a schema. Without that, from its test data, unknown keys are ignored as in `encoding/json`.

Pick go-jsonschema for a Go-only service, for YAML input, or for keywords strictgen doesn't take. strictgen differs in rejecting or reporting every unknown key, in its fixed error shape, and in generating Rust and TypeScript that decode the same JSON the same way.

## typeshare

[typeshare](https://github.com/1Password/typeshare) reads Rust types marked `#[typeshare]` and writes the same types in TypeScript, Swift, Kotlin and Scala, with Go and Python behind feature flags. The input is Rust source, not a schema, and the output is type definitions.

Pick typeshare when Rust is where your types live and you want matching types in mobile or web clients, for example across an FFI boundary. strictgen starts from a schema instead, which suits contracts between services that no one language owns, and adds decoders that check the data.

## JSON Type Definition

[JSON Type Definition](https://www.rfc-editor.org/rfc/rfc8927.html) (JTD, RFC 8927, an experimental RFC) is a small schema language built for code generation. Objects reject extra properties unless a schema opts in with `"additionalProperties": true`. [jtd-codegen](https://github.com/jsontypedef/json-typedef-codegen) writes types for C#, Go, Java, Python, Rust and TypeScript, and the [jsontypedef](https://github.com/jsontypedef) organisation has validators for several languages. jtd-codegen's last release is from 2021.

Pick JTD when you can choose the schema language and want strict defaults and validators in languages strictgen doesn't cover. strictgen stays with JSON Schema, which most teams and tools already have, and generates the checks into each language rather than next to it.

## BAML

[BAML](https://github.com/BoundaryML/baml) ([docs](https://docs.boundaryml.com)) is a language for LLM functions: prompts, the types they return, model clients, tests and an editor playground, with generated clients for Python, TypeScript, Ruby and Go. Other languages, like Rust, Java and C#, call BAML functions over a [REST API](https://docs.boundaryml.com/guide/installation-language/rest-api-other-languages), with clients generated from OpenAPI (a preview feature). Its [schema-aligned parsing](https://boundaryml.com/blog/schema-aligned-parsing) repairs malformed model output: missing quotes and commas, comments, extra prose around the JSON, misnamed keys.

Pick BAML when you want the whole LLM workflow in one tool, and when getting a usable answer from imperfect output matters more than rejecting it. strictgen is the other way round. It gives each provider a schema it accepts, then decodes the answer strictly, with the same checks as every other payload, and returns a compact error to send back to the model. Its cleanup step fixes only a code fence, a byte order mark and trailing commas, never a key or a value. Prompts, model calls and retries stay in your code.

## Where strictgen differs

- **Proven agreement.** The [conformance suite](../conformance) runs every case through Rust, Go and TypeScript, in both read modes, through the public entry points and the LLM decoders, and fails on any difference in the result, the error, the unknown keys or the canonical (RFC 8785) bytes written again. A differential fuzzer runs random payloads and near misses through the same decoders on every pull request, and a longer run every night
- **No silent drops.** An unknown key fails the decode, or is reported in `report` mode. A keyword strictgen can't check the same way in every language fails generation instead of being ignored
- **Breaking checks.** [`strictgen breaking`](breaking-changes.md) compares two versions of the schemas and says who each change breaks: strict consumers, all consumers or producers
- **LLM profiles.** The same schema becomes the subset each provider accepts ([llm.md](llm.md)), and the decoders check what the provider couldn't

And where it doesn't try to compete: it reads only its subset of JSON Schema, writes three languages, and generates data types and decoders, not API clients, protobuf or GraphQL types.
