> **Draft, not published.** The launch post for the first release, for Sahid to edit and approve. It is not linked from the README yet. Every output block below is real: `pnpm docs` makes it from the programs in [`examples/quickstart`](../examples/quickstart), and `pnpm docs:check` fails in CI when it changes.

# The hash only Go got wrong

## A bug with nothing pointing at it

In August 2026, a [pull request to the dstack SDKs](https://github.com/Dstack-TEE/dstack/pull/1024) tracked down why apps failed attestation. Each SDK computes a compose hash, the hash that identifies an app, from a JSON document. For the same document, the Go SDK computed a different hash than the JavaScript and Python SDKs. The SDK registered one hash, the guest measured another, and nothing said why.

There were two causes, both in how Go read and wrote the document:

1. **Keys went missing.** Go decoded the document into a fixed struct and encoded the struct again. Keys the struct didn't declare were gone before hashing, without an error.
2. **Characters were written differently.** Go's `encoding/json` escapes `<`, `>` and `&` as `<`, `>` and `&`. JavaScript and Python write them as they are. A [follow-up fix](https://github.com/Dstack-TEE/dstack/pull/1479), merged in October, covered U+2028 and U+2029, which Go escapes even with HTML escaping off.

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

## What strictgen doesn't change: the bytes

The second cause is about writing, not reading. Take this conformance case, a parcel whose size has HTML characters:

<!-- snippet: file conformance/cases/Parcel/valid/size-with-html-characters.json -->
```json
{"weight": 1.5, "size": "<a & b>"}
```
<!-- /snippet -->

All three languages accept it and hold the same string. But the generated Go writes it the way `encoding/json` does, as `"<a & b>"`, while Rust and TypeScript write the characters. U+2028 and U+2029 differ the same way. So a hash of the bytes each language writes would still differ between Go and the others.

strictgen doesn't hide this. The [conformance suite](../conformance/README.md) runs every case through all three languages and compares what each one writes, in canonical form (RFC 8785) and byte for byte. The canonical bytes must always match. Raw bytes may differ only where [`conformance/marks.json`](../conformance/marks.json) names the case, the kind of difference and its reason, like `html-escaping` for this case and `line-separator-escaping` for U+2028, and a mark no case needs fails the run.

The rule for hashing stays the same with or without strictgen: hash the bytes you received, or a canonical form like RFC 8785, never a value a program decoded and wrote again.

## Try it

```bash
npm install --save-dev strictgen
npx strictgen generate
```

Or download the single binary for macOS, Linux or Windows from the release, which needs no Node. The [README](../README.md) has the 30-second version, and the [playground](../playground/README.md) runs the generator and the TypeScript decoders in the browser.
