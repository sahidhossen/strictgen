# Decode errors

Every language reports a failed decode the same way: the same JSON Pointer, the same code and the same message, so a log line or a retry prompt doesn't depend on which service read the payload.

## Shape

```json
{ "path": "/items/2/price", "code": "wrong_type", "expected": "a number", "found": "\"5\"" }
```

| Field | Meaning |
| ----- | ------- |
| `path` | JSON Pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)) to the value that failed, `""` for the whole input. `~` is written `~0` and `/` is written `~1` |
| `code` | What failed, one of the codes below |
| `expected` | What the type takes there, when the code has one, like `a string` or `one of "open", "closed"` |
| `found` | What the input has there, when the code has one, like `12.5` or `"gone"` |

In TypeScript it is `DecodeError` with `path`, `code`, `expected` and `found` (`undefined` when absent), `message` and `compact()`. In Go it is `*DecodeError` with `Path`, `Code`, `Expected` and `Found` (empty when absent), `Error()` and `Compact()`. In Rust it is `DecodeError` with `path`, `code`, `expected` and `found` (`None` when absent), `Display` for the message and `compact()`, returned by `T::from_json(text)` from the `Decode` trait every generated type implements. The codes are constants: `ErrorCode.UnknownKey` in TypeScript, `CodeUnknownKey` in Go, `DecodeError::UNKNOWN_KEY` in Rust.

Decoding stops at the first problem. Keys are checked in schema order, then unknown keys in input order, so every language reports the same first error.

## Messages

The message is built from the fields, the same in every language:

```text
<path>: <title>, expected <expected>, found <found>
```

The path and its colon are left out for the whole input, and each of `expected` and `found` when absent. The compact form, made for logs and for asking an LLM to retry, has the code instead of the title and a space after the path:

```text
/items/2/price: wrong type, expected a number, found "5"
/items/2/price wrong_type, expected a number, found "5"
```

## Codes

Codes are public API: changing one is a major version.

| Code | Title | When | `expected` | `found` |
| ---- | ----- | ---- | ---------- | ------- |
| `unknown_key` | unknown key | a key the type doesn't name; `path` is the key's own pointer, like `/user/nickname` | | |
| `missing_key` | missing key | a required key that is absent, at the key's pointer | | |
| `null_not_allowed` | null not allowed | `null` where the type doesn't take it, like for an optional key | the type | |
| `wrong_type` | wrong type | a value of another JSON type; for an integer also a fraction, an exponent spelling like `1e2` or `12.0`, and `-0` | the type | the value |
| `bad_tag` | bad tag | a tag no branch of a tagged union has, at the tag's pointer | the tags | the tag |
| `not_in_enum` | not in enum | a string the enum doesn't list | the values | the value |
| `not_const` | not const | a value other than the const | the const | the value |
| `too_short` | too short | a string or array shorter than its minimum | | |
| `too_long` | too long | a string or array longer than its maximum | | |
| `too_small` | too small | a number below its minimum | | |
| `too_large` | too large | a number above its maximum | | |
| `pattern_mismatch` | pattern mismatch | a string that doesn't match its pattern | | |
| `bad_format` | bad format | a string that isn't in its format | | |
| `not_unique` | not unique | an array whose items must be unique, with a repeat | | |
| `out_of_range_integer` | out of range integer | an integer the language can't hold exactly | the range | the value |
| `invalid_json` | invalid JSON | text that isn't JSON: a syntax error, invalid UTF-8, a lone surrogate, data after the value, a number out of range | | what was found and the byte offset |
| `duplicate_key` | duplicate key | an object that gives the same key twice, at the key's pointer | | the key and the byte offset |
| `too_deep` | too deep | a value inside 128 or more arrays and objects | `at most 127 nested arrays and objects` | the byte offset |

The constraint codes (`too_short` to `not_unique`) are reserved for validation and not reported yet.

Some cases worth knowing:

- A tagged union: a missing tag is `missing_key` and a tag that isn't a string is `wrong_type`, both at the tag's pointer. An error inside the branch is the branch's own
- An untagged union no variant takes is `wrong_type`, or `null_not_allowed` for `null`, with the union's name in `expected`, like `expected Contact`
- An enum of one value, like a string `const`, reports `not_const`
- A map key that fails, like one an enum-keyed map doesn't list, is reported at the key's pointer, like `/quota/guest`
- `out_of_range_integer` names the range the language holds: Go and Rust take 64-bit integers, TypeScript integers within `Number.MAX_SAFE_INTEGER`. This is the one place the languages accept different input

## JSON syntax errors

Text that doesn't parse fails with `invalid_json`, `duplicate_key` or `too_deep`. `path` is the pointer of the value being read when it failed, and `found` ends with the offset in UTF-8 bytes:

```text
/items/1: invalid JSON, found a missing comma or closing brace at offset 41
/user/id: duplicate key, found "id" at offset 57
```

What `invalid_json` finds: `an unexpected end of input`, `trailing characters`, `an invalid literal`, `a missing key`, `a missing colon`, `a missing comma or closing brace`, `a missing comma or closing bracket`, `a leading zero`, `an invalid value`, `an invalid number`, `a number out of range`, `an unterminated string`, `a control character in a string`, `an invalid escape`, `a lone surrogate`, `invalid UTF-8`.

## How `found` shows values

- `null`, `true` and `false` as they are
- a number as spelled in the input, like `12.0` or `1E2`. TypeScript decoding a value that `JSON.parse` already parsed shows it as JavaScript writes it, like `12`
- `an array` and `an object`
- a string in double quotes, with `"` and `\` escaped by a backslash, and control characters (U+0000 to U+001F, U+007F to U+009F), U+2028, U+2029 and lone surrogates as `\u` and four lowercase hex digits. Every other character is kept as it is. A string of more than 64 code points shows its first 64, then `...` after the closing quote

TypeScript also checks values that didn't come from JSON, like `undefined` or a class instance, and shows them as `a value that is not JSON`, `a number that is not finite`, `an object that is not plain JSON`, `a value that holds itself` or `a value that throws when read`.

## Fixtures

Each invalid example fixture has a `<case>.expect.json` next to it with the `path` and `code` it must fail with, like `{"path": "/user/nickname", "code": "unknown_key"}`. The Rust, Go and TypeScript fixture runs check it, and fail on an invalid case without one or an expectation without a case.
