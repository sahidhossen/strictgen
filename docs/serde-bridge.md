# Rust serde bridge

Generated Rust types decode with their own strict reader, `T::from_json`, so they report the same errors as Go and TypeScript. They don't implement serde's `Deserialize` by default. The serde bridge adds it, so a generated type can sit inside your own serde types and decode as part of a bigger document, still strictly.

## Turning it on

Set `serdeBridge` on the Rust target:

```json
{
  "targets": {
    "rust": { "out": "src/generated", "serdeBridge": true }
  }
}
```

The bridge needs serde_json's `raw_value` feature:

```toml
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = { version = "1", features = ["raw_value"] }
```

With `serdeBridge` off (the default), the generated code is exactly what it was without the option, and serde_json's default features are enough.

## What it generates

Every generated type that implements `Decode` gets a `Deserialize` impl: structs, enums, tagged and untagged unions, constrained aliases (which are newtypes) and ID types. From `examples/basic`:

```rust
impl<'de> serde::Deserialize<'de> for UserId {
    /// Decodes the value's raw JSON text from serde_json strictly, with `Decode::from_json`.
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        helpers::deserialize_strict(deserializer)
    }
}
```

`helpers::deserialize_strict` asks serde_json for the raw JSON text of the value (a `Box<serde_json::value::RawValue>`) and decodes that text with `Decode::from_json`. So inside the value, every check `from_json` makes still holds: unknown keys, missing keys, `null` for an optional key, a key given twice, `12.0` or `1e2` for an integer, the depth limit and every constraint.

A plain type alias, like `pub type Names = Vec<String>`, is not a type of its own, so Rust allows no impl on it. It deserializes the way its target does:

- An alias of a generated type, like `pub type ItemAlias = Item`, uses that type's bridge.
- An alias of a standard type, like `Vec<String>` or `BTreeMap<String, Order>`, uses serde's own impl for it, which is not strict. Generated types inside it still use their bridge. Decode such an alias with `from_json` (`<Names as Decode>::from_json(text)`) to keep it strict.

## Errors

A strict error inside the bridge becomes a serde error made with `serde::de::Error::custom`. Its message is the compact form of the `DecodeError`, and serde_json adds the position in the whole document:

```rust
#[derive(Deserialize)]
struct Checkout {
    order: Order,
    note: String,
}

let text = r#"{"note":"gift","order":{"id":"ord_5h1c","note":"ab","quantity":1.0,"price":0.5,"tags":["a"]}}"#;
let error = serde_json::from_str::<Checkout>(text).unwrap_err();
// /quantity wrong_type, expected an integer, found 1.0 at line 1 column 93
```

The path is relative to the bridged value: `/quantity`, not `/order/quantity`. The byte offset in the `found` of `invalid_json` and `duplicate_key` counts from the start of the value too:

```text
/price duplicate_key, found "price" at offset 67 at line 1 column 101
```

The `DecodeError` itself is lost: serde errors carry a message only. When you need the fields (`path`, `code`, `expected`, `found`), use `from_json`.

## Read modes

The bridge calls `from_json`, so it follows the target's `read` mode. In report mode, unknown keys inside the value are accepted, and their paths, relative to the value, go to the hook set with `set_unknown_key_hook`, the same way a plain `from_json` reports them. `report_from_json`, which returns the paths with the value, has no serde form. See [read-modes.md](read-modes.md).

## What stays serde's

The bridge makes the generated value strict, not the document around it. serde parses your own types the way it always does:

- Your structs ignore unknown keys unless you add `#[serde(deny_unknown_fields)]`.
- A serde map, like `BTreeMap<String, Order>`, keeps the last of two equal keys without an error.
- serde_json checks the syntax and UTF-8 of the whole document before the bridge sees the value. A byte order mark, a byte that isn't UTF-8 or a syntax error anywhere fails with serde_json's own error, like `expected value at line 1 column 1`, not with `invalid_json`. It is still rejected, just with another message.

The bridge needs the raw text of the value, which only serde_json gives:

- `serde_json::from_str`, `from_slice` and `from_reader` work.
- `serde_json::from_value` works, but a `serde_json::Value` has already dropped a key given twice and respelled numbers, so the strict checks see the `Value`'s own text.
- A deserializer that isn't serde_json's fails. So do serde attributes that buffer the input first: `#[serde(flatten)]`, and untagged or internally tagged enums of your own around a generated type (`invalid type: newtype struct, expected any valid JSON value`).

## `from_json` or the bridge

Use `from_json` when the generated type is the whole document: a request body, a webhook payload, a message from a queue. It checks every byte, returns the full `DecodeError` and has no extra dependency.

Use the bridge when a generated type is one part of a document your own serde types describe, like an envelope with metadata around an order, or a config file with one section that a schema defines. The generated part is checked as strictly as `from_json` would, and the rest is up to serde.

## Proof

The conformance suite runs every case through the bridge too, as the `serde` entry (`serde_json::from_slice` into the type) in both read modes. It must accept and reject exactly what `from_json` does, with the same error fields and message, and report the same unknown keys. The four cases where serde_json refuses the text before the bridge runs (a byte order mark, bytes that aren't UTF-8 at the root and in a string, and invalid JSON in an unknown key's value) carry a `serde-outer-parse` mark in `conformance/marks.json`, which holds Rust to serde_json's own error at the root there.
