# Conformance suite

The proof that Rust, Go and TypeScript accept and reject exactly the same JSON, report the same first error and the same unknown keys, and encode the same value again. Every case runs through every language in strict and report mode, through each language's public entry points, through the fixture registry, through Rust's serde bridge and through the LLM decoders. Any difference is a failure, never a skip, and so is a mapping rule or error code without a case.

```bash
pnpm conformance                    # every case, both read modes, all three languages
pnpm conformance --mode report      # one read mode
pnpm conformance --lang go,ts       # leave a language out, the only way to run without its toolchain
pnpm conformance --keep             # keep the generated code and drivers, and print where they are
pnpm conformance --coverage         # how many cases cover each mapping rule and error code, without running them
```

It needs Node.js 22, Rust 1.97 or later (`cargo`) and Go 1.23 or later. A missing toolchain is an error, not a skip. With rustup, `RUSTUP_TOOLCHAIN=1.97.0 pnpm conformance` picks the toolchain. `pnpm test` runs every case through TypeScript too, without the other toolchains.

Exit codes: 0 when everything agrees, 1 on any disagreement, 2 when the run can't happen (bad arguments, a missing toolchain, a case folder that breaks the layout or the manifest, a mapping rule or error code without a case, a driver that fails to build).

## Layout

| Path | What it is |
| ---- | ---------- |
| `schemas/` | The schemas every case is decoded with, generated with the ID rule `{ "file": "common", "suffix": "Id" }` |
| `cases/<Type>/valid/<case>.json` | A document every language must accept in every read mode, with no unknown keys, and encode again to the same value |
| `cases/<Type>/invalid/<case>.json` | A document every language must reject |
| `cases/<Type>/invalid/<case>.expect.json` | The first error the invalid case must give |
| `manifest.json` | How many valid and invalid cases each type has, or why a type has none; the schema files the LLM decoders leave out; the sides of mapping rules no case can have |
| `marks.json` | The known differences between the languages, each with a reason |
| `driver/` | The Rust and Go programs that read cases, written by hand. The runner adds the generated code before it builds them |

`<Type>` is a type as the generated code names it, like `Order` or `PaymentMethod`, with its own schema root or `$defs` entry. A case name is lowercase letters, digits and dashes. Anything else in `cases/`, like a misspelled folder or an expectation without a case, fails the run.

An expectation gives the path and code of the first error in strict mode, from the fixed list in [`docs/error-codes.md`](../docs/error-codes.md):

```json
{"path": "/lines/0/quantity", "code": "too_small"}
```

When report mode reads the case differently, because the strict error is an unknown key, `report` says how. Either report mode accepts the case with these unknown key paths, in input order:

```json
{"path": "/discount", "code": "unknown_key", "report": {"unknown": ["/discount"]}}
```

or it fails with another first error:

```json
{"path": "/extra", "code": "unknown_key", "report": {"path": "/note", "code": "too_short"}}
```

`manifest.json` lists every generated type a case folder may name, with its counts, like `"Order": {"valid": 11, "invalid": 40}`, or under `empty` with the reason it has none. A case or a type folder that disappears fails the run, and so does a new one until the manifest says so.

Some cases are easier to build than to type, like nesting at the depth limit. [`scripts/conformance-cases.mjs`](../scripts/conformance-cases.mjs) writes those, with their expectations written out by hand; `node scripts/conformance-cases.mjs --check` (run by `pnpm test`) fails when one is out of date.

## Coverage

Every mapping rule needs a valid case and an invalid one, and every error code an invalid case. The rules are the constructs of the model and the constraints of [`docs/error-codes.md`](../docs/error-codes.md), each with a stable id, listed in `src/conformance/coverage.ts`:

| Ids | What they are |
| --- | ------------- |
| `object`, `object.required`, `object.optional`, `object.exactly-one`, `object.rest`, `object.recursive` | Closed objects, their keys, the keys an exactly-one `oneOf` forbids, data keys beside the named ones, and a field that closes a cycle |
| `tagged`, `tagged.recursive`, `untagged`, `untagged.recursive` | Unions with and without a tag, and a branch of each that closes a cycle |
| `enum`, `const.string`, `const.integer`, `const.boolean` | Enums and consts |
| `id`, `alias` | Ids and defs that are another type |
| `string`, `integer`, `integer.int64`, `number`, `boolean`, `any`, `non-null` | Scalars, an integer past 2^53 - 1, and any JSON value with or without null |
| `array`, `map`, `map.key` | Arrays, maps, and maps whose keys have a type of their own |
| `string.minLength` ... `format.uuid`, `integer.minimum` ... `integer.multipleOf`, `number.minimum` ... `number.exclusiveMaximum`, `array.minItems`, `array.maxItems`, `array.uniqueItems`, `map.minProperties`, `map.maxProperties` | Each constraint, per kind of value |

Which rules a case covers is worked out from the case and the model, never tagged by hand, so it can't drift. A valid case covers every rule its value is read through: each type, declaration and constraint, the way the decoders read it. An invalid case covers the rules its expected error is about, the construct at the error's path by the code: `too_long` at a string is `string.maxLength`, at an array `array.maxItems`; `too_small` is `minimum` or `exclusiveMinimum` by which bound the value breaks; the alias or id the failing value is read through counts too. A rule without a case, or a code without one, fails the run and `pnpm test`. The `coverage` section of `manifest.json` lists the sides no case can have, each with the reason, like `"any/invalid"`, since every JSON value decodes as `any`; one that gets a case fails too.

## What is compared

Each case runs in six variants of the code generated as most users generate it: strict and report mode, each through the public entry point, the fixture registry and the serde bridge. The public entry points are Go's `json.Unmarshal` into the type (`DecodeX` for a tagged union) and `Report[T]` (`ReportX`), Rust's `T::from_json` and `T::report_from_json`, and TypeScript's `decodeXFromJson` and `reportXFromJson`. Go's registry calls the shared decoder directly. Rust's and TypeScript's fixture entry points are their public ones. The serde entry is Rust's serde bridge ([`docs/serde-bridge.md`](../docs/serde-bridge.md)), on in every Rust package the runner generates: `serde_json::from_slice` into the type, whose `Deserialize` runs the strict decoder on the value's raw text. Its error must be the strict error's compact form, and then the strict error's fields stand for it; any other error is `serde_json.Error`. In report mode, the unknown keys are the paths the hook got. Go and TypeScript have no serde bridge, so they answer it through their registry and public entry points. The same public entry points run again in code generated with `llm`, whose helpers differ, for the types it has. For every variant, each language's result is compared with the others and with the expectation:

- Accept or reject
- The first error: `path` and `code` with the expectation, and all five fields, `path`, `code`, `expected`, `found` and the message, across the languages
- The unknown key paths, in input order
- The re-encoded value. Each language's output is canonicalised by RFC 8785 (keys sorted by UTF-16 code units, numbers written as ECMAScript writes a double, no whitespace) and compared, with each other and with the case itself, without its unknown keys. Integers past 2^53 - 1 keep their exact digits, so two different 64-bit values never compare equal by rounding to the same double
- The bytes as written. Once the canonical bytes agree, the bytes each language wrote must be equal too, unless the case carries a mark that allows a difference. An integer written `5.0` by one language and `5` by another is such a difference. Go writes through the generated `Encode`, and `json.Marshal` must write the same JSON value, or the case fails with `crash`
- A decoder that throws or panics instead of returning an error is always a failure

A failure prints a table with a row per field that differs, a column per language and one for the expectation. Whole documents show the text around their first difference, with its offset, and characters that aren't printable ASCII show as `<U+2028>`, so a character and its escape look different.

## The LLM decoders

Every case also runs through the LLM decoders (`decodeXFromLlm`, `DecodeXFromLlm`, `decode_x_from_llm`), in the form a model sends for the type's provider-ready schema: `null` for each optional key that is absent, a type that isn't a struct wrapped as `{"value": ...}`, and each map as entries, `[{"key": ..., "value": ...}]`, or kept as an object. The case is projected on its own text, so number spellings and 64-bit integers reach the decoders as the case writes them. The decoders come from code generated in four ways: with profiles that give both map shapes (openai, anthropic and gemini), in strict and in report mode, each given both shapes; with one that gives entries only (openai); and with one that gives objects only (gemini).

- A valid case must decode, and its value must encode to the same canonical bytes as the case itself: the LLM value equals the normal value
- An invalid case must fail with its strict error, since LLM decoders are strict in every read mode, at the path in the payload: `/value/...` under the wrapper, `/labels/0/value` for a member of a map read from entries, `/labels/0/key` when the member's key breaks the key's type. A mark's path moves the same way
- Invalid cases whose meaning the LLM form changes are left out, and the run says how many and why, for each variant: text the projection can't read as one JSON value (a key given twice, bytes that aren't UTF-8), `null` for an optional key that causes the error (the null itself, or one that keeps an untagged union from taking its value), which means absent there, an array where a map goes, which is that map's entries for code that reads entries, and nesting that crosses the depth limit in one form only
- Each valid case adds near misses only the LLM form has, each with its own expectation: no `value` key, a key beside it, the value without the object around it, entries that are a string, repeat a key, lack a key or a value, have a third key, a number for a key or an array for an entry, a payload cut short, a key given twice, and, for code that reads one shape, a case's one map in the other shape
- Each invalid case that fails a constraint adds the same payload with a third key in its first entry, which must fail first with `unknown_key` there, since the structure of the whole value is checked before any constraint

The schema files whose types no provider-ready schema can describe, like a value of any JSON type or a recursive type, are left out of the code generated with `llm`, each listed in the `llm` section of `manifest.json` with the reason. Every other file must project under every profile, and every listed one must fail to.

The shared vectors of [`examples/llm`](../examples/llm) run too, in report mode only, in code generated from its config. LLM decoders are strict in both modes, so strict mode would run the same checks again, and the example's own tests run the vectors in strict mode already: each LLM vector through the LLM decoder, compared with its error's compact form or with the normal JSON of its value, which the normal decoder must take too, and each cleanup vector through the cleanup step, whose output must be exactly the vector's. A vector carries no marks: its bytes as written must match in every language.

## Known differences

`marks.json` lists the cases where the languages are allowed to differ, each with a reason. A marked case still runs. Every mark must be needed: when a full run (every language, both modes) passes without one, that mark fails the run.

Marks that hold one language to a stated result instead of comparing it:

| Kind | What must hold |
| ---- | -------------- |
| `ts-unsafe-integer` | TypeScript integers stop at 2^53 - 1, where Rust and Go hold 64 bits. TypeScript must reject the case with `out_of_range_integer` at the mark's `path`, naming its own range |
| `ts-no-bytes-api` | The TypeScript decoders take a string, so bytes that aren't UTF-8 never reach them. TypeScript must reject the case with `invalid_json` at the root; Rust and Go are compared on every field |
| `go-unmarshal-syntax` | `json.Unmarshal` checks the syntax itself before the generated decoder runs. Through Go's public entry point in strict mode, Go must reject text that isn't JSON with its own `*json.SyntaxError`; its other variants are compared as usual |
| `serde-outer-parse` | `serde_json::from_slice` checks the syntax and UTF-8 of the text itself before the serde bridge gets the value's raw text. Through the serde entry, in both modes, Rust must reject such text with `serde_json.Error` at the root, with a message that isn't a strict compact form, so a bridge error can't hide behind the mark; its other entries are compared as usual |

Marks that let the bytes as written differ in one way only, once the canonical bytes are equal:

| Kind | What may differ |
| ---- | --------------- |
| `number-spelling` | How a number is spelled, like `150.0`, `1.50E+2` and `150` |
| `key-order` | The order of an object's keys |

## How it runs

The runner (`src/conformance`) generates every language for `schemas/` into a temporary folder, once per package. It builds one Rust binary and one Go binary over the generated code, and transpiles the generated TypeScript for a Node program, `src/conformance/ts-runner.ts`. Each driver reads every case of the run in one process, which is stopped when it takes too long, so a decoder that never returns fails the run instead of hanging it: one JSON request per line on stdin, like `{"id": 0, "type": "Order", "mode": "strict", "decoder": "normal", "entry": "public", "package": "strict", "hex": "7b7d"}`, and one JSON result per line on stdout:

```json
{"id": 0, "accepted": false, "error": {"path": "/id", "code": "missing_key", "expected": null, "found": null, "message": "/id: missing key"}, "unknown": null, "encoded": null, "encodeError": null}
```

The input is hex, since a case may be bytes that aren't UTF-8. `decoder` picks what reads it: `normal`, `llm`, or `cleanup` for the cleanup step, whose result carries the text it returned in `encoded`. `entry` picks the public entry point, the fixture registry or the serde bridge (`serde`), and `package` the generated code: `strict` and `report`, `strict_llm_both`, `report_llm_both`, `strict_llm_entries` and `strict_llm_objects` for code generated with `llm`, and `report_llm_vectors` for `examples/llm`. Cargo keeps its build in `driver/rust/target`, so later runs only rebuild the generated code. The temporary folder is removed when the run ends, fails or is stopped with Ctrl-C.

## Fuzzing

```bash
pnpm fuzz --seed 1 --runs 3000      # what every pull request runs
pnpm fuzz --runs 100000             # a random seed, printed first, like the nightly run
pnpm fuzz --seed 7 --start 812 --runs 1   # one run of a long run alone
pnpm fuzz --seed 7 --start 812 --runs 1 --save go   # keep its shrunk case, with Go's answer as the expectation
```

Each run seeds the payload generator of `src/payloads.ts` from the seed and its own index, so run 812 of seed 7 is the same whatever runs before it. It picks a type with cases, then makes one valid payload of it, up to three of its near misses that fail the same way in both read modes, one unknown key, which fails in strict mode and is reported in report mode, and one cleanup input. Every payload runs through every variant above, in batches through the same drivers, the LLM decoders included, in the LLM form of each map shape, with the near misses only that form has. The cleanup input is the valid payload with a byte order mark, white space, a code fence and trailing commas, at random, and the cleanup step must give back exactly the payload, in every language.

Nobody knows the right answer for a random payload, so the languages must agree with each other on every field compared above, and with the generator's labels: a valid payload is accepted with no unknown keys and encodes to its own canonical bytes, and a near miss fails with the generator's path and code, in Rust and Go as in TypeScript. In report mode the unknown key's payload is accepted with that one key reported. Near misses of `multipleOf` include values on both sides of zero, where a remainder changes sign.

A fuzz payload has no entry in `marks.json`, so its marks come from the payload: `number-spelling` when a number has a fraction or an exponent, and `ts-unsafe-integer` at the first integer past 2^53 - 1. The marked language must still do exactly what the kind states, but a fuzz mark need not be needed, since most payloads that could differ don't.

A disagreement fails the run. It prints the seed, the run, what the generator changed, the payload as JSON and as hex, and the table, then shrinks the payload: it removes keys and items, shortens strings and keys and simplifies numbers, one step at a time, in a fixed order, keeping each step only while the languages still disagree on the same fields, split the same way (like `result: go | rust,ts`). A payload read through the LLM decoders is shrunk in its normal JSON and projected again. When the languages agree with each other but not with the generator's label, there is nothing to shrink, and the label is checked against [`docs/error-codes.md`](../docs/error-codes.md).

`--save <language>` writes the shrunk case as `cases/<Type>/{valid,invalid}/fuzz-<hash>.json`, named by the hash of its text, with the expectation that language gives in strict and report mode and the type's count in `manifest.json`, and prints every language's answer beside the saved one. The language is the one the spec says is right, which the fuzzer can't decide; without it, the case is only printed. It writes nothing when that language crashed, when the case would need a mark, or when the input isn't a payload in normal JSON, like an LLM-only near miss or a cleanup input. Then fix the generator in the same pull request.

Exit codes as for `pnpm conformance`: 0 when every run agrees, 1 on a disagreement, 2 when the run can't happen.

## Adding a case

1. Pick the type, or add a schema to `schemas/` for a construct no type covers yet
2. Write the case. Characters that are hard to see, like U+2028 or a byte order mark, go in as JSON escapes written by a script, never typed
3. For an invalid case, write the expected first error, and `report` when report mode differs. The LLM form's expectation follows from it
4. Update the type's counts in `manifest.json`. `pnpm conformance --coverage` shows which rules the cases cover
5. Run `pnpm conformance`. A case only one language gets right is the point: decide from the spec which language is wrong and fix the generator, not the case. A difference in the bytes as written either gets a mark with its reason, when the canonical bytes are what the spec asks to match, or a generator fix
