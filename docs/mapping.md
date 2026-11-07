# Mapping

Every schema becomes one model, and every language is emitted from the model with the same rules. This page lists each construct: its kind in the model ([`src/model.ts`](../src/model.ts)), what Rust, Go and TypeScript get, and what an LLM provider-ready schema makes of it.

Every Rust type decodes with its own strict reader, `T::from_json`. With `"serdeBridge": true` the types also implement serde's `Deserialize`, which runs the same reader ([serde-bridge.md](serde-bridge.md)).

To see one type of your own schemas, run `strictgen explain <file.json#/pointer>` ([cli.md](cli.md#explain)). [`examples/basic`](../examples/basic) has generated code for most rows.

## The table

The rows are the mapping rules of the conformance suite (`RULES` in [`src/conformance/coverage.ts`](../src/conformance/coverage.ts)), in its order. Each needs a valid and an invalid case in the suite, which runs them in every language, and a test fails when this table and that list differ. `T`, `K` and `V` stand for the types inside.

| Rule | Construct | Model | Rust | Go | TypeScript | LLM schema |
| ---- | --------- | ----- | ---- | -- | ---------- | ---------- |
| `object` | A closed object with `properties` | `struct` | `struct`, with `serde` renames to the keys; `Deserialize` too with the [serde bridge](serde-bridge.md) | `struct`, with `json` tags | `interface` | Closed, every property listed in `required` |
| `object.required` | A key in `required` | field, `required: true` | `T` | `T` | `key: T` | Required |
| `object.optional` | A key not in `required` | field, `required: false` | `Option<T>`, left out when `None` | `*T` with `omitempty` | `key?: T` | Required and nullable: `anyOf: [T, null]`, `null` read as absent |
| `object.exactly-one` | A `oneOf` beside properties whose branches only list `required` keys | `untagged` of one `struct` per choice, each with `forbidden` keys | `enum` with one struct per choice | `struct` with one pointer per choice, exactly one set | Union of one `interface` per choice, the other choices' keys typed `never` | `anyOf` of the choices |
| `object.rest` | Named properties beside an `additionalProperties` schema | `struct` with `rest` | `rest: BTreeMap<String, V>` beside the fields | `Rest map[string]V` with `json:"-"` | An index signature `[key: string]: V` | Fails with `llm-unsupported`: a closed object can't describe data keys |
| `object.recursive` | A property that leads back to its own type | field, `boxed: true` | `Box<T>` | `*T` | `T` | In `$defs` with a `$ref`, for a profile that takes recursion; else `llm-unsupported` |
| `tagged` | A `oneOf` of objects that share a required string `const` key | `tagged` | `enum` of the branch structs, decoded by the tag | An `interface` the branch structs implement, decoded with `DecodeX` | Union of the branch interfaces | `anyOf` of the branches, each tag a `const` or a one value `enum` |
| `tagged.recursive` | A tagged branch that leads back to the union | tagged variant, `boxed: true` | `Box<T>` in the variant | The branch struct, held by the interface | `T` | As `object.recursive` |
| `untagged` | A `oneOf` without a shared tag | `untagged` | `enum`, variants tried [in order](#untagged-unions) | `struct` with one pointer per variant, exactly one set | Union of the variant types | `anyOf` of the variants |
| `untagged.recursive` | An untagged variant that leads back to the union | untagged variant, `boxed: true` | `Box<T>` in the variant | `*T` | `T` | As `object.recursive` |
| `enum` | `enum` of strings | `enum` | `enum` with a `serde` rename per value | `type X string` and a constant per value | Union of string literals | `enum` |
| `const.string` | A string `const`, or an `enum` of one value | `enum` of one value | `enum` of one variant | `type X string` and one constant | A string literal | `const`, or an `enum` of one value for a profile without `const` |
| `const.integer` | An integer `const` | `literal` | `ConstInt<N>` | A type like `ConstInt2` | A number literal like `2` | `const`, or an `enum` of one value |
| `const.boolean` | A boolean `const` | `literal` | `ConstBool<B>` | A type like `ConstBoolTrue` | `true` or `false` | `const`, or an `enum` of one value |
| `id` | A string def matching the `ids` option | `id` | A newtype `struct X(pub String)` | `type X string` | A branded string `string & { readonly __brand: "X" }` | `string`, with its constraints |
| `alias` | A def that is another type: a `$ref`, a primitive with constraints, an array or a map | `alias` | `pub type X = T`, or a newtype `struct X(pub T)` when it has constraints | `type X T`, with an `UnmarshalJSON` that checks it | `type X = T` | Inlined |
| `string` | `"type": "string"` | `string` | `String` | `string` | `string` | `string` |
| `integer` | `"type": "integer"` | `integer` | `i64` | `int64` | `number` | `integer` |
| `integer.int64` | An integer beyond 2^53 - 1 | `integer` | `i64`, to the 64-bit limit | `int64`, to the 64-bit limit | Rejected with `out_of_range_integer` | `integer` |
| `number` | `"type": "number"` | `number` | `serde_json::Number` | `json.Number` | `number` | `number` |
| `boolean` | `"type": "boolean"` | `boolean` | `bool` | `bool` | `boolean` | `boolean` |
| `any` | `{}`, any JSON value | `any` | `serde_json::Value` | `json.RawMessage` | `unknown` | Fails with `llm-unsupported` |
| `non-null` | `{ "not": { "const": null } }` | `nonNull` | `NonNullJson` | `NonNullJson` | `NonNullable<unknown>` | Fails with `llm-unsupported` |
| `array` | `"type": "array"` with `items` | `array` | `Vec<T>` | `[]T` | `T[]` | `array` |
| `map` | An object with only an `additionalProperties` schema | `map` | `BTreeMap<String, V>` | `map[string]V` | `Record<string, V>` | An array of `{ key, value }` entries, or an object, by profile |
| `map.key` | A map with `propertyNames`: an enum, a pattern or a length | `map` with a key type | `BTreeMap<K, V>` | `map[K]V` | `Partial<Record<K, V>>` for an enum, else `Record<string, V>` | With entries, the key's schema on `key`; as an object, a hint in the description, checked by the decoder |
| `string.minLength` | `minLength` | on `string` | Checked by the decoder, in code points | Checked | Checked | Kept if the profile takes it, else a hint and the decoder |
| `string.maxLength` | `maxLength` | on `string` | Checked, in code points | Checked | Checked | Kept or moved |
| `string.pattern` | `pattern`, in the [portable subset](error-codes.md#patterns) | on `string` | Checked with the `regex` crate | Checked with `regexp` | Checked with `RegExp` with the `u` flag, and a template literal type for a fixed prefix or suffix | Kept or moved |
| `format.date-time` | `"format": "date-time"` | on `string` | Checked by a hand written grammar, kept a `String` | Checked, kept a `string` | Checked, kept a `string` | Kept or moved |
| `format.date` | `"format": "date"` | on `string` | Checked, kept a `String` | Checked | Checked | Kept or moved |
| `format.uuid` | `"format": "uuid"` | on `string` | Checked, kept a `String` | Checked | Checked | Kept or moved |
| `integer.minimum` | `minimum` on an integer | on `integer` | Checked exactly | Checked exactly | Checked exactly | Kept or moved |
| `integer.exclusiveMinimum` | `exclusiveMinimum` on an integer | on `integer` | Checked | Checked | Checked | Kept or moved |
| `integer.maximum` | `maximum` on an integer | on `integer` | Checked | Checked | Checked | Kept or moved |
| `integer.exclusiveMaximum` | `exclusiveMaximum` on an integer | on `integer` | Checked | Checked | Checked | Kept or moved |
| `integer.multipleOf` | `multipleOf`, on integers only | on `integer` | Checked | Checked | Checked | Kept or moved |
| `number.minimum` | `minimum` on a number | on `number` | Checked as the nearest 64-bit float | Checked the same way | Checked the same way | Kept or moved |
| `number.exclusiveMinimum` | `exclusiveMinimum` on a number | on `number` | Checked | Checked | Checked | Kept or moved |
| `number.maximum` | `maximum` on a number | on `number` | Checked | Checked | Checked | Kept or moved |
| `number.exclusiveMaximum` | `exclusiveMaximum` on a number | on `number` | Checked | Checked | Checked | Kept or moved |
| `array.minItems` | `minItems` | on `array` | Checked | Checked | Checked | Kept or moved |
| `array.maxItems` | `maxItems` | on `array` | Checked | Checked | Checked | Kept or moved |
| `array.uniqueItems` | `uniqueItems` | on `array` | Checked by [canonical JSON](error-codes.md#constraints) | Checked the same way | Checked the same way | Kept or moved |
| `map.minProperties` | `minProperties` on a map | on `map` | Checked | Checked | Checked | `minItems` of the entries, or kept or moved |
| `map.maxProperties` | `maxProperties` on a map | on `map` | Checked | Checked | Checked | `maxItems` of the entries, or kept or moved |

Every constraint is checked by the decoders in one fixed order, after the structure of the whole value, so every language reports the same first error ([error-codes.md](error-codes.md#constraints)). "Kept or moved" means the provider-ready schema keeps the keyword when the profile accepts it, and otherwise writes it as a hint in the description and leaves it to the LLM decoder ([llm.md](llm.md#what-each-profile-keeps)).

## Untagged unions

A tagged union reads its tag and decodes only the branch it names. An untagged union has no tag, so it tries its variants one after another and keeps the first that decodes. The order is fixed by the kind of each variant, not by the schema, and the same in every language:

1. Objects with properties
2. Arrays
3. Maps (objects without properties)
4. Enums and string consts
5. Strings
6. Integers
7. Numbers
8. Booleans
9. Other unions
10. Anything else, like any JSON value

Variants of the same kind keep their schema order. A value two variants take decodes as the earlier one, in every language. Constraints never pick a variant: a value that fits a variant's structure is that variant, and breaking its constraints is an error, not a reason to try the next. When no variant takes the value, the error is `wrong_type` at the union's path, naming the union, like `expected Contact`, or `null_not_allowed` for `null`.

Two variants that map to the same name, like two strings, fail generation with `untagged-union` ([schemas.md](schemas.md#untagged-union)): give the branches a tag, or make them different kinds. In report mode, see [read-modes.md](read-modes.md#unions) for which unknown keys a union reports.

## Numbers

| | Rust | Go | TypeScript |
| - | ---- | -- | ---------- |
| `integer` | `i64` | `int64` | `number`, within `Number.MAX_SAFE_INTEGER` (2^53 - 1) |
| An integer past 2^53 - 1 | Decodes, up to the 64-bit limit | Decodes, up to the 64-bit limit | Fails with `out_of_range_integer` |
| `12.0`, `1e2` or `-0` as an `integer` | Fails with `wrong_type` | Fails with `wrong_type` | Fails with `wrong_type` from `decodeXFromJson`; decodes after `JSON.parse` |
| `number` | `serde_json::Number` | `json.Number` | `number`, a 64-bit float |
| `12.0` as a `number`, encoded again | `12.0` | `12.0` | `12` |
| Constraints on a `number` | The nearest 64-bit float to the text | The same | The same |

Integer bounds and `multipleOf` must be safe integers, so every language holds them. `multipleOf` on a number fails generation (`unsupported-constraint`), since float division rounds differently from language to language. A number in an error message is written the way JavaScript writes a 64-bit float, in every language.

## Strings written again

Rust, TypeScript and Go's `Encode` write a string the same way. `"` and `\` get a backslash, and backspace, form feed, newline, carriage return and tab are written as `\b`, `\f`, `\n`, `\r` and `\t`. Any other character below U+0020 is written as `\u00` and two lowercase hex digits, and every other character as it is, `<`, `>`, `&`, U+2028 and U+2029 included. The strings inside a value of any JSON type are written this way too, whatever escapes the input used. Go's `json.Marshal` writes the same JSON value but escapes `<`, `>`, `&`, U+2028 and U+2029, so use `Encode` when the bytes matter, as for a hash.

## TypeScript limits

JavaScript holds every JSON number as a 64-bit float and keeps neither its spelling nor every integer, so TypeScript is the one place the languages can't accept the same input. strictgen makes TypeScript fail rather than read a different number:

- An integer past 2^53 - 1 fails with `out_of_range_integer`, which Rust and Go decode. Keep IDs and amounts that can get that large as strings
- `decodeXFromJson` reads the text with a strict reader, so it rejects `12.0` for an integer and a key given twice, as Rust and Go do. `decodeX` reads a value `JSON.parse` already made and can't see either
- A `number` encodes again as JavaScript writes it, so `12.0` comes back as `12` and `-0` as `0`

[typescript.md](typescript.md#numbers) has the full table. The conformance suite marks each case where the languages differ for these reasons and fails if a mark isn't needed.
