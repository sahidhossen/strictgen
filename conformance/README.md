# Conformance suite

The proof that Rust, Go and TypeScript accept and reject exactly the same JSON, report the same first error and the same unknown keys, and encode the same value again. Every case runs through every language in strict and report mode, through each language's public entry points and through the fixture registry. Any difference is a failure, never a skip.

```bash
pnpm conformance                    # every case, both read modes, all three languages
pnpm conformance --mode report      # one read mode
pnpm conformance --lang go,ts       # leave a language out, the only way to run without its toolchain
pnpm conformance --keep             # keep the generated code and drivers, and print where they are
```

It needs Node.js 22, Rust 1.97 or later (`cargo`) and Go 1.23 or later. A missing toolchain is an error, not a skip. With rustup, `RUSTUP_TOOLCHAIN=1.97.0 pnpm conformance` picks the toolchain. `pnpm test` runs every case through TypeScript too, without the other toolchains.

Exit codes: 0 when everything agrees, 1 on any disagreement, 2 when the run can't happen (bad arguments, a missing toolchain, a case folder that breaks the layout or the manifest, a driver that fails to build).

## Layout

| Path | What it is |
| ---- | ---------- |
| `schemas/` | The schemas every case is decoded with, generated with the ID rule `{ "file": "common", "suffix": "Id" }` |
| `cases/<Type>/valid/<case>.json` | A document every language must accept in every read mode, with no unknown keys, and encode again to the same value |
| `cases/<Type>/invalid/<case>.json` | A document every language must reject |
| `cases/<Type>/invalid/<case>.expect.json` | The first error the invalid case must give |
| `manifest.json` | How many valid and invalid cases each type has, or why a type has none |
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

## What is compared

Each case runs in four variants: strict and report mode, each through the public entry point and the fixture registry. The public entry points are Go's `json.Unmarshal` into the type (`DecodeX` for a tagged union) and `Report[T]` (`ReportX`), Rust's `T::from_json` and `T::report_from_json`, and TypeScript's `decodeXFromJson` and `reportXFromJson`. Go's registry calls the shared decoder directly. Rust's and TypeScript's fixture entry points are their public ones. For every variant, each language's result is compared with the others and with the expectation:

- Accept or reject
- The first error: `path` and `code` with the expectation, and all five fields, `path`, `code`, `expected`, `found` and the message, across the languages
- The unknown key paths, in input order
- The re-encoded value. Each language's output is canonicalised by RFC 8785 (keys sorted by UTF-16 code units, numbers written as ECMAScript writes a double, no whitespace) and compared, with each other and with the case itself, without its unknown keys. Integers past 2^53 - 1 keep their exact digits, so two different 64-bit values never compare equal by rounding to the same double
- The bytes as written. Once the canonical bytes agree, the bytes each language wrote must be equal too, unless the case carries a mark that allows a difference. An integer written `5.0` by one language and `5` by another is such a difference
- A decoder that throws or panics instead of returning an error is always a failure

A failure prints a table with a row per field that differs, a column per language and one for the expectation. Whole documents show the text around their first difference, with its offset, and characters that aren't printable ASCII show as `<U+2028>`, so a character and its escape look different.

## Known differences

`marks.json` lists the cases where the languages are allowed to differ, each with a reason. A marked case still runs. Every mark must be needed: when a full run (every language, both modes) passes without one, that mark fails the run.

Marks that hold one language to a stated result instead of comparing it:

| Kind | What must hold |
| ---- | -------------- |
| `ts-unsafe-integer` | TypeScript integers stop at 2^53 - 1, where Rust and Go hold 64 bits. TypeScript must reject the case with `out_of_range_integer` at the mark's `path`, naming its own range |
| `ts-no-bytes-api` | The TypeScript decoders take a string, so bytes that aren't UTF-8 never reach them. TypeScript must reject the case with `invalid_json` at the root; Rust and Go are compared on every field |
| `go-unmarshal-syntax` | `json.Unmarshal` checks the syntax itself before the generated decoder runs. Through Go's public entry point in strict mode, Go must reject text that isn't JSON with its own `*json.SyntaxError`; its other variants are compared as usual |

Marks that let the bytes as written differ in one way only, once the canonical bytes are equal:

| Kind | What may differ |
| ---- | --------------- |
| `number-spelling` | How a number is spelled, like `150.0`, `1.50E+2` and `150` |
| `line-separator-escaping` | U+2028 and U+2029 escaped or written as they are. Go escapes them |
| `html-escaping` | `<`, `>` and `&` escaped or written as they are. Go's `json.Marshal` escapes them |
| `string-escaping` | Any character of a string or key escaped or written as it is |
| `key-order` | The order of an object's keys |

## How it runs

The runner (`src/conformance`) generates every language for `schemas/` into a temporary folder, once per read mode. It builds one Rust binary and one Go binary over the generated code, and loads the generated TypeScript in process. Each binary reads every case of the run in one process: one JSON request per line on stdin, like `{"id": 0, "type": "Order", "mode": "strict", "decoder": "normal", "entry": "public", "hex": "7b7d"}`, and one JSON result per line on stdout:

```json
{"id": 0, "accepted": false, "error": {"path": "/id", "code": "missing_key", "expected": null, "found": null, "message": "/id: missing key"}, "unknown": null, "encoded": null, "encodeError": null}
```

The input is hex, since a case may be bytes that aren't UTF-8. `decoder` picks the decoder that reads it; only the normal one runs for now. `entry` picks the public entry point or the fixture registry. Cargo keeps its build in `driver/rust/target`, so later runs only rebuild the generated code. The temporary folder is removed when the run ends, fails or is stopped with Ctrl-C.

## Adding a case

1. Pick the type, or add a schema to `schemas/` for a construct no type covers yet
2. Write the case. Characters that are hard to see, like U+2028 or a byte order mark, go in as JSON escapes written by a script, never typed
3. For an invalid case, write the expected first error, and `report` when report mode differs
4. Update the type's counts in `manifest.json`
5. Run `pnpm conformance`. A case only one language gets right is the point: decide from the spec which language is wrong and fix the generator, not the case. A difference in the bytes as written either gets a mark with its reason, when the canonical bytes are what the spec asks to match, or a generator fix
