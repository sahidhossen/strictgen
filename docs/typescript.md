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

## Not decoded yet

Tagged and untagged unions, `{}` (any JSON value) and non-null JSON values have types but no TypeScript decoder yet. Their decoders fail every value, and their encoders throw an `EncodeError`, so nothing passes through unchecked.
