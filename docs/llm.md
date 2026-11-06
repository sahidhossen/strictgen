# LLM structured output

LLM providers take a JSON Schema for structured output, but only a subset of it, and each provider has its own subset and limits. strictgen projects every type into a schema one provider accepts, from the real schema, and lists what the projection had to leave out, so a decoder can check it instead. It also has a cleanup step for the syntax mistakes models often make in JSON.

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
| `llm.cleanup` | Adds the cleanup helper to every configured language. Off by default |

`strictgen generate` writes the schemas with the other targets and `strictgen check` compares them. `strictgen llm --profile openai Order` prints one schema on stdout and what moved to the decoder on stderr, or both as JSON with `--json`. The type is named as the generated code names it, and every schema root and `$defs` entry has one.

## Profiles

A profile is a JSON file that `profiles/profile.schema.json` describes. strictgen ships three, in `profiles/`:

| Profile | Provider | Keeps | Maps as | Recursion |
| ------- | -------- | ----- | ------- | --------- |
| `openai` | OpenAI structured outputs, `strict: true` | `const`, `pattern`, `format` (date-time, date, uuid), `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems` | entries | yes |
| `anthropic` | Anthropic structured outputs | `const`, `format` (date-time, date, uuid), `minItems` up to 1 | entries | no |
| `gemini` | Gemini API structured output with a JSON Schema | `format` (date-time, date), `minimum`, `maximum`, `minItems`, `maxItems` | object | no |

Each profile notes its sources, the day its rules were checked and a version. Where a provider's documentation doesn't say a keyword is supported, the profile treats it as unsupported: the keyword then moves to the decoder, which is always safe. Provider rules change, so a profile can be replaced without a new strictgen release. Copy one, change it, give it a path in `llm.profiles`, and it replaces the built in profile of its `name`:

```json
{ "llm": { "profiles": ["openai", "profiles/anthropic.json"], "out": "llm" } }
```

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
- **A map** becomes, with `entries`, an array of `{ "key": ..., "value": ... }` objects, its key limits as item limits. A key given twice fails in the decoder. With `object`, it stays an object with an `additionalProperties` schema.
- **A constraint the profile doesn't accept** is left out, and a short hint goes into the description instead, so the model still tries to follow it: `"A note for the packer. At most 80 characters."`. The decoder checks it.
- **Every type is inlined**, so a description never sits beside a `$ref`. Only a type that contains itself goes to `$defs`, for a profile with `recursion`. For one without, it fails with `llm-unsupported`.
- **Field and type descriptions** are kept. A field's own description replaces the description of the type it refers to.

Hints are fixed sentences, the same on every run: `at least 2 characters`, `at most 5 items`, `greater than 0`, `a multiple of 6`, `matching the regular expression ^[A-Z]{3}$`, `an RFC 3339 date, like 2026-01-31`, `no two items equal`, `each key at most once`.

Some schemas can't be projected. A value of any type (`{}`) and named keys beside a map of the other keys fail with `llm-unsupported`, naming the schema path. A projection over a profile limit fails with `llm-limit`:

```
order.json#: llm-limit: the openai schema for Order has a nesting depth of 11, at /properties/a/.../items, and the profile allows at most 10
```

| Limit | Counts |
| ----- | ------ |
| `maxDepth` | Object and array schemas nested on one path, the root counting as 1 |
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
