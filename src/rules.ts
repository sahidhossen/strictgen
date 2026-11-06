/**
 * Every rule a generation error can name. An error reads
 * `user.json#/$defs/address: open-object: <reason>. Hint: <fix>`, where the rule id is stable
 * across releases, so scripts and docs can rely on it. Each id maps to a one line summary.
 */
export const RULES = {
  "read-failed": "a schema file or the schemas folder can't be read",
  "invalid-json": "a schema file is not valid JSON",
  "invalid-schema": "a value is not what JSON Schema expects there, like a non-string $ref",
  "schema-id": "a schema's $id must be <idBase><file>.json",
  "missing-title": "a schema with a root type needs a title to name it",
  "unresolved-ref": "a $ref names a schema or def that isn't in the schema set",
  "ref-form": "a $ref must name a schema file or one of its $defs entries",
  "ref-cycle": "a $ref chain loops or is too deep",
  "ref-siblings": "keywords beside $ref may only forbid a key with false",
  "unsupported-keyword": "the keyword is outside the supported subset",
  "misplaced-keyword": "the keyword is supported, but not in this position",
  "unsupported-type": "type must be one of object, array, string, integer, number or boolean",
  "unsupported-format": "only the date-time and date formats are supported",
  "unsupported-constraint":
    "the constraint can't be checked the same way in every language, or isn't checked yet",
  "invalid-constraint": "a constraint's value is out of range, or its limits can't both hold",
  "unsupported-not": "not may only exclude null, or a pattern or values beside a string type",
  "unsupported-const": "a const must be a string, an integer or a boolean, matching its type",
  "unsupported-enum": "enum values must be unique strings",
  "missing-type": "a schema needs a type, $ref, const, enum or oneOf",
  "type-mismatch": "the schema's type doesn't fit where it is used",
  "missing-items": "an array needs an items schema",
  "map-values": "a map needs an additionalProperties schema for its values",
  "unsupported-map-key": "map keys must be strings or a string enum",
  "open-object": "objects must be closed, unless they are only an allOf base",
  "closed-with-allof": "beside allOf, close an object with unevaluatedProperties false",
  "undeclared-key": "a key is used, required or named in a branch without a property schema",
  "property-redeclared": "a property is declared twice with different schemas",
  "unsupported-branch": "a branch of oneOf, anyOf or propertyNames has an unsupported shape",
  "union-tag": "a oneOf tag must be a required string const on every branch, with distinct values",
  "untagged-union": "two branches of a oneOf without a shared tag map to the same variant",
  "alias-cycle": "a type can't contain itself through aliases only",
  "name-clash": "two schema items map to the same name in the generated code",
  "reserved-name": "a name is a keyword or a name the generated code uses itself",
  "unsupported-name": "a name can't be turned into a valid identifier",
  "output-conflict": "writing the output would clear or replace files strictgen doesn't own",
  "write-failed": "the output can't be written",
  internal: "a generator bug, not a schema problem",
} as const satisfies Record<string, string>;

/** A stable rule id, like `open-object`. */
export type RuleId = keyof typeof RULES;

/** Every rule id, sorted. */
export const RULE_IDS: readonly RuleId[] = (Object.keys(RULES) as RuleId[]).sort();

/** True for a known rule id. */
export function isRuleId(value: string): value is RuleId {
  return Object.hasOwn(RULES, value);
}
