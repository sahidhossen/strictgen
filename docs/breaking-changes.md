# Breaking changes

Most incidents come from a producer changing a schema and a consumer not noticing. `strictgen breaking` compares the current schemas with an older version and lists each change with who it breaks:

```sh
strictgen breaking --base main            # a git ref
strictgen breaking --base v1.4.0 --json   # a tag, as JSON for CI
strictgen breaking --base ../old-schemas  # a folder
```

It exits 1 when any change breaks someone, 0 otherwise, and 2 when the base can't be loaded or the arguments are wrong, like a base that is neither a folder nor a git ref, so CI can tell a breaking change from a base it couldn't read.

## Who a change breaks

A **consumer** is code generated from the base schemas that reads data written against the current ones. A **producer** is code that still writes data the base schemas allow, read by consumers generated from the current ones. During a rollout both exist at once.

| Who | Means |
| --- | ----- |
| Breaks all consumers | Data the current schemas allow can fail an old consumer, in strict and in report mode |
| Breaks strict consumers | Only old consumers that read in `strict` mode fail; `report` mode accepts the data and reports the unknown key ([read-modes.md](read-modes.md)) |
| Breaks producers | Data the base schemas allow can fail a new consumer |
| Safe | Every value one version allows, the other reads the same way |

A change can break more than one group. Adding a required field breaks strict consumers, which don't know the key, and producers, which don't send it.

## The rules

| Change | Kind | Breaks |
| ------ | ---- | ------ |
| A type (a schema root or a `$defs` entry) is added | `type-added` | nobody |
| A type is removed | `type-removed` | all consumers |
| A type changes, like string to integer or an object to a map, an integer or boolean constant changes value, or a tagged union changes its tag key | `type-changed` | all consumers, producers |
| An integer becomes a number, or a type becomes any non-null value | `type-widened` | all consumers |
| A number becomes an integer, or any value becomes a narrower type | `type-narrowed` | producers |
| A type becomes any JSON value, so `null` is allowed (making a field nullable) | `made-nullable` | all consumers |
| An optional field is added | `field-added` | strict consumers |
| A required field is added | `required-field-added` | strict consumers, producers |
| A field is added to an object whose other keys are data (`additionalProperties` with a schema), so old consumers read it as one of them | `field-added-to-other-keys` | all consumers |
| A field is removed, or renamed (a removal and an addition). Removing an optional field mainly breaks producers that still send it to strict consumers; it is listed as breaking all consumers on purpose, over-reported rather than missed | `field-removed` | all consumers |
| A required field becomes optional | `field-made-optional` | all consumers |
| An optional field becomes required | `field-made-required` | producers |
| An object starts accepting other keys | `other-keys-allowed` | strict consumers |
| An object stops accepting other keys | `other-keys-removed` | producers |
| A key a sibling branch of an exactly-one choice names becomes forbidden | `key-forbidden` | producers |
| Such a key is no longer forbidden | `key-allowed` | all consumers |
| An enum value is added (a string constant is an enum of one value) | `enum-value-added` | all consumers |
| An enum value is removed | `enum-value-removed` | producers |
| A union branch is added | `branch-added` | all consumers |
| A union branch is removed | `branch-removed` | producers |
| The branches of an untagged union are tried in a new order | `branch-order-changed` | all consumers |
| A constraint is tightened | `constraint-tightened` | producers |
| A constraint is loosened | `constraint-loosened` | all consumers |
| A constraint changes in a way that is neither tighter nor looser | `constraint-changed` | all consumers, producers |

When every target in the config reads in `report` mode, no consumer is strict, so a change that only breaks strict consumers, like an added optional field, is safe. One target in `strict` mode, or a config whose targets don't all set `"read": "report"`, keeps those changes breaking.

### Constraints

A tighter constraint allows fewer values: data an old producer writes can fail a new consumer. A looser one allows more: data a new producer writes can fail an old consumer. Adding a constraint tightens it and removing one loosens it.

| Keyword | Tighter when | Looser when |
| ------- | ------------ | ----------- |
| `minLength`, `minItems`, `minProperties` | it goes up | it goes down |
| `maxLength`, `maxItems`, `maxProperties` | it goes down | it goes up |
| `minimum`, `exclusiveMinimum` | the lower bound goes up, or the same bound becomes exclusive | the lower bound goes down, or becomes inclusive |
| `maximum`, `exclusiveMaximum` | the upper bound goes down, or the same bound becomes exclusive | the upper bound goes up, or becomes inclusive |
| `multipleOf` | the new value is a multiple of the old one (2 to 4) | the old value is a multiple of the new one (4 to 2) |
| `uniqueItems` | it is added | it is removed |
| `pattern` | it is added | it is removed |
| `format` | it is added | it is removed |

Both bounds of a side are read together, so `minimum: 0` to `exclusiveMinimum: 0` is tighter. For integers an exclusive bound is the next whole number, so `exclusiveMinimum: 4` and `minimum: 5` are the same. A `multipleOf` that changes from 2 to 3 is neither, and so is a `format` that changes from `date` to `date-time`: both are `constraint-changed`.

Two different patterns can't be compared in general, so any change to a `pattern` is `constraint-changed` and breaks both sides. This is fail-closed on purpose: a pattern that only got looser still shows. Patterns compare by their portable form, so writing the same pattern another way that strictgen reads the same isn't a change.

With `"validation": false` in the config, decoders check no constraint, so constraints are not compared either.

## What counts as the same

The comparison runs on the model strictgen generates from, not on the raw schema JSON, so only changes to the JSON a type accepts show:

- Descriptions, titles and `$comment` are ignored
- Types are matched by schema location: a file's root type, or `$defs/<name>`. Inline objects, enums and unions are compared where they are, whatever name the generator gives them
- A `$ref` is followed to what it names, so moving a field's schema into a def, renaming a def a field refers to, or using an ID type instead of a string with the same constraints changes nothing at that field. The def's name itself is a type: renaming it lists the old one as removed and the new one as added
- Enum values and object fields compare as sets: a new order is no change. Untagged union branches pair up by content: unchanged branches first, then the remaining branches of each kind (object, string, array and so on) in order, when both versions have as many of that kind. Only branches that changed show, and the order decoders try them in is compared too
- A change inside a def shows once, at the def, however many fields refer to it

## Where a change is

Each change has a location in both versions, as a schema file and JSON Pointer like `order.json#/properties/total`. For something added, the base location is the place that now holds it, like the object a field was added to, and for something removed the current location is that place. A location is only missing (`null`) when its whole schema file is missing from that version.

A field's location is under its object's `properties`, an array's items under `items`, and a map's keys and values under `propertyNames` and `additionalProperties`.

## The base

`--base` names a folder when one exists at that path, relative to the current folder, and a git ref otherwise. When it is both, the folder is used and a warning says so on stderr.

- **A folder** is a project when it holds a config file with the same name as the current one (usually `strictgen.json`): its `schemas`, `idBase`, `ids` and `validation` are used. Otherwise it is a schemas folder, read with the current config's `ids` and `validation`, and with the `$id` base its own schemas share
- **A git ref**, like `main`, `HEAD~3`, a tag or a commit, is read from the repository that holds the config with `git ls-tree` and `git cat-file`. Nothing is checked out and the working tree is not touched. The config file at that ref, at the same path as the current one, gives the base's schemas folder and options, so a moved schemas folder or a changed `idBase` is followed. Without a config at that ref, the current config's schemas folder is used

A base that can't be loaded exits 2, with the base named in the message: a ref that doesn't exist (the message gives git's reason; in CI, fetch the ref first, for example with `fetch-depth: 0`), a folder outside the repository, a schemas folder missing at that ref, a base with no schema files or no types, like an empty folder or `--base docs` by mistake, and a base schema or config that can't be read or generated. Which targets read in report mode always comes from the current config.

## Output

The text form groups the changes by who they break, then the safe ones, each with its location in both versions:

```
Breaks strict consumers:
  optional field "note" added
    base:    order.json#
    current: order.json#/properties/note

Breaks producers:
  value "pending" removed
    base:    order.json#/properties/status
    current: order.json#/properties/status

2 breaking changes and 0 safe changes since main.
```

A change that breaks two groups is listed under both. `--json` prints one object, with changes sorted by current location, then base location, kind and detail, so the output is the same on every run:

```json
{
  "base": "main",
  "breaking": true,
  "everyTargetReports": false,
  "changes": [
    {
      "kind": "field-added",
      "breaks": ["strict-consumers"],
      "base": "order.json#",
      "current": "order.json#/properties/note",
      "detail": "optional field \"note\" added"
    }
  ]
}
```

| Field | Is |
| ----- | -- |
| `base` | the `--base` argument |
| `breaking` | true when any change breaks someone, which is when the command exits 1 |
| `everyTargetReports` | true when every configured target reads in report mode, so no change breaks strict consumers |
| `changes[].kind` | one of the kinds in the rule table |
| `changes[].breaks` | who it breaks, in the order `all-consumers`, `strict-consumers`, `producers`. Empty when it is safe |
| `changes[].base`, `changes[].current` | its location in each version, or `null` when that version has no such schema file |
| `changes[].detail` | what changed, in words. For people: match on `kind`, not on this text |
