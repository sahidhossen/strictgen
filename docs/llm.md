# LLM structured output

LLM providers take a JSON Schema for structured output, but only a subset of it, and each provider has its own subset and limits. strictgen projects every type into a schema one provider accepts, from the real schema, and lists what the projection had to leave out. An LLM decoder in every language reads what the model sends back, undoes the projection and checks it all. A cleanup step fixes the syntax mistakes models often make in JSON.

```json
{
  "targets": { "typescript": { "out": "src/generated" } },
  "llm": { "profiles": ["openai", "anthropic", "gemini"], "out": "llm", "cleanup": true }
}
```

| Option | Does |
| ------ | ---- |
| `llm.profiles` | The profiles to write schemas for: a built in one by name, or a profile file by its path, ending in `.json` |
| `llm.out` | The folder the schemas go to, as `<out>/<profile>/<Type>.json`. strictgen clears it before writing, like the other folders it owns |
| `llm.cleanup` | Adds the cleanup helper to every configured language, which the LLM decoders run first. Off by default |

`strictgen generate` writes the schemas with the other targets and `strictgen check` compares them. `strictgen llm --profile openai Order` prints one schema on stdout and what moved to the decoder on stderr, or both as JSON with `--json`. The type is named as the generated code names it, and every schema root and `$defs` entry has one. The profile is a built in one, a path ending in `.json`, or a profile file `llm.profiles` lists whose `name` is the one given. To find it, `strictgen llm` reads only the `name` of each listed file, and checks in full only the file that has it (or, for a file that isn't a JSON object with a name, the file named `<name>.json`), so a broken file for another profile doesn't stop it. `generate` and `check` check every listed profile.

## A worked example

[`examples/quickstart`](../examples/quickstart) has one schema and the `openai` profile:

<!-- snippet: file examples/quickstart/strictgen.json -->
```json
{
  "$schema": "../../strictgen.schema.json",
  "schemas": "schemas",
  "targets": {
    "rust": { "out": "rust/src/generated" },
    "go": { "out": "go/types", "package": "types" },
    "typescript": { "out": "ts/generated" }
  },
  "llm": { "profiles": ["openai"], "out": "llm" }
}
```
<!-- /snippet -->

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

`strictgen generate` writes the provider-ready schema to `llm/openai/Order.json`. `strictgen llm` prints the same schema, and on stderr what the projection moved to the decoder:

<!-- snippet: command examples/quickstart llm --profile openai Order -->
```text
$ strictgen llm --profile openai Order
{
  "description": "An order placed in the shop.",
  "type": "object",
  "properties": {
    "id": {
      "description": "The order's id.",
      "type": "string"
    },
    "quantity": {
      "description": "How many items.",
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "status": {
      "description": "Where the order is.",
      "type": "string",
      "enum": [
        "pending",
        "paid",
        "shipped"
      ]
    },
    "note": {
      "description": "A note for the packer. At most 40 characters.",
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "quantity",
    "status",
    "note"
  ],
  "additionalProperties": false
}
Moved to the decoder:
  /properties/note: optional, so required and nullable: null stands for absent
  /properties/note/anyOf/0: maxLength 40: at most 40 characters
```
<!-- /snippet -->

OpenAI's structured outputs don't list `maxLength`, so the 40 character limit of `note` is only a hint in the description, and the model can break it. Say it answers with a note of 55 characters:

<!-- snippet: file examples/quickstart/answers/long-note.json -->
```json
{ "id": "ord_7d2k", "quantity": 2, "status": "paid", "note": "Please leave the parcel with the neighbour at number 12" }
```
<!-- /snippet -->

The LLM decoders of all three languages reject it with the same compact error, ready to send back to the model so it can retry:

<!-- snippet: decode llm compact answers/long-note.json answers/null-note.json -->
```text
answers/long-note.json
  Rust        /note too_long, expected at most 40 characters, found 55 characters
  Go          /note too_long, expected at most 40 characters, found 55 characters
  TypeScript  /note too_long, expected at most 40 characters, found 55 characters

answers/null-note.json
  Rust        ok {"id":"ord_7d2k","quantity":2,"status":"paid"}
  Go          ok {"id":"ord_7d2k","quantity":2,"status":"paid"}
  TypeScript  ok {"id":"ord_7d2k","quantity":2,"status":"paid"}
```
<!-- /snippet -->

The second answer gives `null` for `note`, as the projection makes the model do for a field it leaves out. The decoders read it as absent, so the order they return has no note, the same value the normal decoder makes of JSON without the key. These lines are printed by the Rust, Go and TypeScript programs of the example, run by `pnpm docs:check` in CI.

## Profiles

A profile is a JSON file that `profiles/profile.schema.json` describes. strictgen ships three, in `profiles/`:

| Profile | Provider | Keeps | Maps as | Recursion |
| ------- | -------- | ----- | ------- | --------- |
| `openai` | OpenAI structured outputs, `strict: true` | `const`, `pattern`, `format` (date-time, date, uuid), `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems` | entries | yes, but see `maxDepth` below |
| `anthropic` | Anthropic structured outputs | `const`, `format` (date-time, date, uuid), `minItems` up to 1 | entries | no |
| `gemini` | Gemini API structured output with a JSON Schema | `format` (date-time, date), `minimum`, `maximum`, `minItems`, `maxItems` | object | no |

Each profile notes its sources, the day its rules were checked and a version. Where a provider's documentation doesn't say a keyword is supported, the profile treats it as unsupported: the keyword then moves to the decoder, which is always safe. Provider rules change, so a profile can be replaced without a new strictgen release. Copy one, change it, give it a path in `llm.profiles`, and it replaces the built in profile of its `name`:

```json
{ "llm": { "profiles": ["openai", "profiles/anthropic.json"], "out": "llm" } }
```

### What each profile keeps

The tables are made from the profile files in [`profiles/`](../profiles). A keyword the profile doesn't accept is left out of the schema, with a hint in the description, and only the decoder checks it. The one exception is a map given as entries: its `minProperties` and `maxProperties` become the array's `minItems` and `maxItems`, which a profile may accept. A profile with recursion and a `maxDepth`, like `openai`, still refuses recursive types, as [the limits](#the-projection) explain.

#### `openai`

<!-- snippet: profile openai -->
| | |
| - | - |
| Version | 1, checked 2026-11-06 |
| Keywords kept | `const`, `pattern`, `format`, `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems` |
| Not accepted | `minLength`, `maxLength`, `uniqueItems`, `minProperties`, `maxProperties`, `propertyNames` |
| `const` | kept |
| Formats | `date-time`, `date`, `uuid` |
| Keyword maximums | none |
| Maps | an array of `{ key, value }` entries |
| Recursive types | yes |
| Limits | `maxDepth` 10, `maxProperties` 5000, `maxEnumValues` 1000, `maxStringSize` 120000, `largeEnum` 250 values, 15000 characters |
| Sources | <https://developers.openai.com/api/docs/guides/structured-outputs> |
<!-- /snippet -->

#### `anthropic`

<!-- snippet: profile anthropic -->
| | |
| - | - |
| Version | 1, checked 2026-11-06 |
| Keywords kept | `const`, `format`, `minItems` |
| Not accepted | `pattern`, `minLength`, `maxLength`, `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`, `propertyNames` |
| `const` | kept |
| Formats | `date-time`, `date`, `uuid` |
| Keyword maximums | `minItems` up to 1 |
| Maps | an array of `{ key, value }` entries |
| Recursive types | no |
| Limits | `maxUnions` 16 |
| Sources | <https://platform.claude.com/docs/en/build-with-claude/structured-outputs> |
<!-- /snippet -->

#### `gemini`

<!-- snippet: profile gemini -->
| | |
| - | - |
| Version | 1, checked 2026-11-06 |
| Keywords kept | `format`, `minimum`, `maximum`, `minItems`, `maxItems` |
| Not accepted | `pattern`, `minLength`, `maxLength`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `uniqueItems`, `minProperties`, `maxProperties`, `propertyNames`, `format: uuid` |
| `const` | written as an `enum` of one value |
| Formats | `date-time`, `date` |
| Keyword maximums | none |
| Maps | an object |
| Recursive types | no |
| Limits | none |
| Sources | <https://ai.google.dev/gemini-api/docs/structured-output> |
<!-- /snippet -->

### Updating or overriding a profile

Provider rules change, and a profile is data, so a change doesn't need a new strictgen release:

1. Copy the built in file, like [`profiles/anthropic.json`](../profiles/anthropic.json), into your project
2. Change what the provider changed: `keywords`, `formats`, `keywordMaximums`, `maps`, `recursion` or `limits`. Set `date` to the day you checked, raise `version`, and add the page you checked to `sources`
3. List the file's path in `llm.profiles`, in place of the name. A file whose `name` is a built in one replaces that profile, so `strictgen llm --profile anthropic` reads your file
4. Run `strictgen generate`. A file that breaks [`profiles/profile.schema.json`](../profiles/profile.schema.json) fails with exit code 2, naming the file and the field

A new provider works the same way, with a `name` of its own. When a built in profile changes in strictgen itself, that is a minor version, and `strictgen check` shows the schemas it changes.

| Field | Means |
| ----- | ----- |
| `name`, `version`, `date`, `description`, `sources` | Which provider, which version of the data, the day it was checked, and where each rule comes from |
| `keywords` | The optional keywords the provider accepts. Every other constraint is left out and hinted at |
| `formats` | The formats it accepts, when it accepts `format` |
| `keywordMaximums` | A keyword it accepts only up to a value, like `{ "minItems": 1 }` |
| `maps` | `entries` or `object`, see below |
| `recursion` | Whether it accepts a type that contains itself |
| `limits` | `maxDepth`, `maxProperties`, `maxEnumValues`, `maxStringSize`, `maxUnions` and `largeEnum`. Each one is optional |

A profile file that breaks a rule of the profile schema fails with exit code 2, naming the file and the field.

## The projection

The real schema stays the source. A projection is generated from it, never edited by hand:

- **Every object is closed** with `"additionalProperties": false`, and lists every property in `required`.
- **An optional field becomes required and nullable**: `"anyOf": [<type>, { "type": "null" }]`. The model sends `null` for a field it leaves out, and the decoder reads `null` as absent. For a union, `null` is one more branch.
- **A tagged union becomes `anyOf`** of its branches, each with its tag as a `const`, or as a one value `enum` for a profile without `const`. An untagged union becomes `anyOf` of its variants.
- **A type that isn't an object at the root**, like an enum or a union, is wrapped as `{ "value": <type> }`, since providers want an object there. The decoder reads the `value` key.
- **A map** becomes, with `entries`, an array of `{ "key": ..., "value": ... }` objects. Its `minProperties` and `maxProperties` become the array's `minItems` and `maxItems`, and the changes list them by those names, but they count keys: a key given twice fails in the decoder, so entries and keys are the same number. With `object`, it stays an object with an `additionalProperties` schema.
- **A constraint the profile doesn't accept** is left out, and a short hint goes into the description instead, so the model still tries to follow it: `"A note for the packer. At most 80 characters."`. The decoder checks it.
- **Every type is inlined**, so a description never sits beside a `$ref`. Only a type that contains itself goes to `$defs`, for a profile with `recursion`. For one without, it fails with `llm-unsupported`. Where such a type is used, its `$defs` entry keeps the type's own description. The description of the field that uses it, with its hints, is kept for an optional field, on the `anyOf` that makes it nullable, and is left out everywhere else, like on a required field, since it would have to sit beside the `$ref`.
- **Field and type descriptions** are kept. A field's own description replaces the description of the type it refers to.

Hints are fixed sentences, the same on every run: `at least 2 characters`, `at most 5 items`, `greater than 0`, `a multiple of 6`, `matching the regular expression ^[A-Z]{3}$`, `an RFC 3339 date, like 2026-01-31`, `no two items equal`, `each key at most once`.

Limits are counted the way the provider meets the schema: each `$ref` is followed to its `$defs` entry where it is used, so a definition counts at the depth of each use, and its properties, enum values and `anyOf` schemas count once per use. A `$defs` name counts once.

Some schemas can't be projected. A value of any type (`{}`) and named keys beside a map of the other keys fail with `llm-unsupported`, naming the schema path. A projection over a profile limit fails with `llm-limit`:

```
order.json#: llm-limit: the openai schema for Order has a nesting depth of 11, at /properties/a/.../items, and the profile allows at most 10
```

| Limit | Counts |
| ----- | ------ |
| `maxDepth` | Object and array schemas nested on one path, the root counting as 1. A type that contains itself nests without bound, and providers don't say how they count it, so with a `maxDepth` it fails with `llm-limit`. The built in `openai` profile has one, so it refuses recursive types. A profile file without `maxDepth` takes them, if the provider does |
| `maxProperties` | Properties of every object in the schema, `$defs` included |
| `maxEnumValues` | Values of every `enum` |
| `maxStringSize` | Characters of every property name, `$defs` name, string enum value and string const |
| `maxUnions` | `anyOf` schemas, each nullable field counting as one |
| `largeEnum` | An enum with more than `values` string values may have at most `maxSize` characters of them |

### What moved to the decoder

`strictgen llm` lists every change with its JSON Pointer in the projected schema:

```
Moved to the decoder:
  /properties/note: optional, so required and nullable: null stands for absent
  /properties/note/anyOf/0: maxLength 80: at most 80 characters
  /properties/payment: a tagged union on "method", as anyOf of its 2 branches
```

With `--json`, each change has a `kind` (`nullable`, `dropped`, `entries`, `wrapped` or `union`), the `pointer`, the model `type` and `field` it belongs to, and for `dropped` the `keyword` and `value`, for `union` the `tag` and the type each tag value decodes as.

## Decoders

With `llm`, every configured language also gets an LLM decoder for every type with a schema, a schema root or a `$defs` entry. It reads the JSON text a model sent for one of the type's provider-ready schemas, undoes the projection, and then checks every constraint of the real type, the ones the schema kept and the ones it left out:

| Language | Function |
| -------- | -------- |
| TypeScript | `decodeXFromLlm(text: string): X`, which throws a `DecodeError`, and `tryDecodeXFromLlm(text)`, which returns it |
| Go | `DecodeXFromLlm(data []byte) (X, error)`, whose error is a `*DecodeError` |
| Rust | `decode_x_from_llm(text: &str) -> Result<X, DecodeError>`, a function of the generated module, like `decode_order_request_from_llm`. A function rather than a method, so an alias like `pub type Tags = Vec<String>` has one too |

```ts
const order = decodeOrderRequestFromLlm(reply); // reply: the model's text
```

Undoing the projection:

- **`null` stands for absent** for an optional field, so the decoded value has no such field. For an optional union, `null` is the extra branch, and the same rule applies. `null` anywhere else, like for a required field, fails as in the normal decoders.
- **A type that isn't an object** is read from the `value` key of the object around it, which must have exactly that key.
- **A map** is read in the shapes the configured profiles give: an array of `{ "key": ..., "value": ... }` entries when a profile uses `entries`, a JSON object when one uses `object`. With profiles of both kinds, as with `openai` and `gemini`, the decoder takes either, told apart by the JSON type, so one decoder serves every profile. Each entry is an object with exactly those two keys. A key given twice fails with `duplicate_key` at the later entry's key, like `/labels/3/key`, and `minProperties` and `maxProperties` count the keys.
- **A tagged union** keeps its JSON shape in the projection, so its tag picks the branch as in the normal decoders.

A value decoded through the LLM path equals the same value decoded normally from its JSON. The decoders reuse the normal ones, so every other rule, like the order in which an untagged union tries its variants, is the same.

An untagged union with a map beside an array, like `oneOf: [array, map]`, fails with `llm-unsupported` for a profile that gives maps as entries: both are JSON arrays then, and the decoder could read an empty map as an empty array. Give the branches a tag, or use a profile that keeps maps as objects.

### Errors

Errors have the shared shape and codes of [error-codes.md](error-codes.md), and the compact form, like `/lines/0/quantity not_multiple_of, expected a multiple of 2, found 3`, is made for sending back to the model so it can retry. Paths are in the terms of the payload the model sent, since that is the text it has to fix: `/value/...` for a wrapped type, and for a map read from entries the entry's index, then `key` for an error of the key itself, like a key that breaks `propertyNames`, or `value` for an error of its value. The order is that of the normal decoders: the first structure error anywhere, else the first constraint the value breaks, with the keys of a map checked in code point order, each key before its value.

```
/labels/1/key too_long, expected at most 12 characters, found 16 characters
/value/1/key duplicate_key, found "AB-1234"
/customer/name null_not_allowed, expected a string
```

### Strict in every read mode

A provider-ready schema closes every object, so an LLM decoder fails on an unknown key with `unknown_key`, whatever `read` the target has. In report mode the normal decoders still accept unknown keys, and the hook is never called by an LLM decoder.

### Cleanup

With `llm.cleanup`, each LLM decoder runs the cleanup step below on the text first. The normal decoders never run it. Go's decoder doesn't change the slice it is given.

### Shared vectors

`examples/llm/llm-vectors.json` holds more than a thousand payloads in the LLM form, each with the normal JSON of its value or the compact error it must give. The Rust, Go and TypeScript tests run them all and must agree. They come from the payload generator: valid values projected into each map shape, the generator's near misses projected with their paths moved to the payload, and near misses of what only the LLM form has, like the object around a wrapped type and the entries of maps. `pnpm vectors:llm` writes the file again after the example changes, and the TypeScript tests fail while it is out of date.

When the TypeScript target has `"decoders": false`, it has no decoders at all, so no LLM decoders either.

## Cleanup

Models often wrap JSON in a code fence, start it with a byte order mark or leave a trailing comma. The cleanup step fixes only these, before an LLM decoder reads the text. It never renames a key, guesses a value or fixes anything else, so text it can't fix stays as it is and fails to decode.

With `llm.cleanup`, each language gets one function:

| Language | Function |
| -------- | -------- |
| TypeScript | `cleanLlmJson(text: string): string`, exported from `index.ts` |
| Go | `CleanLLMJSON(data []byte) []byte`, which returns a new slice |
| Rust | `clean_llm_json(text: &str) -> String`, exported from the generated module |

All three run the same steps, in order. JSON white space means space (U+0020), tab (U+0009), line feed (U+000A) and carriage return (U+000D), and nothing else: a no-break space or a vertical tab is not white space.

1. **Byte order mark.** When the text starts with U+FEFF (the bytes `EF BB BF`), remove it. Only one, and only at the very start.
2. **Trim.** Remove JSON white space at the start and at the end.
3. **Code fence.** When all of these hold, keep only what is between the fence lines, and trim it again as in step 2:
   - the text starts with three backticks, followed up to the first line feed by an info string of only ASCII letters, digits and `_`, `+`, `.`, `-` (like `json`, or nothing), then only spaces, tabs or a carriage return
   - the text ends with three backticks
   - before those, on the same line, there are only spaces and tabs, and the line before ends with a line feed, or nothing is left between the fence lines

   Otherwise the text stays as it is: a fence on one line, one without a closing line, text before or after the fence, or four backticks. Only one fence is removed.
4. **Trailing commas.** Read the text from the start. A `"` starts a string and the next `"` that isn't escaped ends it; inside a string, a backslash and the character after it are skipped. Outside strings, remove each comma that is followed, after JSON white space only, by `}` or `]`. The white space stays. Of `[1,,]`, only the second comma goes, so the text still fails to decode.

Every character the steps look at or remove is ASCII, but the byte order mark, so the steps give the same result on UTF-8 bytes (Rust and Go) and on UTF-16 code units (TypeScript). `examples/llm/cleanup-vectors.json` holds the inputs and outputs every language is tested on, written by `scripts/cleanup-vectors.mjs`.
