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

Decoding stops at the first problem. Keys are checked in schema order, then unknown keys in input order, so every language reports the same first error. Constraints come after the structure of the whole value, in the order [below](#constraints).

## Constraints

The decoders check `minLength`, `maxLength`, `pattern`, `format`, `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`, `minProperties` and `maxProperties`, unless the config sets `"validation": false`. Every language checks them in one fixed order, so they report the same first error:

1. Structure first. A value whose structure doesn't fit its type, anywhere, fails with that error: a wrong type, a missing or unknown key, a bad tag, a value outside an enum. No constraint is checked then, even one that comes earlier in the value
2. Then one walk over the decoded value, which stops at the first constraint that fails:
   - a value's own constraints before the values inside it, so an array with too many items fails on its count before an item fails on its length
   - a struct's fields in schema order, then the keys of its map of other keys
   - an array's items by index
   - a map's keys in code point order (the byte order of their UTF-8, not the input order), each key's own constraints before its value's
   - a union's checks are those of the branch that decoded. Constraints never pick the branch: a value that fits a variant's structure is that variant, and breaking its constraints is an error, not a reason to try the next one
3. A value's own constraints in this order: `minLength`, `maxLength`, `pattern`, `format`; `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf`; `minItems`, `maxItems`, `uniqueItems`, all before any item is checked; `minProperties`, `maxProperties`

How each one compares:

- Lengths count Unicode code points, so `😀` and `é` are 1 and `e` followed by a combining accent is 2, in every language. TypeScript doesn't use `.length`, which counts UTF-16 units
- Integers compare exactly. Their bounds and `multipleOf` must be safe integers, from -9007199254740991 to 9007199254740991, which every language holds, or generation fails
- Numbers compare as the nearest 64-bit float to the number as spelled, for the value and for the bound, in every language: Go parses its `json.Number` with `strconv.ParseFloat`, Rust reads a number that isn't an integer with Rust's own parser into a `serde_json::Number` and compares its `as_f64()`, and TypeScript compares the `number` it read. So `1E3` and `1000` are the same number, and a value too close to a bound to tell apart as a float is equal to it
- `multipleOf` applies to integers only. On a number generation fails, since float division rounds differently from language to language
- `pattern` matches anywhere in the string, as JSON Schema says: `x` holds for `axb`. Anchor it with `^` and `$` to match the whole string. See [patterns](#patterns)
- `format` is checked by one hand-written grammar per format in every language, no regex or date library. See [formats](#formats)
- `uniqueItems` compares the decoded items by their [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON: object keys in any order, numbers as 64-bit floats (`1`, `1.0` and `1e0` are equal, and so are `0` and `-0`), strings by their characters (`"a"` and `"\u0061"` are equal). The error is at the later of the two items, with the index of the earlier in `found`. In report mode unknown keys are not part of the decoded value, so two items that differ only in unknown keys are equal

An error at a value shows, in `expected` and `found`:

| Code | `expected` | `found` |
| ---- | ---------- | ------- |
| `too_short` | `at least 2 characters`, `at least 1 item` or `at least 1 key` | the count, like `1 character`, `0 items` or `0 keys` |
| `too_long` | `at most 5 characters`, `at most 3 items` or `at most 2 keys` | the count, like `6 characters` |
| `too_small` | `>= 0.5` for `minimum`, `> 0` for `exclusiveMinimum` | the value |
| `too_large` | `<= 99` for `maximum`, `< 1000` for `exclusiveMaximum` | the value |
| `not_multiple_of` | `a multiple of 6` | the value |
| `pattern_mismatch` | `matching ` and the pattern as the schema writes it, like `matching ^[A-Z]{3}$` | the string |
| `bad_format` | `a date-time`, `a date` or `a UUID` | the string |
| `not_unique` | `unique items` | `a repeat of item 0`, the index of the earlier item |

A number in these errors is written the way JavaScript writes it, in every language: the shortest digits that read back as the same float, like `0.1`, `1000` for `1E3`, `1e-7` and `1e+21`, and `-0`. It is not the spelling in the input, which TypeScript doesn't keep.

```text
/note: too long, expected at most 5 characters, found 6 characters
/price: too large, expected < 1000, found 1000
/attributes/a: too short, expected at least 3 characters, found 1 character
/tracking: pattern mismatch, expected matching ^[A-Z]{2}\d{9}[A-Z]{2}$, found "AB12345678US"
/shippedAt: bad format, expected a date-time, found "2024-01-02 03:04:05Z"
/labels/2: not unique, expected unique items, found a repeat of item 0
```

A constraint that can't be checked the same way in every language fails generation rather than being ignored: `multipleOf` on a number (`unsupported-constraint`), a pattern outside the [portable subset](#patterns) (`unsupported-pattern`), a format other than `date-time`, `date` and `uuid` (`unsupported-format`), a `not` beside a string, like `{ "type": "string", "not": { "enum": ["admin"] } }` (`unsupported-not`), a constraint where it doesn't apply, like `maxLength` on an integer, beside `$ref` or `enum`, or `minProperties` on an object with named properties (`misplaced-keyword`), and a value out of range, like a negative `minLength` or a `uniqueItems` that isn't a boolean (`invalid-constraint`). With `"validation": false` the checks are left out, but such a constraint still fails generation.

### Patterns

A pattern is read as JSON Schema says, as an ECMAScript regular expression with the `u` flag, then rewritten into one portable form that Rust's [`regex`](https://docs.rs/regex) crate, Go's `regexp` (RE2) and ECMAScript read the same way. Each language compiles it once. The subset:

| Syntax | Meaning in every language |
| ------ | ------------------------- |
| Characters, and `\` before any of `^$\.*+?()[]{}\|/` | the character itself. Matching is case-sensitive, code point by code point, so `😀` is one character |
| `^`, `$` | the start and the end of the whole string. `$` does not match before a final line feed |
| `.` | any character but `\n`, `\r`, U+2028 and U+2029, as in ECMAScript. Go and Rust alone would match the last three |
| `\d`, `\D` | `[0-9]` and its complement, ASCII only. Rust alone would take any Unicode digit, like `٣` |
| `\w`, `\W` | `[0-9A-Za-z_]` and its complement, ASCII only |
| `\s`, `\S` | ECMAScript's white space and line terminators: tab to carriage return, space, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF, and the complement. Go alone would take ASCII white space without `\v`, Rust U+0085 too |
| `[...]`, `[^...]` | a class of characters and ranges, with the escapes above, `\-` and `\b` (backspace) inside |
| `\t`, `\n`, `\v`, `\f`, `\r`, `\0`, `\cX`, `\xHH`, `\uHHHH`, `\u{H...}` | the character they name; a surrogate pair of `\u` escapes is one character |
| `(...)`, `(?:...)`, `\|` | groups and alternatives |
| `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`, and their lazy forms | repeats, counts up to 1000, also when nested repeats multiply. A lazy repeat matches the same strings as a greedy one |

Generation fails, with the reason and the character it is at, on everything else: lookaheads and lookbehinds and backreferences (Rust's `regex` and RE2 have neither), named groups, word boundaries `\b` and `\B` (Unicode in Rust, ASCII elsewhere), Unicode property escapes like `\p{L}` (the engines know different properties), inline flags, repeat counts above 1000, a class that matches nothing, a pattern too large for an engine (below), and anything that isn't valid ECMAScript with the `u` flag.

Every accepted pattern compiles in all three languages, because two limits keep it well inside what each engine takes:

- Size: at most 100,000 steps once every repeat is written out. A character counts its UTF-8 bytes, a class the byte ranges it becomes in UTF-8 (`[a-z]` is 1, `.` is 41, `\S` is 75), and a repeat its body once per count plus one, and one more for each optional copy (`{2,5}` counts 2 copies and 3 optional ones). So `^.{1000}.{1000}$` is 84,002 steps and fits, and three `.{1000}` in a row don't. Rust's `regex` refuses a pattern that compiles to more than 10 MiB and uses about 40 bytes a step at most, so the largest accepted pattern compiles to about 4 MiB. The generated Rust sets the 10 MiB limit itself, so a later `regex` release can't lower it. Go's RE2 takes patterns many times larger
- Parts: at most 2000 characters, classes, anchors, groups, repeats and alternatives as written, a repeat counted once. V8 compiles a pattern by recursion, and with a small stack fails on a few thousand parts in a row

The error gives the size, like `unsupported-pattern: a pattern of 126002 steps once its repeats are written out, above the 100000 that Rust's regex compiles safely`.

Rust checks patterns with the `regex` crate, which the generated code uses only when a schema has a `pattern`. Add it to your crate then, next to `serde` and `serde_json`:

```toml
[dependencies]
regex = "1.10"
```

ECMAScript matches by backtracking, so in TypeScript a pattern with nested repeats, like `^(a+)+$`, can take a long time on a long input that almost matches. Rust and Go match in linear time. Prefer patterns without nested repeats, or limit the length with `maxLength`, which is checked first.

### Formats

| Format | Grammar |
| ------ | ------- |
| `date` | [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339#section-5.6) `full-date`: `YYYY-MM-DD`, ASCII digits, a month from 01 to 12 and a day the month has, with Gregorian leap years (2000-02-29 holds, 1900-02-29 does not). The year runs from 0000 to 9999 |
| `date-time` | RFC 3339 `date-time`: a `date`, `T`, then `HH:MM:SS` with an hour from 00 to 23, a minute from 00 to 59 and a second from 00 to 60, then an optional fraction of a dot and one digit or more, then `Z` or an offset `+HH:MM` or `-HH:MM` (hours 00 to 23, minutes 00 to 59, `-00:00` included). `T` and `Z` may be lower case, as RFC 3339 allows. A second of 60, a leap second, holds only when the time is 23:59 in UTC once the offset is taken off, like `1998-12-31T23:59:60Z` or `1998-12-31T15:59:60-08:00`. No space for `T`, no offset without a colon, nothing before or after |
| `uuid` | [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562#section-4) text form: 32 hex digits in groups of 8, 4, 4, 4 and 12, joined by `-`. Upper and lower case digits both hold, as RFC 9562 says input is case-insensitive, and the version and variant are not checked, so the nil and max UUIDs hold. No braces and no `urn:uuid:` prefix |

The string is kept as it is, so it encodes back byte for byte.

Every entry point checks: in Rust, `T::from_json` and `T::report_from_json`, through the `Decode` trait's `check` method; in Go, `json.Unmarshal` (through `UnmarshalJSON`), `Report[T]` and the `DecodeX` and `ReportX` functions of tagged unions; in TypeScript, `decodeX`, `decodeXFromJson`, `reportX`, `reportXFromJson` and their `tryDecode` forms. A def with constraints that stands for a type that can't carry them, like `codes` for a list of at most two codes or `code` for a string of 3 characters, is generated as a type of its own in Rust so that it can: a newtype (`pub struct Codes(pub Vec<Code>)`, which serializes as the list). In Go every def that isn't a `$ref` to another def is a defined type, like `type Codes []Code` or `type Name string`, with an `UnmarshalJSON` that reads with the strict parser, so `json.Unmarshal` into it rejects what Rust and TypeScript reject, like `1e400` for a number or a key given twice, whether or not it has constraints. TypeScript keeps a type alias, since its decoders check either way. A def that only refers to another def stays an alias in every language, and in Rust so does one without constraints.

`json.Unmarshal` checks that its input is JSON before any `UnmarshalJSON` runs, so for text that isn't JSON it returns its own `*json.SyntaxError` rather than an `invalid_json` `DecodeError`. `Report[T]` and the `DecodeX` functions always return the `DecodeError`.

In report mode the same constraints are checked in the same order. Unknown keys are not structure errors there, so a value with unknown keys and a broken constraint fails with the constraint error, and the unknown key hook isn't called for a decode that fails.

## Read modes

Every target reads in `strict` mode unless its config sets `"read": "report"`. The codes above are the same in both modes, with one exception: in `report` mode an unknown key is not an error. The decode succeeds, and the key's path goes to the unknown key hook and the report functions instead. [read-modes.md](read-modes.md) explains both modes, and the LLM decoders, which are always strict.

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
| `unknown_key` | unknown key | a key the type doesn't name; `path` is the key's own pointer, like `/user/nickname`. In report mode such a key is reported instead, see [read-modes.md](read-modes.md) | | |
| `missing_key` | missing key | a required key that is absent, at the key's pointer | | |
| `null_not_allowed` | null not allowed | `null` where the type doesn't take it, like for an optional key | the type | |
| `wrong_type` | wrong type | a value of another JSON type, also for a const or an enum, like a string for an integer const; for an integer also a fraction, an exponent spelling like `1e2` or `12.0`, and `-0` | the type | the value |
| `bad_tag` | bad tag | a tag no branch of a tagged union has, at the tag's pointer | the tags | the tag |
| `not_in_enum` | not in enum | a string the enum doesn't list | the values | the value |
| `not_const` | not const | a value of the const's JSON type other than the const | the const | the value |
| `too_short` | too short | a string, array or map with fewer code points, items or keys than `minLength`, `minItems` or `minProperties` | the minimum | the count |
| `too_long` | too long | a string, array or map with more code points, items or keys than `maxLength`, `maxItems` or `maxProperties` | the maximum | the count |
| `too_small` | too small | a number below its `minimum`, or not above its `exclusiveMinimum` | the bound | the value |
| `too_large` | too large | a number above its `maximum`, or not below its `exclusiveMaximum` | the bound | the value |
| `not_multiple_of` | not a multiple | an integer that isn't a multiple of its `multipleOf` | the multiple | the value |
| `pattern_mismatch` | pattern mismatch | a string that doesn't match its pattern | `matching` and the pattern | the string |
| `bad_format` | bad format | a string that isn't in its format, like date-time | the format, like `a date-time` | the string |
| `not_unique` | not unique | an array whose items must be unique, with a repeat; `path` is the later item's pointer | `unique items` | `a repeat of item` and the earlier index |
| `out_of_range_integer` | out of range integer | an integer the language can't hold exactly | the range | the value |
| `invalid_json` | invalid JSON | text that isn't JSON: a syntax error, invalid UTF-8, a lone surrogate, data after the value, a number out of range | | what was found and the byte offset |
| `duplicate_key` | duplicate key | an object that gives the same key twice, at the key's pointer, or a map an LLM gave as entries with a key twice, at the later entry's key ([llm.md](llm.md#decoders)) | | the key and the byte offset, or for entries the key alone |
| `too_deep` | too deep | a value inside more than 127 nested arrays and objects | `at most 127 nested arrays and objects` | the byte offset |

Some cases worth knowing:

- A tagged union: a missing tag is `missing_key` and a tag that isn't a string is `wrong_type`, both at the tag's pointer. An error inside the branch is the branch's own
- An untagged union no variant takes is `wrong_type`, or `null_not_allowed` for `null`, with the union's name in `expected`, like `expected Contact`
- An enum of one value, like a string `const`, reports `not_const`
- A map key that fails, like one an enum-keyed map doesn't list, is reported at the key's pointer, like `/quota/guest`
- `out_of_range_integer` names the range the language holds: Go and Rust take 64-bit integers, TypeScript integers within `Number.MAX_SAFE_INTEGER`. This is the one place the languages accept different input

## Every code

Each code below has a case of the [conformance suite](../conformance) that fails with it, and the message the Rust, Go and TypeScript decoders give for it, then its compact form. `pnpm docs` decodes each case in all three languages, so these lines are real output.

### `unknown_key`

Reported for a key the type doesn't name; `path` is the key's own pointer, like `/user/nickname`. In report mode such a key is reported instead, see [read-modes.md](read-modes.md). Its message says `unknown key`.

<!-- snippet: error-code unknown_key -->
The case [`Item/invalid/unknown-key.json`](../conformance/cases/Item/invalid/unknown-key.json), decoded as `Item` (`shop-order.json#/$defs/item` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "sku": "A-1",
  "quantity": 2,
  "discount": "10%"
}
```

```text
Rust        /discount: unknown key
Go          /discount: unknown key
TypeScript  /discount: unknown key
compact     /discount unknown_key
```
<!-- /snippet -->

### `missing_key`

Reported for a required key that is absent, at the key's pointer. Its message says `missing key`.

<!-- snippet: error-code missing_key -->
The case [`Note/invalid/missing-text.json`](../conformance/cases/Note/invalid/missing-text.json), decoded as `Note` (`shop-order.json#/$defs/note` in [`conformance/schemas`](../conformance/schemas)):

```json
{}
```

```text
Rust        /text: missing key
Go          /text: missing key
TypeScript  /text: missing key
compact     /text missing_key
```
<!-- /snippet -->

### `null_not_allowed`

Reported for `null` where the type doesn't take it, like for an optional key. Its message says `null not allowed`.

<!-- snippet: error-code null_not_allowed -->
The case [`Bundle/invalid/label-null.json`](../conformance/cases/Bundle/invalid/label-null.json), decoded as `Bundle` (`bundle.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "sku": "B-1",
  "version": 2,
  "label": null
}
```

```text
Rust        /label: null not allowed, expected a JSON value other than null
Go          /label: null not allowed, expected a JSON value other than null
TypeScript  /label: null not allowed, expected a JSON value other than null
compact     /label null_not_allowed, expected a JSON value other than null
```
<!-- /snippet -->

### `wrong_type`

Reported for a value of another JSON type, also for a const or an enum, like a string for an integer const; for an integer also a fraction, an exponent spelling like `1e2` or `12.0`, and `-0`. Its message says `wrong type`.

<!-- snippet: error-code wrong_type -->
The case [`Code/invalid/number.json`](../conformance/cases/Code/invalid/number.json), decoded as `Code` (`order.json#/$defs/code` in [`conformance/schemas`](../conformance/schemas)):

```json
123
```

```text
Rust        wrong type, expected a string, found 123
Go          wrong type, expected a string, found 123
TypeScript  wrong type, expected a string, found 123
compact     wrong_type, expected a string, found 123
```
<!-- /snippet -->

### `bad_tag`

Reported for a tag no branch of a tagged union has, at the tag's pointer. Its message says `bad tag`.

<!-- snippet: error-code bad_tag -->
The case [`Payment/invalid/unknown-tag.json`](../conformance/cases/Payment/invalid/unknown-tag.json), decoded as `Payment` (`shop-order.json#/$defs/payment` in [`conformance/schemas`](../conformance/schemas)):

```json
{"type": "cash"}
```

```text
Rust        /type: bad tag, expected one of "card", "invoice", found "cash"
Go          /type: bad tag, expected one of "card", "invoice", found "cash"
TypeScript  /type: bad tag, expected one of "card", "invoice", found "cash"
compact     /type bad_tag, expected one of "card", "invoice", found "cash"
```
<!-- /snippet -->

### `not_in_enum`

Reported for a string the enum doesn't list. Its message says `not in enum`.

<!-- snippet: error-code not_in_enum -->
The case [`Role/invalid/not-in-enum.json`](../conformance/cases/Role/invalid/not-in-enum.json), decoded as `Role` (`user.json#/$defs/role` in [`conformance/schemas`](../conformance/schemas)):

```json
"guest"
```

```text
Rust        not in enum, expected one of "owner", "admin", "member", found "guest"
Go          not in enum, expected one of "owner", "admin", "member", found "guest"
TypeScript  not in enum, expected one of "owner", "admin", "member", found "guest"
compact     not_in_enum, expected one of "owner", "admin", "member", found "guest"
```
<!-- /snippet -->

### `not_const`

Reported for a value of the const's JSON type other than the const. Its message says `not const`.

<!-- snippet: error-code not_const -->
The case [`Bundle/invalid/version-other.json`](../conformance/cases/Bundle/invalid/version-other.json), decoded as `Bundle` (`bundle.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "sku": "B-1",
  "version": 3
}
```

```text
Rust        /version: not const, expected 2, found 3
Go          /version: not const, expected 2, found 3
TypeScript  /version: not const, expected 2, found 3
compact     /version not_const, expected 2, found 3
```
<!-- /snippet -->

### `too_short`

Reported for a string, array or map with fewer code points, items or keys than `minLength`, `minItems` or `minProperties`. Its message says `too short`.

<!-- snippet: error-code too_short -->
The case [`Line/invalid/sku-below-minimum.json`](../conformance/cases/Line/invalid/sku-below-minimum.json), decoded as `Line` (`order.json#/$defs/line` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "sku": "ab",
  "count": 0
}
```

```text
Rust        /sku: too short, expected at least 3 characters, found 2 characters
Go          /sku: too short, expected at least 3 characters, found 2 characters
TypeScript  /sku: too short, expected at least 3 characters, found 2 characters
compact     /sku too_short, expected at least 3 characters, found 2 characters
```
<!-- /snippet -->

### `too_long`

Reported for a string, array or map with more code points, items or keys than `maxLength`, `maxItems` or `maxProperties`. Its message says `too long`.

<!-- snippet: error-code too_long -->
The case [`Code/invalid/four.json`](../conformance/cases/Code/invalid/four.json), decoded as `Code` (`order.json#/$defs/code` in [`conformance/schemas`](../conformance/schemas)):

```json
"abcd"
```

```text
Rust        too long, expected at most 3 characters, found 4 characters
Go          too long, expected at most 3 characters, found 4 characters
TypeScript  too long, expected at most 3 characters, found 4 characters
compact     too_long, expected at most 3 characters, found 4 characters
```
<!-- /snippet -->

### `too_small`

Reported for a number below its `minimum`, or not above its `exclusiveMinimum`. Its message says `too small`.

<!-- snippet: error-code too_small -->
The case [`Line/invalid/count-below-minimum.json`](../conformance/cases/Line/invalid/count-below-minimum.json), decoded as `Line` (`order.json#/$defs/line` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "sku": "abc",
  "count": 0
}
```

```text
Rust        /count: too small, expected >= 1, found 0
Go          /count: too small, expected >= 1, found 0
TypeScript  /count: too small, expected >= 1, found 0
compact     /count too_small, expected >= 1, found 0
```
<!-- /snippet -->

### `too_large`

Reported for a number above its `maximum`, or not below its `exclusiveMaximum`. Its message says `too large`.

<!-- snippet: error-code too_large -->
The case [`PercentOff/invalid/over-100.json`](../conformance/cases/PercentOff/invalid/over-100.json), decoded as `PercentOff` (`promotion.json#/$defs/percentOff` in [`conformance/schemas`](../conformance/schemas)):

```json
{"kind": "percent", "percent": 101}
```

```text
Rust        /percent: too large, expected <= 100, found 101
Go          /percent: too large, expected <= 100, found 101
TypeScript  /percent: too large, expected <= 100, found 101
compact     /percent too_large, expected <= 100, found 101
```
<!-- /snippet -->

### `not_multiple_of`

Reported for an integer that isn't a multiple of its `multipleOf`. Its message says `not a multiple`.

<!-- snippet: error-code not_multiple_of -->
The case [`Order/invalid/pack-size-not-a-multiple.json`](../conformance/cases/Order/invalid/pack-size-not-a-multiple.json), decoded as `Order` (`order.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "id": "ord_5h1c",
  "note": "ab",
  "quantity": 1,
  "price": 0.5,
  "tags": [
    "a"
  ],
  "packSize": 7
}
```

```text
Rust        /packSize: not a multiple, expected a multiple of 6, found 7
Go          /packSize: not a multiple, expected a multiple of 6, found 7
TypeScript  /packSize: not a multiple, expected a multiple of 6, found 7
compact     /packSize not_multiple_of, expected a multiple of 6, found 7
```
<!-- /snippet -->

### `pattern_mismatch`

Reported for a string that doesn't match its pattern. Its message says `pattern mismatch`.

<!-- snippet: error-code pattern_mismatch -->
The case [`TrackingNumber/invalid/lower-case.json`](../conformance/cases/TrackingNumber/invalid/lower-case.json), decoded as `TrackingNumber` (`shipment.json#/$defs/trackingNumber` in [`conformance/schemas`](../conformance/schemas)):

```json
"ab123456789us"
```

```text
Rust        pattern mismatch, expected matching ^[A-Z]{2}\d{9}[A-Z]{2}$, found "ab123456789us"
Go          pattern mismatch, expected matching ^[A-Z]{2}\d{9}[A-Z]{2}$, found "ab123456789us"
TypeScript  pattern mismatch, expected matching ^[A-Z]{2}\d{9}[A-Z]{2}$, found "ab123456789us"
compact     pattern_mismatch, expected matching ^[A-Z]{2}\d{9}[A-Z]{2}$, found "ab123456789us"
```
<!-- /snippet -->

### `bad_format`

Reported for a string that isn't in its format, like date-time. Its message says `bad format`.

<!-- snippet: error-code bad_format -->
The case [`Day/invalid/leap-day-in-2100.json`](../conformance/cases/Day/invalid/leap-day-in-2100.json), decoded as `Day` (`shipment.json#/$defs/day` in [`conformance/schemas`](../conformance/schemas)):

```json
"2100-02-29"
```

```text
Rust        bad format, expected a date, found "2100-02-29"
Go          bad format, expected a date, found "2100-02-29"
TypeScript  bad format, expected a date, found "2100-02-29"
compact     bad_format, expected a date, found "2100-02-29"
```
<!-- /snippet -->

### `not_unique`

Reported for an array whose items must be unique, with a repeat; `path` is the later item's pointer. Its message says `not unique`.

<!-- snippet: error-code not_unique -->
The case [`LabelCodes/invalid/repeat.json`](../conformance/cases/LabelCodes/invalid/repeat.json), decoded as `LabelCodes` (`shipment.json#/$defs/labelCodes` in [`conformance/schemas`](../conformance/schemas)):

```json
["ABC", "DEF", "ABC"]
```

```text
Rust        /2: not unique, expected unique items, found a repeat of item 0
Go          /2: not unique, expected unique items, found a repeat of item 0
TypeScript  /2: not unique, expected unique items, found a repeat of item 0
compact     /2 not_unique, expected unique items, found a repeat of item 0
```
<!-- /snippet -->

### `out_of_range_integer`

Reported for an integer the language can't hold exactly. Its message says `out of range integer`.

<!-- snippet: error-code out_of_range_integer -->
The case [`Event/invalid/attempt-above-int64-maximum.json`](../conformance/cases/Event/invalid/attempt-above-int64-maximum.json), decoded as `Event` (`event.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "id": "evt_31xq",
  "type": "user.created",
  "occurredAt": "2026-01-15T09:30:01Z",
  "attempt": 9223372036854775808,
  "user": {
    "id": "usr_8f2k",
    "email": "ada@example.com",
    "displayName": "Ada",
    "role": "admin",
    "labels": {
      "team": "billing",
      "region": "eu"
    },
    "createdAt": "2026-01-15T09:30:00Z"
  }
}
```

```text
Rust                /attempt: out of range integer, expected an integer from -9223372036854775808 to 9223372036854775807, found 9223372036854775808
Go                  /attempt: out of range integer, expected an integer from -9223372036854775808 to 9223372036854775807, found 9223372036854775808
TypeScript          /attempt: out of range integer, expected an integer from -9007199254740991 to 9007199254740991, found 9223372036854775808
Rust compact        /attempt out_of_range_integer, expected an integer from -9223372036854775808 to 9223372036854775807, found 9223372036854775808
Go compact          /attempt out_of_range_integer, expected an integer from -9223372036854775808 to 9223372036854775807, found 9223372036854775808
TypeScript compact  /attempt out_of_range_integer, expected an integer from -9007199254740991 to 9007199254740991, found 9223372036854775808
```
<!-- /snippet -->

### `invalid_json`

Reported for text that isn't JSON: a syntax error, invalid UTF-8, a lone surrogate, data after the value, a number out of range. Its message says `invalid JSON`.

<!-- snippet: error-code invalid_json -->
The case [`ShopOrder/invalid/invalid-json-in-unknown-value.json`](../conformance/cases/ShopOrder/invalid/invalid-json-in-unknown-value.json), decoded as `ShopOrder` (`shop-order.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{
  "id": "ord_7d2k",
  "extra": [1, ],
  "customer": { "name": "Ada", "email": "ada@example.com" },
  "lines": [],
  "payment": { "type": "card", "last4": "4242" }
}
```

```text
Rust        /extra/1: invalid JSON, found an invalid value at offset 37
Go          /extra/1: invalid JSON, found an invalid value at offset 37
TypeScript  /extra/1: invalid JSON, found an invalid value at offset 37
compact     /extra/1 invalid_json, found an invalid value at offset 37
```
<!-- /snippet -->

### `duplicate_key`

Reported for an object that gives the same key twice, at the key's pointer, or a map an LLM gave as entries with a key twice, at the later entry's key ([llm.md](llm.md#decoders)). Its message says `duplicate key`.

<!-- snippet: error-code duplicate_key -->
The case [`Bundle/invalid/meta-key-twice.json`](../conformance/cases/Bundle/invalid/meta-key-twice.json), decoded as `Bundle` (`bundle.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{"sku":"B-1","version":2,"meta":{"a":1,"a":2}}
```

```text
Rust        /meta/a: duplicate key, found "a" at offset 39
Go          /meta/a: duplicate key, found "a" at offset 39
TypeScript  /meta/a: duplicate key, found "a" at offset 39
compact     /meta/a duplicate_key, found "a" at offset 39
```
<!-- /snippet -->

### `too_deep`

Reported for a value inside more than 127 nested arrays and objects. Its message says `too deep`.

<!-- snippet: error-code too_deep -->
The case [`Bundle/invalid/meta-empty-array-past-depth-limit.json`](../conformance/cases/Bundle/invalid/meta-empty-array-past-depth-limit.json), decoded as `Bundle` (`bundle.json#` in [`conformance/schemas`](../conformance/schemas)):

```json
{"sku":"B-1","version":2,"meta":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]}
```

```text
Rust        /meta/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0: too deep, expected at most 127 nested arrays and objects, found more at offset 158
Go          /meta/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0: too deep, expected at most 127 nested arrays and objects, found more at offset 158
TypeScript  /meta/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0: too deep, expected at most 127 nested arrays and objects, found more at offset 158
compact     /meta/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0/0 too_deep, expected at most 127 nested arrays and objects, found more at offset 158
```
<!-- /snippet -->

## JSON syntax errors

Text that doesn't parse fails with `invalid_json`, `duplicate_key` or `too_deep`. `path` is the pointer of the value being read when it failed, and `found` ends with the offset in UTF-8 bytes:

```text
/items/1: invalid JSON, found a missing comma or closing brace at offset 41
/user/id: duplicate key, found "id" at offset 57
```

What `invalid_json` finds: `an unexpected end of input`, `trailing characters`, `an invalid literal`, `a missing key`, `a missing colon`, `a missing comma or closing brace`, `a missing comma or closing bracket`, `a leading zero`, `an invalid value`, `an invalid number`, `a number out of range`, `an unterminated string`, `a control character in a string`, `an invalid escape`, `a lone surrogate`, `invalid UTF-8`.

## How `found` shows values

- `null`, `true` and `false` as they are
- a number as spelled in the input, like `12.0` or `1E2`. TypeScript decoding a value that `JSON.parse` already parsed shows it as JavaScript writes it, like `12`. A constraint error shows the number as JavaScript writes it in every language, as [above](#constraints)
- `an array` and `an object`
- a string in double quotes, with `"` and `\` escaped by a backslash, and control characters (U+0000 to U+001F, U+007F to U+009F), U+2028, U+2029 and lone surrogates as `\u` and four lowercase hex digits. Every other character is kept as it is. A string of more than 64 code points shows its first 64, then `...` after the closing quote

TypeScript also checks values that didn't come from JSON, like `undefined` or a class instance, and shows them as `a value that is not JSON`, `a number that is not finite`, `an object that is not plain JSON`, `a value that holds itself` or `a value that throws when read`.

## Fixtures

Each invalid example fixture has a `<case>.expect.json` next to it with the `path` and `code` it must fail with, like `{"path": "/user/nickname", "code": "unknown_key"}`. The Rust, Go and TypeScript fixture runs check it, and fail on an invalid case without one or an expectation without a case.
