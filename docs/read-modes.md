# Read modes

A consumer that rejects unknown keys breaks the day a sender adds a field. One that accepts them quietly can lose data without anyone knowing. strictgen has two read modes and no silent one, set per target with `read`:

```json
{
  "targets": {
    "rust": { "out": "src/generated", "read": "report" },
    "go": { "out": "types", "read": "report" },
    "typescript": { "out": "src/generated", "read": "report" }
  }
}
```

| Mode | Unknown keys |
| ---- | ------------ |
| `strict` (default) | fail with `unknown_key` at the key's pointer, like `/customer/nickname` |
| `report` | are accepted. Every decode collects their paths, gives them to one hook, and the report functions return them with the value |

Report mode suits webhooks and events from a sender you don't control. Each target has its own mode, so a service can read strictly in one language and report in another, but the languages agree on what each mode accepts and reports.

## What stays strict

Only unknown keys change. In both modes:

- Required keys, types, enum values, consts and tags are checked, and their errors are the same as in strict mode (see [error-codes.md](error-codes.md))
- JSON syntax is checked: a key given twice, invalid syntax and nesting past the depth limit fail, inside an unknown key's value too
- An exactly-one choice, like a customer reachable by email or by phone, still fails on a value with both. A key that a sibling branch names is not unknown
- Encoders are strict. A value never holds the unknown keys, so an encoder never writes them, and a value with a key its type doesn't name fails to encode as before
- LLM decoders are strict, since a provider-ready schema closes every object: an unknown key fails, and the hook is never called ([llm.md](llm.md#decoders))

The value of an unknown key is not decoded: only the key's path is reported.

## Paths

Each path is the JSON Pointer of the unknown key itself, the same path `unknown_key` has in strict mode, with `~` written `~0` and `/` written `~1`. Paths are relative to the value being decoded, or in TypeScript under the `path` argument when one is given.

They come in input order: the order the keys appear in the JSON text, which is a depth-first walk of the document with each object's keys in their order. For

```json
{ "source": "web", "lines": [{ "sku": "A-1", "quantity": 2, "giftWrap": true }], "id": "ord_7d2k", "extra": 1 }
```

the paths are `/source`, `/lines/0/giftWrap`, `/extra`, whatever order the schema lists the keys in. In TypeScript, a value from `JSON.parse` has lost that order for keys like `"1"`, which a JavaScript object lists first; the `FromJson` functions read the text and keep it.

A struct with a map of the other keys (`additionalProperties` with a schema) has no unknown keys: the map takes them.

## Unions

A tagged union decodes only the branch its tag names, so the keys of another branch are unknown to it.

An untagged union tries its variants in order. A variant that fails is discarded with every unknown key it met, so the paths come only from the variant that decoded. If the courier variant of a delivery reads the carrier, meets an unknown key in it and then fails on a missing `trackingCode`, and the pickup variant then decodes, the carrier's unknown key is reported once, by the pickup variant.

A variant may decode in report mode where it failed in strict mode, because unknown keys no longer fail it. So a value with the keys of two variants, which strict mode rejects as fitting neither, decodes in report mode as the first variant that takes it, and the keys only the other variant names are reported as unknown. With a card variant `{ "last4" }` before a bank variant `{ "iban" }`, `{ "last4": "4242", "iban": "DE89370400440532013000" }` decodes as the card, with `/iban` unknown. An exactly-one choice is the exception: a key a sibling branch names is not unknown, so a value with both still fails.

## The hook

Each language has one hook, set once at start up, that every decode calls with the paths of its unknown keys, for logging or counting them in one place. A decode calls it after the value decoded, only when there is at least one unknown key, and before it returns. A decode that fails calls nothing. Setting a hook replaces the one before.

## API

| | TypeScript | Go | Rust |
| - | ---------- | -- | ---- |
| Decode, unknown keys to the hook | `decodeX(json)`, `decodeXFromJson(text)`, `tryDecodeX`, `tryDecodeXFromJson` | `json.Unmarshal(data, &x)`, `DecodeX(data)` for a tagged union | `X::from_json(text)` |
| Decode, returning the paths too | `reportX(json, path?)`, `reportXFromJson(text)` | `Report[X](data)`, `ReportX(data)` for a tagged union | `X::report_from_json(text)` |
| What it returns | `Reported<X>`: `{ value, unknown }` | `Reported[X]`: `Value`, `Unknown` | `Reported<X>`: `value`, `unknown` |
| The hook | `setUnknownKeyHook((paths) => ...)`, `undefined` removes it | `SetUnknownKeyHook(func(paths []string) {...})`, `nil` removes it | `set_unknown_key_hook(\|paths\| ...)`, `clear_unknown_key_hook()` |

The report functions call the hook too. Go's hook is safe to set while other goroutines decode, and Rust's takes a closure that is `Send + Sync`.

```ts
setUnknownKeyHook((paths) => metrics.count("order.unknown_keys", paths.length));
const { value, unknown } = reportOrderFromJson(body);
```

```go
types.SetUnknownKeyHook(func(paths []string) { log.Printf("unknown keys: %v", paths) })
r, err := types.Report[types.Order](body)
```

```rust
set_unknown_key_hook(|paths| eprintln!("unknown keys: {paths:?}"));
let Reported { value, unknown } = Order::report_from_json(body)?;
```

The names `Reported` (and in Go `Report` and `SetUnknownKeyHook`, in TypeScript `UnknownKeyHook`) are reserved type names in both modes, so switching a target's mode never makes a schema fail. TypeScript's report mode needs the decoders, so `"read": "report"` with `"decoders": false` is a config error.

[`examples/report`](../examples/report) generates every language in report mode. Its valid fixtures each have a `<case>.expect.json` like `{ "unknown": ["/source", "/lines/0/giftWrap"] }`, and the Rust, Go and TypeScript runs check that each decodes with exactly those paths, in that order, that the hook gets them once, and that the value encodes to the input without them.
