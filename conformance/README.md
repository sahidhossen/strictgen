# Conformance suite

The proof that Rust, Go and TypeScript accept and reject exactly the same JSON, report the same first error and the same unknown keys, and encode the same value again. Every case runs through every language in strict and report mode. Any difference is a failure, never a skip.

```bash
pnpm conformance                    # every case, both read modes, all three languages
pnpm conformance --mode report      # one read mode
pnpm conformance --lang go,ts       # leave a language out, the only way to run without its toolchain
pnpm conformance --keep             # keep the generated code and drivers, and print where they are
```

It needs Node.js 22, Rust 1.97 or later (`cargo`) and Go 1.23 or later. A missing toolchain is an error, not a skip. With rustup, `RUSTUP_TOOLCHAIN=1.97.0 pnpm conformance` picks the toolchain. `pnpm test` runs every case through TypeScript too, without the other toolchains.

Exit codes: 0 when everything agrees, 1 on any disagreement, 2 when the run can't happen (bad arguments, a missing toolchain, a case folder that breaks the layout, a driver that fails to build).

## Layout

| Path | What it is |
| ---- | ---------- |
| `schemas/` | The schemas every case is decoded with, generated with the ID rule `{ "file": "common", "suffix": "Id" }` |
| `cases/<Type>/valid/<case>.json` | A document every language must accept in every read mode, with no unknown keys, and encode again to the same value |
| `cases/<Type>/invalid/<case>.json` | A document every language must reject |
| `cases/<Type>/invalid/<case>.expect.json` | The first error the invalid case must give |
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

## What is compared

For every case and read mode, each language's result is compared with the others and with the expectation:

- Accept or reject
- The first error: `path` and `code` with the expectation, and all five fields, `path`, `code`, `expected`, `found` and the message, across the languages
- The unknown key paths, in input order
- The re-encoded value. Each language's output is canonicalised by RFC 8785 (keys sorted by UTF-16 code units, numbers written as ECMAScript writes a double, no whitespace) and compared, with each other and with the case itself, without its unknown keys. Integers past 2^53 - 1 keep their exact digits, so two different 64-bit values never compare equal by rounding to the same double
- A decoder that throws or panics instead of returning an error is always a failure

A failure prints a table with a row per field that differs, a column per language and one for the expectation.

## Known differences

`marks.json` lists the cases where the languages are allowed to differ, each with a reason. A marked case still runs, and must still differ in exactly the stated way, so a mark that no longer applies fails the run:

| Kind | What must hold |
| ---- | -------------- |
| `ts-unsafe-integer` | TypeScript integers stop at 2^53 - 1, where Rust and Go hold 64 bits. TypeScript must reject the case with `out_of_range_integer` at the mark's `path`, naming its own range. Rust and Go are checked as usual |
| `number-spelling` | The languages spell a number differently when they encode it again, like `150.0`, `1.50E+2` and `150`. The bytes must differ, and be equal once canonical |
| `line-separator-escaping` | Go escapes U+2028 and U+2029, the others write the characters. One output must hold the escape and another the character, and they must be equal once canonical |

Number spelling and escaping only show in the bytes before canonicalisation, which the suite doesn't compare otherwise. Their marked cases pin down that canonicalisation is what makes them equal. They are checked only when all three languages run.

## How it runs

The runner (`src/conformance`) generates every language for `schemas/` into a temporary folder, once per read mode. It builds one Rust binary and one Go binary over the generated code, and loads the generated TypeScript in process. Each binary reads every case of the run in one process: one JSON request per line on stdin, like `{"id": 0, "type": "Order", "mode": "strict", "decoder": "normal", "hex": "7b7d"}`, and one JSON result per line on stdout:

```json
{"id": 0, "accepted": false, "error": {"path": "/id", "code": "missing_key", "expected": null, "found": null, "message": "/id: missing key"}, "unknown": null, "encoded": null, "encodeError": null}
```

The input is hex, since a case may be bytes that aren't UTF-8. `decoder` picks the decoder that reads it; only the normal one runs for now. Cargo keeps its build in `driver/rust/target`, so later runs only rebuild the generated code.

## Adding a case

1. Pick the type, or add a schema to `schemas/` for a construct no type covers yet
2. Write the case. Characters that are hard to see, like U+2028 or a byte order mark, go in as JSON escapes written by a script, never typed
3. For an invalid case, write the expected first error, and `report` when report mode differs
4. Run `pnpm conformance`. A case only one language gets right is the point: decide from the spec which language is wrong and fix the generator, not the case
