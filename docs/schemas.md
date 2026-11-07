# Supported schemas

strictgen reads a strict subset of [JSON Schema 2020-12](https://json-schema.org/draft/2020-12). Everything in the subset maps the same way in Rust, Go and TypeScript. Anything outside it fails generation with the file, the JSON Pointer, a stable rule id and, when there is an obvious fix, a hint. The aim is that nothing is ignored quietly, so a schema that generates means what every language does with it.

Already have schemas that don't fit? [`strictgen fix`](#moving-an-existing-schema-in) rewrites most of them into the subset.

## Files and names

The `schemas` folder of the config holds one schema per `.json` file. Every file is read, and `$ref`s between them are resolved within the folder only.

| What | Becomes |
| ---- | ------- |
| A schema root with a type | A type named by its `title` in PascalCase: `"title": "Order"` is `Order`. A root with a type needs a `title` (`missing-title`) |
| A schema root with only `$defs` | No type of its own, only the types of its `$defs` |
| A `$defs` entry | A type named by its key in PascalCase: `orderLine` is `OrderLine`. When two files have a def of the same name, each gets the file name in front, like `OrderOrderLine` and `UserOrderLine` |
| A property | A field. Rust uses snake case with a `serde` rename to the key, Go an exported name with a `json` tag, TypeScript the key as it is |
| An inline object, enum or union inside a property | A type named after its parent and the key, like `OrderPayment` |

A name must start with a letter (`unsupported-name`), and two items must not end up with the same name (`name-clash`). The type names of a mapping, like the variants of a union, are in [mapping.md](mapping.md).

### Reserved names

A field named like a keyword is escaped where the language allows it: `r#type` and `r#match` in Rust (`self_` and `crate_` for the keywords that can't be raw), the exported field name in Go (`Type`, `Func`, `Default`), and the key as it is in TypeScript, which allows keywords as property names. A type named like a keyword, or like a name the generated code uses itself (`Self`, `Option` or `DecodeError` in Rust, `DecodeError` in Go, `Record`, `Partial` or `DecodeError` in TypeScript), fails with `reserved-name` and a hint to rename it. Only the configured targets' names apply, so a type named `Record` is fine when TypeScript isn't a target.

## The header

Every file starts with the same header:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/v1/order.json",
  "title": "Order",
  "description": "An order placed in the shop."
}
```

- `$id` is the base every file shares, then the file name: `order.json` has the `$id` `<base>order.json` (`schema-id`). The base is taken from the first file by name, or set with the `idBase` config option, and ends in `/` or `#`
- `title` names the root type, and `description` becomes its doc comment in every language
- `$schema`, `$id`, `$defs`, `title`, `description` and `$comment` are the keys a file's root may have when it has no type of its own

## `$defs` and references

Shared types live in `$defs` at the root of a file. A `$ref` takes one of three forms:

| Form | Points at |
| ---- | --------- |
| `#/$defs/<name>` | A def of the same file |
| `<base><file>.json` | The root type of another file, like `https://example.com/schemas/v1/user.json` |
| `<base><file>.json#/$defs/<name>` | A def of another file |

A def name is letters and digits only, so a `$ref` can name it. A `$ref` into anything else, like `#/properties/id`, fails with `ref-form`. Beside a `$ref`, only `description`, `$comment`, the def's own `type` (`type-mismatch` for another) and properties set to `false` are allowed (`ref-siblings`): constraints go on the def itself. A key set to `false` must be one the def already rejects, like a key a closed object doesn't list, since no decoder checks it beside the `$ref`. `$defs` is allowed only at the root of a file, and `definitions` not at all (`unsupported-keyword`); `strictgen fix` moves both.

## Closed objects

Every object is closed: it lists its keys in `properties`, and has `"additionalProperties": false`, or `"unevaluatedProperties": false` when it has an `allOf` or `oneOf` beside its properties (`open-object`, `closed-with-allof`). That is what lets every decoder reject or report an unknown key, rather than keep it in one language and drop it in another.

An object takes other keys only as data, with a schema for their values: `"additionalProperties": { "type": "integer" }` is a map, and beside `properties` it is a map of the keys that aren't named. `propertyNames` gives the keys a type: a string with constraints, or an enum. JSON Schema applies it to the named keys too, so each named key must be one it allows (`invalid-constraint`): list it in the enum, or give `propertyNames` an `anyOf` of a `{ "const": "<key>" }` per named key and the schema of the other keys. An object with no properties and no closing stays open only as an `allOf` base.

- `required` keys must be present. Other keys are optional: absent, or present with a value, never `null`
- `allOf` merges objects: the base's properties and required keys join the object's. A property declared twice must have the same schema (`property-redeclared`). An `allOf` part closes nothing, so `unevaluatedProperties` goes on the object that holds the `allOf` (`misplaced-keyword`)
- A closed def, with `"unevaluatedProperties": false`, can also be an `allOf` base, and its keys join the object's like an open base's. This differs from JSON Schema on purpose: there, the base's `unevaluatedProperties` sees only the base's own keys, so it would reject every key the object adds
- `oneOf` beside properties, with branches that only list `required` keys, is an exactly-one choice: one of the keys must be present, and the others must not
- Conditions fail generation, since no decoder checks them. `anyOf` beside properties, like "at least one of `email` or `phone`", fails with `misplaced-keyword`: use a `oneOf` of the same branches for exactly one of the keys, or list them all in `required`. `if`, `then` and `else` fail with `unsupported-keyword` in every schema strictgen reads: defs, properties, items, map values, union branches, `allOf` parts and bases, `propertyNames` and the schema inside `not`. For a shape that depends on a value, use a [tagged union](mapping.md), a `oneOf` of closed objects that each have a required `const` tag

## IDs

With the `ids` config option, string defs of one file whose name ends in a suffix are IDs: `{ "file": "common", "suffix": "Id" }` makes `userId` and `orderId` of `common.json` the types `UserId` and `OrderId`. Each is a type of its own, so one kind of ID can't be passed where another is expected: a newtype `pub struct UserId(pub String)` in Rust, `type UserId string` in Go, and a branded string `string & { readonly __brand: "UserId" }` in TypeScript. An ID must be a string (`type-mismatch`). Without `ids`, nothing is an ID. See [`examples/basic`](../examples/basic).

## Supported keywords

| Kind | Keywords |
| ---- | -------- |
| Any schema | `type` (one of `object`, `array`, `string`, `integer`, `number`, `boolean`), `$ref`, `const`, `enum`, `oneOf`, `not` (only as `{ "not": { "const": null } }`), `description`, `$comment`, `title`, `default`, `examples` |
| Objects | `properties`, `required`, `additionalProperties`, `unevaluatedProperties`, `propertyNames`, `allOf`, `oneOf`, `minProperties` and `maxProperties` on a map |
| Arrays | `items`, `minItems`, `maxItems`, `uniqueItems` |
| Strings | `minLength`, `maxLength`, `pattern` (a [portable subset](error-codes.md#patterns)), `format` (`date-time`, `date`, `uuid`) |
| Integers | `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf` |
| Numbers | `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum` |
| Schema roots | `$schema`, `$id`, `$defs` |

`const` takes a string, an integer or a boolean, and `enum` strings only. `{}` is any JSON value, `null` included, and `{ "not": { "const": null } }` any value but `null`. `default` and `examples` are documentation: the decoders don't fill in defaults. Every constraint is checked by the generated decoders, in a fixed order ([error-codes.md](error-codes.md#constraints)), unless the config sets `"validation": false`. A keyword where it doesn't apply, like `maxLength` on an integer, fails with `misplaced-keyword`, and any other keyword with `unsupported-keyword`.

## Generation rules

Every rule id below is stable across releases. In the `invalid-json` example, the words after `not valid JSON:` are Node's `JSON.parse` message, which changes between Node versions, so the docs show a placeholder. Each example is the schema, with its `$schema` and `$id` header left out, the config when it isn't just a TypeScript target, the error `strictgen generate` prints, and the schema fixed. `pnpm docs` runs each one, so the errors here are the real ones and every fixed schema generates.


### `read-failed`

A schema file or the schemas folder can't be read.

Here the config names a schemas folder that doesn't exist (`"schemas": "schema"` where the folder is `schemas`). Fix the path in `strictgen.json`, or create the folder.

<!-- snippet: rule read-failed -->
`strictgen.json`:

```json
{ "schemas": "schema", "targets": { "typescript": { "out": "out/ts" } } }
```

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

```text
error: schema: read-failed: can't read the schemas folder: a folder on the way is missing, or is a symlink that points nowhere (ENOENT)
```
<!-- /snippet -->

### `invalid-json`

A schema file is not valid JSON.

<!-- snippet: rule invalid-json -->
`order.json`:

```text
{ "title": "Order", "type": "object", }
```

```text
error: order.json: invalid-json: not valid JSON: <the JSON.parse message>
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `invalid-schema`

A value is not what JSON Schema expects there, like a non-string $ref.

<!-- snippet: rule invalid-schema -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": "id",
  "additionalProperties": false
}
```

```text
error: order.json#/required: invalid-schema: expected a non-empty array
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `schema-id`

A schema's $id must be <idBase><file>.json.

<!-- snippet: rule schema-id -->
`order.json`:

```json
{
  "$id": "https://example.com/schemas/order.json",
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

`user.json`:

```json
{
  "$id": "https://example.com/users/user.json",
  "title": "User",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

```text
error: user.json#/$id: schema-id: $id is "https://example.com/users/user.json", expected https://example.com/schemas/user.json (base https://example.com/schemas/, taken from order.json). Hint: set the $id to https://example.com/schemas/user.json, or set the idBase option
```

Fixed:

`order.json`:

```json
{
  "$id": "https://example.com/schemas/order.json",
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

`user.json`:

```json
{
  "$id": "https://example.com/schemas/user.json",
  "title": "User",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `missing-title`

A schema with a root type needs a title to name it.

<!-- snippet: rule missing-title -->
`order.json`:

```json
{
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

```text
error: order.json#/title: missing-title: a typed schema needs a title to name its root type. Hint: add a "title", like "title": "Order", or move the schema into $defs
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unresolved-ref`

A $ref names a schema or def that isn't in the schema set.

<!-- snippet: rule unresolved-ref -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "user": { "$ref": "https://example.com/schemas/user.json" } },
  "required": ["user"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/user: unresolved-ref: $ref https://example.com/schemas/user.json names an unknown schema
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "user": { "$ref": "https://example.com/schemas/user.json" } },
  "required": ["user"],
  "additionalProperties": false
}
```

`user.json`:

```json
{
  "title": "User",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `ref-form`

A $ref must name a schema file or one of its $defs entries.

<!-- snippet: rule ref-form -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" }, "copy": { "$ref": "#/properties/id" } },
  "required": ["id", "copy"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/copy: ref-form: $ref #/properties/id must point at a $defs entry. Hint: move the schema it points at into $defs and refer to #/$defs/<name>
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "$ref": "#/$defs/orderId" }, "copy": { "$ref": "#/$defs/orderId" } },
  "required": ["id", "copy"],
  "additionalProperties": false,
  "$defs": { "orderId": { "type": "string" } }
}
```
<!-- /snippet -->

### `ref-cycle`

A $ref chain loops or is too deep.

<!-- snippet: rule ref-cycle -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "$ref": "#/$defs/code" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "code": { "$ref": "#/$defs/code" } }
}
```

```text
error: order.json#/$defs/code/$ref: ref-cycle: a def can't be a $ref to itself
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "$ref": "#/$defs/code" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "code": { "type": "string" } }
}
```
<!-- /snippet -->

### `ref-siblings`

Keywords beside $ref may only forbid a key with false.

<!-- snippet: rule ref-siblings -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "customer": { "$ref": "#/$defs/customer", "properties": { "vip": { "type": "boolean" } } }
  },
  "required": ["customer"],
  "additionalProperties": false,
  "$defs": {
    "customer": {
      "type": "object",
      "properties": { "name": { "type": "string" } },
      "required": ["name"],
      "additionalProperties": false
    }
  }
}
```

```text
error: order.json#/properties/customer/properties/vip: ref-siblings: properties beside $ref may only forbid a key with false
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "customer": { "$ref": "#/$defs/customer" } },
  "required": ["customer"],
  "additionalProperties": false,
  "$defs": {
    "customer": {
      "type": "object",
      "properties": { "name": { "type": "string" }, "vip": { "type": "boolean" } },
      "required": ["name", "vip"],
      "additionalProperties": false
    }
  }
}
```
<!-- /snippet -->

### `unsupported-keyword`

The keyword is outside the supported subset.

<!-- snippet: rule unsupported-keyword -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string", "contentEncoding": "base64" } },
  "required": ["id"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/id/contentEncoding: unsupported-keyword: unsupported keyword contentEncoding. Hint: remove it, or keep the note in "description" or "$comment"
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string", "description": "Base64 text." } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `misplaced-keyword`

The keyword is supported, but not in this position.

<!-- snippet: rule misplaced-keyword -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "quantity": { "type": "integer", "maxLength": 3 } },
  "required": ["quantity"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/quantity/maxLength: misplaced-keyword: maxLength doesn't apply to an integer. Hint: use it beside "type": "string"
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "quantity": { "type": "integer", "maximum": 999 } },
  "required": ["quantity"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-type`

Type must be one of object, array, string, integer, number or boolean.

<!-- snippet: rule unsupported-type -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "note": { "type": ["string", "null"] } },
  "required": ["note"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/note/type: unsupported-type: type must be one of object, array, string, integer, number or boolean. Hint: use one type and make the key optional instead of allowing null
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "note": { "type": "string" } },
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-format`

Only the date-time, date and uuid formats are supported.

<!-- snippet: rule unsupported-format -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "email": { "type": "string", "format": "email" } },
  "required": ["email"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/email/format: unsupported-format: only the date-time, date and uuid formats are supported. Hint: remove "format", or check the shape with "pattern"
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "email": { "type": "string", "pattern": "^[^@]+@[^@]+$" } },
  "required": ["email"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-pattern`

A pattern uses syntax Rust's regex, Go's RE2 and ECMAScript don't read the same way.

<!-- snippet: rule unsupported-pattern -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "code": { "type": "string", "pattern": "^(?=.*\\d)[A-Z0-9]+$" } },
  "required": ["code"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/code/pattern: unsupported-pattern: lookarounds are not supported by Rust's regex and Go's RE2 at character 2
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "code": { "type": "string", "pattern": "^[A-Z]*[0-9][A-Z0-9]*$" } },
  "required": ["code"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-constraint`

The constraint can't be checked the same way in every language, or isn't checked yet.

<!-- snippet: rule unsupported-constraint -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "price": { "type": "number", "multipleOf": 0.01 } },
  "required": ["price"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/price/multipleOf: unsupported-constraint: multipleOf on a number can give different results in each language, since floats round. Hint: use "type": "integer" with a multipleOf, or remove it
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "cents": { "type": "integer", "multipleOf": 1 } },
  "required": ["cents"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `invalid-constraint`

A constraint's value is out of range, or its limits can't both hold.

<!-- snippet: rule invalid-constraint -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "note": { "type": "string", "minLength": 10, "maxLength": 5 } },
  "required": ["note"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/note/minLength: invalid-constraint: minLength 10 and maxLength 5 leave no value that fits
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "note": { "type": "string", "minLength": 5, "maxLength": 10 } },
  "required": ["note"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-not`

Not may only exclude null, as { "not": { "const": null } }.

<!-- snippet: rule unsupported-not -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "role": { "type": "string", "not": { "enum": ["admin"] } } },
  "required": ["role"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/role/not: unsupported-not: not beside a string type is not checked. Hint: use "pattern" for the strings that are allowed, or an "enum" of them
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "role": { "enum": ["owner", "member"] } },
  "required": ["role"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-const`

A const must be a string, an integer or a boolean, matching its type.

<!-- snippet: rule unsupported-const -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "rate": { "const": 1.5 } },
  "required": ["rate"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/rate/const: unsupported-const: const must be a string, an integer or a boolean
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "rate": { "const": "1.5" } },
  "required": ["rate"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-enum`

Enum values must be unique strings.

<!-- snippet: rule unsupported-enum -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "size": { "enum": [1, 2, 3] } },
  "required": ["size"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/size/enum/0: unsupported-enum: enum values must be strings
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "size": { "enum": ["1", "2", "3"] } },
  "required": ["size"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `missing-type`

A schema needs a type, $ref, const, enum or oneOf.

<!-- snippet: rule missing-type -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "line": { "description": "A line.", "properties": { "sku": { "type": "string" } } }
  },
  "required": ["line"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/line: missing-type: schema has no type, $ref, const, enum or oneOf. Hint: add a "type", like "type": "object"
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "line": {
      "description": "A line.",
      "type": "object",
      "properties": { "sku": { "type": "string" } },
      "required": ["sku"],
      "additionalProperties": false
    }
  },
  "required": ["line"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `type-mismatch`

The schema's type doesn't fit where it is used.

<!-- snippet: rule type-mismatch -->
`strictgen.json`:

```json
{
  "schemas": "schemas",
  "targets": { "typescript": { "out": "out/ts" } },
  "ids": { "file": "order", "suffix": "Id" }
}
```

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "$ref": "#/$defs/orderId" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "orderId": { "type": "integer" } }
}
```

```text
error: order.json#/$defs/orderId: type-mismatch: an id must be a string. Hint: give it "type": "string", or rename it so the ids suffix doesn't match
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "$ref": "#/$defs/orderId" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "orderId": { "type": "string" } }
}
```
<!-- /snippet -->

### `missing-items`

An array needs an items schema.

<!-- snippet: rule missing-items -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "tags": { "type": "array" } },
  "required": ["tags"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/tags: missing-items: an array needs items. Hint: add "items", like "items": { "type": "string" }
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "tags": { "type": "array", "items": { "type": "string" } } },
  "required": ["tags"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `map-values`

A map needs an additionalProperties schema for its values.

<!-- snippet: rule map-values -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "labels": { "type": "object", "propertyNames": { "type": "string", "maxLength": 8 } }
  },
  "required": ["labels"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/labels: map-values: a map needs an additionalProperties schema for its values. Hint: add "additionalProperties" with the value schema, like { "type": "string" }
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "labels": {
      "type": "object",
      "propertyNames": { "type": "string", "maxLength": 8 },
      "additionalProperties": { "type": "string" }
    }
  },
  "required": ["labels"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `unsupported-map-key`

Map keys must be strings or a string enum.

<!-- snippet: rule unsupported-map-key -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "counts": {
      "type": "object",
      "propertyNames": { "type": "integer" },
      "additionalProperties": { "type": "integer" }
    }
  },
  "required": ["counts"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/counts/propertyNames: unsupported-map-key: map keys must be strings
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": {
    "counts": {
      "type": "object",
      "propertyNames": { "type": "string", "pattern": "^[0-9]+$" },
      "additionalProperties": { "type": "integer" }
    }
  },
  "required": ["counts"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `open-object`

Objects must be closed, unless they are only an allOf base.

<!-- snippet: rule open-object -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"]
}
```

```text
error: order.json#: open-object: objects must be closed, unless only used as an allOf base. Hint: add "additionalProperties": false
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `closed-with-allof`

Beside allOf, close an object with unevaluatedProperties false.

<!-- snippet: rule closed-with-allof -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "allOf": [{ "$ref": "#/$defs/base" }],
  "properties": { "total": { "type": "integer" } },
  "additionalProperties": false,
  "$defs": {
    "base": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"]
    }
  }
}
```

```text
error: order.json#/additionalProperties: closed-with-allof: use unevaluatedProperties false beside allOf. Hint: replace "additionalProperties": false with "unevaluatedProperties": false
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "allOf": [{ "$ref": "#/$defs/base" }],
  "properties": { "total": { "type": "integer" } },
  "unevaluatedProperties": false,
  "$defs": {
    "base": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"]
    }
  }
}
```
<!-- /snippet -->

### `undeclared-key`

A key is used, required or named in a branch without a property schema.

<!-- snippet: rule undeclared-key -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id", "total"],
  "additionalProperties": false
}
```

```text
error: order.json#/required: undeclared-key: required key total has no property schema. Hint: add total to "properties"
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" }, "total": { "type": "integer" } },
  "required": ["id", "total"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `property-redeclared`

A property is declared twice with different schemas.

<!-- snippet: rule property-redeclared -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "allOf": [{ "$ref": "#/$defs/base" }],
  "properties": { "id": { "type": "integer" } },
  "unevaluatedProperties": false,
  "$defs": {
    "base": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"]
    }
  }
}
```

```text
error: order.json#/properties/id: property-redeclared: property id is redeclared with another schema (first at order.json#/$defs/base/properties/id). Hint: declare id once, or redeclare it as true
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "allOf": [{ "$ref": "#/$defs/base" }],
  "properties": { "id": { "type": "string" } },
  "unevaluatedProperties": false,
  "$defs": {
    "base": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"]
    }
  }
}
```
<!-- /snippet -->

### `unsupported-branch`

A branch of oneOf, anyOf or propertyNames has an unsupported shape.

<!-- snippet: rule unsupported-branch -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "email": { "type": "string" }, "phone": { "type": "string" } },
  "oneOf": [
    { "required": ["email"], "properties": { "email": { "type": "string" } } },
    { "required": ["phone"] }
  ],
  "unevaluatedProperties": false
}
```

```text
error: order.json#/oneOf/0/properties/email: unsupported-branch: branch properties may only be true. Hint: declare the property's schema on the object and list it as true in the branch
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "email": { "type": "string" }, "phone": { "type": "string" } },
  "oneOf": [{ "required": ["email"] }, { "required": ["phone"] }],
  "unevaluatedProperties": false
}
```
<!-- /snippet -->

### `union-tag`

A oneOf tag must be a required string const on every branch, with distinct values.

<!-- snippet: rule union-tag -->
`payment.json`:

```json
{
  "title": "Payment",
  "oneOf": [
    {
      "type": "object",
      "properties": { "type": { "const": "card" }, "last4": { "type": "string" } },
      "required": ["type", "last4"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": { "type": { "const": "card" }, "iban": { "type": "string" } },
      "required": ["type", "iban"],
      "additionalProperties": false
    }
  ]
}
```

```text
error: payment.json#: union-tag: branches carry the tag type only partly, or repeat its values. Hint: make type a required string const on every branch, with a different value on each
```

Fixed:

`payment.json`:

```json
{
  "title": "Payment",
  "oneOf": [
    {
      "type": "object",
      "properties": { "type": { "const": "card" }, "last4": { "type": "string" } },
      "required": ["type", "last4"],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": { "type": { "const": "wire" }, "iban": { "type": "string" } },
      "required": ["type", "iban"],
      "additionalProperties": false
    }
  ]
}
```
<!-- /snippet -->

### `untagged-union`

Two branches of a oneOf without a shared tag map to the same variant.

<!-- snippet: rule untagged-union -->
`payment.json`:

```json
{
  "title": "Payment",
  "oneOf": [{ "type": "string", "maxLength": 4 }, { "type": "string", "pattern": "^[0-9]+$" }]
}
```

```text
error: payment.json#/oneOf/1: untagged-union: two branches of the union are both named String. Hint: give every branch a required tag property with a distinct const, like "type": { "const": "card" }
```

Fixed:

`payment.json`:

```json
{
  "title": "Payment",
  "oneOf": [{ "type": "string", "maxLength": 4 }, { "type": "integer" }]
}
```
<!-- /snippet -->

### `alias-cycle`

A type can't contain itself through aliases only.

<!-- snippet: rule alias-cycle -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "parts": { "$ref": "#/$defs/parts" } },
  "required": ["parts"],
  "additionalProperties": false,
  "$defs": { "parts": { "type": "array", "items": { "$ref": "#/$defs/parts" } } }
}
```

```text
error: order.json#/$defs/parts: alias-cycle: alias Parts contains itself. Hint: wrap the recursive part in an object, so a struct holds it
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "parts": { "$ref": "#/$defs/parts" } },
  "required": ["parts"],
  "additionalProperties": false,
  "$defs": {
    "parts": { "type": "array", "items": { "$ref": "#/$defs/part" } },
    "part": {
      "type": "object",
      "properties": { "parts": { "$ref": "#/$defs/parts" } },
      "required": ["parts"],
      "additionalProperties": false
    }
  }
}
```
<!-- /snippet -->

### `name-clash`

Two schema items map to the same name in the generated code.

<!-- snippet: rule name-clash -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "orderLine": { "type": "string" }, "OrderLine": { "type": "integer" } }
}
```

```text
error: order.json#/$defs/orderLine: name-clash: type name OrderOrderLine is also used by order.json#/$defs/OrderLine. Hint: rename the $defs entry, or the schema's title, so the type gets another name
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "orderLine": { "type": "string" }, "lineCount": { "type": "integer" } }
}
```
<!-- /snippet -->

### `reserved-name`

A name is a keyword or a name the generated code uses itself.

<!-- snippet: rule reserved-name -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": {
    "record": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"],
      "additionalProperties": false
    }
  }
}
```

```text
error: order.json#/$defs/record: reserved-name: type name Record is reserved in TypeScript. Hint: rename the $defs entry, or the schema's title, so the type gets another name
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": {
    "auditRecord": {
      "type": "object",
      "properties": { "id": { "type": "string" } },
      "required": ["id"],
      "additionalProperties": false
    }
  }
}
```
<!-- /snippet -->

### `unsupported-name`

A name can't be turned into a valid identifier.

<!-- snippet: rule unsupported-name -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "2fa": { "type": "string" } }
}
```

```text
error: order.json#/$defs/2fa: unsupported-name: type name 2fa must start with a letter. Hint: rename the $defs entry, or the schema's title, so the type gets another name
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false,
  "$defs": { "twoFactor": { "type": "string" } }
}
```
<!-- /snippet -->

### `llm-unsupported`

A type uses something no LLM structured output schema can describe.

<!-- snippet: rule llm-unsupported -->
`strictgen.json`:

```json
{
  "schemas": "schemas",
  "targets": { "typescript": { "out": "out/ts" } },
  "llm": { "profiles": ["openai"], "out": "out/llm" }
}
```

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "meta": {} },
  "required": ["meta"],
  "additionalProperties": false
}
```

```text
error: order.json#/properties/meta: llm-unsupported: profile openai: Order.meta takes any JSON value, which no structured output schema describes. Hint: give it a type
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "meta": { "type": "object", "additionalProperties": { "type": "string" } } },
  "required": ["meta"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `llm-limit`

A type's provider-ready schema is over a limit of the LLM profile.

<!-- snippet: rule llm-limit -->
`strictgen.json`:

```json
{
  "schemas": "schemas",
  "targets": { "typescript": { "out": "out/ts" } },
  "llm": { "profiles": ["profiles/small.json"], "out": "out/llm" }
}
```

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "size": { "enum": ["xs", "s", "m", "l", "xl", "xxl"] } },
  "required": ["size"],
  "additionalProperties": false
}
```

```text
error: order.json#: llm-limit: the small schema for Order has an enum value count of 6, and the profile allows at most 5. Hint: split the type into smaller ones, or use a profile with higher limits
```

Fixed:

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "size": { "enum": ["s", "m", "l"] } },
  "required": ["size"],
  "additionalProperties": false
}
```
<!-- /snippet -->

### `output-conflict`

Writing the output would clear or replace files strictgen doesn't own.

Here a Go target with `"shared": true` writes beside hand written files, and a hand written `order.go` is where the generated one goes. strictgen never overwrites a file it didn't generate. Rename the hand written file, or point the target at a folder of its own. A target folder that holds the config, the schemas or the project root is refused as well, before anything is cleared.

<!-- snippet: rule output-conflict -->
`strictgen.json`:

```json
{
  "schemas": "schemas",
  "targets": { "go": { "out": "go", "package": "types", "shared": true } }
}
```

`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

```text
error: go/order.go: output-conflict: a hand written file is in the way of a generated one, and strictgen won't overwrite it. Hint: move what it holds elsewhere (for .gitattributes, to one in a parent folder) and remove it
```
<!-- /snippet -->

### `write-failed`

The output can't be written.

Here the output folder can't be made, since its parent is read only. Fix the permissions, or point the target elsewhere.

<!-- snippet: rule write-failed -->
`order.json`:

```json
{
  "title": "Order",
  "type": "object",
  "properties": { "id": { "type": "string" } },
  "required": ["id"],
  "additionalProperties": false
}
```

```text
error: out/ts: write-failed: can't write the output: permission denied (EACCES)
```
<!-- /snippet -->

### `internal`

A generator bug, not a schema problem.

A bug in strictgen, not in the schema, so no example can show it. Please [open an issue](https://github.com/sahidhossen/strictgen/issues) with the schema and the error line.

## Moving an existing schema in

Schemas written for other tools are often open, use `definitions`, and give unions without tags. [`examples/fix`](../examples/fix) has such a schema:

<!-- snippet: file examples/fix/schemas/order.json -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schemas/order.json",
  "title": "Order",
  "type": "object",
  "properties": {
    "id": { "type": "string" },
    "payment": {
      "type": "object",
      "oneOf": [
        {
          "properties": { "method": { "enum": ["card"] }, "last4": { "type": "string" } },
          "required": ["last4"]
        },
        {
          "properties": { "method": { "const": "wire" }, "iban": { "type": "string" } },
          "required": ["iban"]
        }
      ]
    },
    "shipping": { "$ref": "#/definitions/address" }
  },
  "required": ["id", "payment"],
  "definitions": {
    "address": {
      "type": "object",
      "properties": { "street": { "type": "string" }, "city": { "type": "string" } }
    }
  }
}
```
<!-- /snippet -->

`strictgen generate` stops at the first thing outside the subset:

<!-- snippet: command examples/fix generate -->
```text
$ strictgen generate
error: order.json#/definitions: unsupported-keyword: unsupported keyword definitions. Hint: remove it, or keep the note in "description" or "$comment"
```
<!-- /snippet -->

`strictgen fix` prints the rewrite as a diff and writes nothing. Then it generates the rewritten schemas in memory and says what is left:

<!-- snippet: command examples/fix fix -->
```text
$ strictgen fix
--- a/schemas/order.json
+++ b/schemas/order.json
@@ -6,25 +6,30 @@
   "properties": {
     "id": { "type": "string" },
     "payment": {
-      "type": "object",
       "oneOf": [
         {
-          "properties": { "method": { "enum": ["card"] }, "last4": { "type": "string" } },
-          "required": ["last4"]
+          "type": "object",
+          "properties": { "method": { "const": "card" }, "last4": { "type": "string" } },
+          "required": ["last4", "method"],
+          "additionalProperties": false
         },
         {
+          "type": "object",
           "properties": { "method": { "const": "wire" }, "iban": { "type": "string" } },
-          "required": ["iban"]
+          "required": ["iban", "method"],
+          "additionalProperties": false
         }
       ]
     },
-    "shipping": { "$ref": "#/definitions/address" }
+    "shipping": { "$ref": "#/$defs/address" }
   },
   "required": ["id", "payment"],
-  "definitions": {
+  "$defs": {
     "address": {
       "type": "object",
-      "properties": { "street": { "type": "string" }, "city": { "type": "string" } }
+      "properties": { "street": { "type": "string" }, "city": { "type": "string" } },
+      "additionalProperties": false
     }
-  }
+  },
+  "additionalProperties": false
 }
strictgen fix --write would change 1 schema file. The schemas generate cleanly.
```
<!-- /snippet -->

It closed every object, turned the `oneOf` into a union tagged by `method` (with the one value `enum` as a `const`), and turned `definitions` into `$defs`, with the `$ref` following it. `strictgen fix --write` writes the change in place, and `strictgen fix > fix.patch` saves it as a patch to review. [cli.md](cli.md#fix) lists every rewrite rule and what each one leaves alone.

Read the diff before you apply it, because closing an object is a decision. Afterwards, data with keys the schema never named is rejected. That is the point, but a producer that sends such keys breaks. Check the change with `strictgen breaking` against the old schemas, or start the consumers in `report` mode ([read-modes.md](read-modes.md)) and watch which keys they report.
