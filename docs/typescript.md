# TypeScript decoders

With `targets.typescript.decoders` on (the default), every generated type `X` gets six functions next to it, and the folder gets a `helpers.ts` that they share. There is no package to install.

```ts
decodeXFromJson(text: string): X                 // reads JSON text strictly, throws a DecodeError
tryDecodeXFromJson(text: string): DecodeResult<X>
decodeX(json: unknown, path?: string): X         // checks a value that is already parsed
tryDecodeX(json: unknown): DecodeResult<X>       // { ok: true, value } or { ok: false, error }
encodeX(value: X): unknown                       // a JSON value, ready for JSON.stringify
encodeXToJson(value: X): string                  // JSON text, keys in the order Rust and Go write
```

Use `decodeXFromJson` for input from outside. It accepts and rejects the same documents as the Rust and Go decoders. `decodeX` is for a value something else has parsed already, and can't see what `JSON.parse` has thrown away (see [Numbers](#numbers)).

Decoders read a value that is already parsed, like the result of `JSON.parse`, and check it the way the Rust and Go decoders do: unknown keys, missing required keys, `null` for an optional key and values of the wrong type fail. A `DecodeError` has the shared error shape of [error-codes.md](error-codes.md): the JSON Pointer of the first problem in `path`, a `code` from `ErrorCode`, and `expected` and `found` when the code has them. Its `message` is like `/items/2/price: wrong type, expected a number, found "5"`, and `compact()` gives `/items/2/price wrong_type, expected a number, found "5"`, the same text Go gives. Pass `path` to report errors under the place the value came from.

Keys like `__proto__` and `constructor` are read and written as data, never as object internals.

With `"read": "report"`, unknown keys are accepted instead and go to the hook set with `setUnknownKeyHook`, and `reportX(json, path?)` and `reportXFromJson(text)` return the value with their paths. [read-modes.md](read-modes.md) explains the mode.

## Reading JSON text

`decodeXFromJson` reads the text with a small strict JSON reader in `helpers.ts`, not `JSON.parse`, and then decodes the value. The reader follows the Rust and Go decoders:

- the strict JSON grammar: no trailing commas, comments, leading zeros, `NaN` or single quotes
- nothing but white space after the value
- no key given twice in one object, compared after unescaping
- no lone surrogate, in a `\u` escape or in the text itself
- finite numbers: `1e400` fails
- at most 127 nested arrays and objects: a value inside 128 or more fails, the limit of `serde_json` and of the Go decoders, so reading and decoding stay bounded however deep the input
- for an `integer`, an integer spelling: `12.0`, `1e2` and `-0` fail, as in Rust and Go. A `number` takes any spelling

A failure is a `DecodeError` with the code `invalid_json`, `duplicate_key` or `too_deep`, whose `path` is the JSON Pointer of the value being read and whose `found` ends with the offset in UTF-8 bytes, the same as Go:

```text
/items/0/sku: duplicate key, found "sku" at offset 31
```

The reader also keeps the order of each object's keys, which a JavaScript object doesn't for keys like `"1"`, so the first unknown key reported is the one Go reports. After `JSON.parse`, `decodeX` sees such keys first.

The text is a JavaScript string, so bytes are already decoded. Decode them with `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`, which fails on invalid UTF-8 and keeps a leading byte order mark, so the reader rejects it, as Rust and Go do. A non-fatal decoder turns it into U+FFFD, which can't be told apart afterwards.

## IDs

An ID type is a branded string, like `type UserId = string & { readonly __brand: "UserId" }`, so a `UserId` can't be passed where an `OrderId` is expected. `decodeUserId` makes one from input. `asUserId(text)` marks a string you already trust as one, without checking it.

## Numbers

JavaScript holds every JSON number as a 64-bit float, which keeps neither the number's spelling nor every integer. The TypeScript decoders fail rather than read a different number than was sent:

- An `integer` decodes only when it is a whole number within `Number.MAX_SAFE_INTEGER` (2^53 - 1), and not `-0`. A larger value fails with `out_of_range_integer`, since `JSON.parse` has already rounded it. Go and Rust take integers up to the 64-bit limit.
- A `number` decodes when it is finite. `JSON.parse` turns `1e400` into `Infinity`, which fails.

Where TypeScript differs from Rust and Go:

| Input | Rust and Go | `decodeXFromJson` | `decodeX` after `JSON.parse` |
| ----- | ----------- | ----------------- | ---------------------------- |
| `12.0` or `1e2` as an `integer` | rejected, not an integer spelling | rejected | decodes as `12` or `100` |
| `12.0` as a `number` | re-encodes as `12.0` | re-encodes as `12` | re-encodes as `12` |
| `-0` as a `number` | re-encodes as `-0` | re-encodes as `0` | re-encodes as `0` |
| An integer past 2^53 | decodes up to the 64-bit limit | rejected | rejected |
| A key given twice | rejected | rejected | the last one kept |

Only `decodeXFromJson` sees the text, so only it can reject an integer by its spelling or a key given twice.

## String families

A string whose `pattern` is a fixed prefix or suffix around a part that allows anything is typed as a template literal type:

| Pattern | TypeScript type |
| ------- | --------------- |
| `^order\..+$`, `^order\..*$` or `^order\.` | `` `order.${string}` `` |
| `\.json$` or `.+\.json$` | `` `${string}.json` `` |
| `^v.+-beta$` | `` `v${string}-beta` `` |

The prefix and suffix are literal characters or syntax characters escaped with a backslash, like `\.` or `\$`. Every other pattern, like `^[a-z]+$`, `^\d+$` or an alternation, types the string as `string`. The template literal type holds every string the pattern matches, so it never rejects a valid value at compile time, and is a little wider: `` `order.${string}` `` also holds `order.` itself, which `.+` does not match.

The decoders check that the value is a string. They don't check the pattern yet, in any language, so a decoded value can be outside its family until pattern validation lands.

## Unions

A tagged union (a `oneOf` whose branches share a required string `const`, like `"type": { "const": "card" }`) is a TypeScript union of its branch types. `decodeX` reads the tag first and decodes only the branch it names. Like Go, it fails at the tag's path with:

- `missing_key` when the tag is absent: `/type: missing key`
- `wrong_type` when it isn't a string: `/type: wrong type, expected a string, found 1`
- `bad_tag` when no branch has it, the tags in schema order: `/type: bad tag, expected one of "card", "wire", found "cash"`
- the branch's own error inside it, like `/root/installments: wrong type, expected an integer, found "2"`

A union that lists another tagged union is spread into one, so its branches decode as branches of the outer union, as in Rust and Go.

An untagged union tries its variants in a fixed order, the same as Rust and Go, and keeps the first that decodes: objects with required keys, then arrays, maps, enums, strings, integers, numbers, booleans, other unions, and any JSON value last. A value that matches two variants decodes as the earlier one in every language. When none matches, the error is `wrong_type` at the union's path, naming the union: `wrong type, expected Contact, found an object`, or `null_not_allowed` for `null`. An exactly-one `oneOf` of required keys beside properties, like an email or a phone, is a union of one object type per choice, with the other choices' keys typed `never`.

## Any JSON values

`{}` is `unknown` and decodes any JSON value, `null` included. A non-null value (`not: { const: null }`) is `NonNullable<unknown>` and decodes anything but `null` at the top. Both check that the whole value is JSON: `undefined`, `NaN`, class instances and values that hold themselves fail.

## Encoders

`encodeX` checks the value before writing it, and throws an `EncodeError`, with a JSON Pointer `path` and a `reason`, for a value the Rust and Go types could not hold or that would not decode again:

- a key the type doesn't name (in an object without a map of other keys), which would otherwise be dropped
- a missing required key, or a value of the wrong type
- an enum value or a const the type doesn't list, also as the key of an enum-keyed map
- `NaN` or `Infinity`, which `JSON.stringify` writes as `null`
- for an integer, a fraction, `-0`, which `JSON.stringify` writes as `0`, or a value past `Number.MAX_SAFE_INTEGER`
- a tagged union whose tag no branch has, and an untagged union value no variant takes

Named keys are written in schema order, then the other keys sorted by code point, the order Rust and Go write. `JSON.stringify` puts keys like `"1"` first whatever the order, so use `encodeXToJson` when the order of the text matters. A tagged union encodes with the branch its tag names, an untagged one with the first variant, in decode order, whose encoder takes the value. The named keys and the other keys share one TypeScript object, so no key can be written twice, which the Rust and Go encoders check for.
