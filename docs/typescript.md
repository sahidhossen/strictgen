# TypeScript decoders

With `targets.typescript.decoders` on (the default), every generated type `X` gets three functions next to it, and the folder gets a `helpers.ts` that they share. There is no package to install.

```ts
decodeX(json: unknown, path?: string): X        // throws a DecodeError
tryDecodeX(json: unknown): DecodeResult<X>      // { ok: true, value } or { ok: false, error }
encodeX(value: X): unknown                      // a JSON value, ready for JSON.stringify
```

Decoders read a value that is already parsed, like the result of `JSON.parse`, and check it the way the Rust and Go decoders do: unknown keys, missing required keys, `null` for an optional key and values of the wrong type fail. A `DecodeError` has the JSON Pointer of the first problem in `path` and the reason in `reason`, like `/items/2/price: expected a number, found a string`. Pass `path` to report errors under the place the value came from.

Keys like `__proto__` and `constructor` are read and written as data, never as object internals.

## IDs

An ID type is a branded string, like `type UserId = string & { readonly __brand: "UserId" }`, so a `UserId` can't be passed where an `OrderId` is expected. `decodeUserId` makes one from input. `asUserId(text)` marks a string you already trust as one, without checking it.

## Numbers

JavaScript parses every JSON number into a 64-bit float, which keeps neither the number's spelling nor every integer. The TypeScript decoders fail rather than read a different number than was sent:

- An `integer` decodes only when it is a whole number within `Number.MAX_SAFE_INTEGER` (2^53 - 1), and not `-0`. A larger value fails, since `JSON.parse` has already rounded it.
- A `number` decodes when it is finite. `JSON.parse` turns `1e400` into `Infinity`, which fails.

What can't be checked after `JSON.parse` has run:

| Input | Rust and Go | TypeScript |
| ----- | ----------- | ---------- |
| `12.0` or `1e2` as an `integer` | rejected, not an integer spelling | decodes as `12` or `100` |
| `12.0` as a `number` | re-encodes as `12.0` | re-encodes as `12` |
| `-0` as a `number` | re-encodes as `-0` | re-encodes as `0` |
| An integer past 2^53 | decodes up to the 64-bit limit | rejected |

Duplicate keys can't be checked either: `JSON.parse` keeps the last of two equal keys, where Rust and Go reject the document.

## Unions

A tagged union (a `oneOf` whose branches share a required string `const`, like `"type": { "const": "card" }`) is a TypeScript union of its branch types. `decodeX` reads the tag first and decodes only the branch it names. Like Go, it fails with:

- `missing key "type"` when the tag is absent
- `"type" must be a string, found a number` when it isn't a string
- `unknown type "cash", expected one of card, wire` when no branch has it, the tags sorted
- the branch's own error, prefixed with the branch, like `/root/installments: type "card": expected a number, found a string`

A union that lists another tagged union is spread into one, so its branches decode as branches of the outer union, as in Rust and Go.

An untagged union tries its variants in a fixed order, the same as Rust and Go, and keeps the first that decodes: objects with required keys, then arrays, maps, enums, strings, integers, numbers, booleans, other unions, and any JSON value last. A value that matches two variants decodes as the earlier one in every language. When none matches, the error is `data did not match any variant of X`, at the union's path. An exactly-one `oneOf` of required keys beside properties, like an email or a phone, is a union of one object type per choice, with the other choices' keys typed `never`.

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

Named keys are written in schema order, then the other keys sorted by code point, the order Rust and Go write. A tagged union encodes with the branch its tag names, an untagged one with the first variant, in decode order, whose encoder takes the value. The named keys and the other keys share one TypeScript object, so no key can be written twice, which the Rust and Go encoders check for.
