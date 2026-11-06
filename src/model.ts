/**
 * The intermediate model every emitter reads. The builder turns the schemas
 * into named declarations, hoisting inline objects, enums and unions so every
 * language gets a name for them. Emitters never look at the schemas.
 */

/** A type used by a field, an alias, a map or an array. Compound types are always a `ref`. */
export type TypeExpr =
  | { readonly kind: "ref"; readonly name: string }
  /**
   * A string. `pattern` is the schema's `pattern` when it has one, which no decoder checks yet.
   * TypeScript types a fixed prefix or suffix family by it, like `order.${string}`.
   */
  | { readonly kind: "string"; readonly pattern?: string }
  | { readonly kind: "integer" }
  | { readonly kind: "number" }
  | { readonly kind: "boolean" }
  /** An integer or boolean `const`, like `schemaVersion`. */
  | { readonly kind: "literal"; readonly value: number | boolean }
  /** Any JSON value, including `null` (`anyValue`). */
  | { readonly kind: "any" }
  /** Any JSON value except `null` at the top (`jsonValue`, `nonNullValue`). */
  | { readonly kind: "nonNull" }
  | { readonly kind: "array"; readonly items: TypeExpr }
  | { readonly kind: "map"; readonly key: TypeExpr; readonly value: TypeExpr };

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
}

export type Decl = StructDecl | EnumDecl | TaggedDecl | UntaggedDecl | AliasDecl | IdDecl;

/** The whole model, declarations sorted by name. */
export interface Model {
  readonly decls: readonly Decl[];
}
