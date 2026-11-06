/**
 * The intermediate model every emitter reads. The builder turns the schemas
 * into named declarations, hoisting inline objects, enums and unions so every
 * language gets a name for them. Emitters never look at the schemas.
 */

/**
 * A type used by a field, an alias, a map or an array. Compound types are always a `ref`.
 *
 * Strings, integers, numbers, arrays and maps carry the constraints their schema gives them,
 * which decoders check once the structure of the whole value has decoded, in the order
 * src/checks.ts defines. A constraint is absent when the schema doesn't set it, or when the
 * config turns validation off.
 */
export type TypeExpr =
  | { readonly kind: "ref"; readonly name: string }
  | StringType
  | IntegerType
  | NumberType
  | { readonly kind: "boolean" }
  /** An integer or boolean `const`, like `schemaVersion`. */
  | { readonly kind: "literal"; readonly value: number | boolean }
  /** Any JSON value, including `null` (`anyValue`). */
  | { readonly kind: "any" }
  /** Any JSON value except `null` at the top (`jsonValue`, `nonNullValue`). */
  | { readonly kind: "nonNull" }
  | ArrayType
  | MapType;

/** A string. Its length limits count Unicode code points. */
export interface StringType {
  readonly kind: "string";
  /**
   * The schema's `pattern`, as written. TypeScript types a fixed prefix or suffix family by it,
   * like `order.${string}`. Kept when validation is off.
   */
  readonly pattern?: string;
  /** The pattern every decoder checks. Absent when the schema has none or validation is off. */
  readonly match?: Pattern;
  /** The schema's `format`, which every decoder checks. Absent when validation is off. */
  readonly format?: Format;
  readonly minLength?: number;
  readonly maxLength?: number;
}

/** A pattern to check: as the schema writes it, and in the portable form src/pattern.ts gives. */
export interface Pattern {
  /** The pattern as written, which errors show. */
  readonly source: string;
  /** The portable form, which Rust's regex, Go's RE2 and ECMAScript read the same way. */
  readonly regex: string;
}

/** The formats every decoder checks, each by one grammar docs/error-codes.md writes out. */
export type Format = "date-time" | "date" | "uuid";

/** The bounds of an integer or a number, each inclusive or exclusive. */
export interface Bounds {
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
}

/** An integer. Its bounds and `multipleOf` are safe integers, which every language holds exactly. */
export interface IntegerType extends Bounds {
  readonly kind: "integer";
  /** A positive safe integer. */
  readonly multipleOf?: number;
}

/** A number. A value and a bound compare as the nearest 64-bit floats in every language. */
export interface NumberType extends Bounds {
  readonly kind: "number";
}

/** An array, with limits on its number of items, and whether they must be unique. */
export interface ArrayType {
  readonly kind: "array";
  readonly items: TypeExpr;
  readonly minItems?: number;
  readonly maxItems?: number;
  /** No two items are equal, comparing their RFC 8785 canonical JSON. Absent when false. */
  readonly uniqueItems?: true;
}

/** A JSON object used as a map, with limits on its number of keys. */
export interface MapType {
  readonly kind: "map";
  readonly key: TypeExpr;
  readonly value: TypeExpr;
  readonly minProperties?: number;
  readonly maxProperties?: number;
}

/** One property of a struct. */
export interface Field {
  /** The JSON property name. */
  readonly name: string;
  readonly doc: string;
  readonly type: TypeExpr;
  readonly required: boolean;
  /** Set by the boxing pass when the field closes a containment cycle. */
  boxed: boolean;
}

/** Extra keys of a struct that are data, like the currency keys beside `default` in a price list's `prices`. */
export interface Rest {
  readonly key: TypeExpr;
  readonly value: TypeExpr;
}

/** Where a declaration comes from: a schema root (`def` undefined) or a `$defs` entry. Absent for hoisted types. */
export interface Source {
  readonly schema: string;
  readonly def: string | undefined;
}

interface DeclBase {
  readonly name: string;
  readonly doc: string;
  /** Schema path, for messages. */
  readonly path: string;
  /**
   * Name of the schema file the type belongs to, like `order` or `user-profile`.
   * Hoisted types belong to the file of the root or def that owns them. Emitters
   * write one file or module per schema.
   */
  readonly schema: string;
  readonly source: Source | undefined;
}

/** An object with named properties. */
export interface StructDecl extends DeclBase {
  readonly kind: "struct";
  readonly fields: readonly Field[];
  /** Unknown keys are rejected (`unevaluatedProperties: false`). */
  readonly closed: boolean;
  /** Keys that must be absent, from a sibling branch of an exactly-one `oneOf`. */
  readonly forbidden: readonly string[];
  readonly rest: Rest | undefined;
}

/** A set of strings. A string `const` is an enum with one value. */
export interface EnumDecl extends DeclBase {
  readonly kind: "enum";
  readonly values: readonly string[];
}

/** One branch of a tagged union. */
export interface TaggedVariant {
  readonly value: string;
  /** Name of the branch struct, which keeps its tag field. */
  readonly type: string;
  boxed: boolean;
}

/** A `oneOf` whose branches share a string `const` tag. Decoders read the tag and decode that branch only. */
export interface TaggedDecl extends DeclBase {
  readonly kind: "tagged";
  readonly tag: string;
  readonly variants: readonly TaggedVariant[];
}

/** One branch of an untagged union. */
export interface UntaggedVariant {
  /** A variant name, unique in the union. */
  readonly name: string;
  readonly type: TypeExpr;
  boxed: boolean;
}

/** A `oneOf` without a shared tag. Decoders try the variants in this order. */
export interface UntaggedDecl extends DeclBase {
  readonly kind: "untagged";
  readonly variants: readonly UntaggedVariant[];
}

/** A def that is only another type: a `$ref`, a primitive with rules, an array or a map. */
export interface AliasDecl extends DeclBase {
  readonly kind: "alias";
  readonly type: TypeExpr;
}

/**
 * An id, like `orderId`: a string that languages with nominal types wrap in a
 * type of its own (a Rust newtype), so ids of different kinds don't mix.
 */
export interface IdDecl extends DeclBase {
  readonly kind: "id";
  /** The string, with the constraints of the id's schema. */
  readonly type: StringType;
}

export type Decl = StructDecl | EnumDecl | TaggedDecl | UntaggedDecl | AliasDecl | IdDecl;

/** The whole model, declarations sorted by name. */
export interface Model {
  readonly decls: readonly Decl[];
}
