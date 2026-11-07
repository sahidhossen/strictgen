> **Draft, not published.** The launch post for the first release, for Sahid to edit and approve. It is not linked from the README yet. Every output block below is real: `pnpm docs` makes it from the programs in [`examples/quickstart`](../examples/quickstart), and `pnpm docs:check` fails in CI when it changes.

# The hash only Go got wrong

## A bug with nothing pointing at it

In August 2026, a [pull request to the dstack SDKs](https://github.com/Dstack-TEE/dstack/pull/1024), still open, tracked down why apps failed attestation. Each SDK computes a compose hash, the hash that identifies an app, from a JSON document. For the same document, the Go SDK computed a different hash than the JavaScript and Python SDKs. The SDK registered one hash, the guest measured another, and nothing said why.

It names two causes. It covers only the Go side, so both are in how the Go SDK read and wrote the document:

1. **Keys went missing.** Go decoded the document into a fixed struct and encoded the struct again. Keys the struct didn't declare were gone before hashing, without an error.
2. **Characters were written differently.** Go's `encoding/json` escapes `<`, `>` and `&` as `\u003c`, `\u003e` and `\u0026`. JavaScript and Python write them as they are. A [follow-up fix](https://github.com/Dstack-TEE/dstack/pull/1479) for U+2028 and U+2029, which Go escapes even with HTML escaping off, is the part that was merged, in October.

Neither is a bug in Go, JavaScript or Python. Each language did what its JSON library does. The bug is that three programs read one document three ways, and nobody checked that they agreed.

## The same mistake, caught

strictgen generates Rust, Go and TypeScript from one JSON Schema, and holds the three to the same answer for every input. Here is a small order schema:

<!-- snippet: file examples/quickstart/schemas/order.json -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/v1/order.json",
  "title": "Order",
  "description": "An order placed in the shop.",
  "type": "object",
  "properties": {
    "id": { "description": "The order's id.", "type": "string" },
    "quantity": { "description": "How many items.", "type": "integer", "minimum": 1, "maximum": 100 },
    "status": { "$ref": "#/$defs/status" },
    "note": { "description": "A note for the packer.", "type": "string", "maxLength": 40 }
  },
  "required": ["id", "quantity", "status"],
  "additionalProperties": false,
  "$defs": {
    "status": { "description": "Where the order is.", "enum": ["pending", "paid", "shipped"] }
  }
}
```
<!-- /snippet -->

Now the first cause: a document with a key the schema doesn't declare. The note is spelled `notes`:

<!-- snippet: file examples/quickstart/payloads/misspelled-key.json -->
```json
{ "id": "ord_7d2k", "quantity": 2, "status": "paid", "notes": "Leave at the door" }
```
<!-- /snippet -->

A decoder that skips unknown keys, like Go's `json.Unmarshal` into a plain struct, would drop the note and carry on. Here is what the generated decoders say, in each language's own program:

<!-- snippet: decode json message payloads/misspelled-key.json -->
```text
payloads/misspelled-key.json
  Rust        /notes: unknown key
  Go          /notes: unknown key
  TypeScript  /notes: unknown key
```
<!-- /snippet -->

The same path, the same code and the same message, in all three. The compact form, for logs:

<!-- snippet: decode json compact payloads/misspelled-key.json -->
```text
payloads/misspelled-key.json
  Rust        /notes unknown_key
  Go          /notes unknown_key
  TypeScript  /notes unknown_key
```
<!-- /snippet -->

No language drops the key. If unknown keys must be accepted, `"read": "report"` decodes the document and lists every unknown key with its path, again the same in every language ([read modes](read-modes.md)). There is no mode that drops a key without saying so.

## The same bytes, too

The second cause is about writing, not reading. Here is an order whose note has HTML characters:

<!-- snippet: file examples/quickstart/payloads/html-characters.json -->
```json
{ "id": "ord_7d2k", "quantity": 1, "status": "paid", "note": "Glass <fragile> & heavy" }
```
<!-- /snippet -->

Go's `json.Marshal` would write the note as `"Glass \u003cfragile\u003e \u0026 heavy"`. The generated Go package has an `Encode` function that writes strings the way Rust and TypeScript do, and the Go program uses it. Each program decodes the order and writes it again:

<!-- snippet: decode json message payloads/html-characters.json -->
```text
payloads/html-characters.json
  Rust        ok {"id":"ord_7d2k","quantity":1,"status":"paid","note":"Glass <fragile> & heavy"}
  Go          ok {"id":"ord_7d2k","quantity":1,"status":"paid","note":"Glass <fragile> & heavy"}
  TypeScript  ok {"id":"ord_7d2k","quantity":1,"status":"paid","note":"Glass <fragile> & heavy"}
```
<!-- /snippet -->

The same bytes in all three, so a hash of them is the same too. U+2028 and U+2029 are written as they are as well. A value of any JSON type, which Go keeps as the bytes it read, has its strings written the same way.

The [conformance suite](../conformance/README.md) checks this for every case. It runs each one through all three languages and compares what each writes, in canonical form (RFC 8785) and byte for byte. Raw bytes may differ only where [`conformance/marks.json`](../conformance/marks.json) names the case, the kind of difference and its reason, and a mark no case needs fails the run. What is left is the spelling of a number with a fraction or an exponent, like `1.5E+2`, which each language writes its own way, and the key order inside a value of any JSON type. Hashing a canonical form like RFC 8785 covers those as well.

The suite caught this in strictgen first. The generated Go used to write these characters the way `encoding/json` does, and the suite needed a mark for every case that had one. Now Go writes them as they are, and the marks are gone.

## Try it

```bash
npm install --save-dev strictgen
npx strictgen generate
```

Or download the single binary for macOS, Linux or Windows from the release, which needs no Node. The [README](../README.md) has the 30-second version, and the [playground](../playground/README.md) runs the generator and the TypeScript decoders in the browser.
