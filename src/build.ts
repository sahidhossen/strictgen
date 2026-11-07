import type {
  Decl,
  Field,
  Format,
  IntegerType,
  Model,
  NumberType,
  Pattern,
  Rest,
  Source,
  StringType,
  StructDecl,
  TaggedVariant,
  TypeExpr,
  UntaggedVariant,
} from "./model.js";
import { compare } from "./common.js";
import { pascal, RENAME_TYPE } from "./naming.js";
import { PatternError, portablePattern } from "./pattern.js";
import type { DefKey, Json, JsonObject, Loc, SchemaSet } from "./schema.js";
import {
  at,
  CodegenError,
  defNames,
  fail,
  isDefsOnly,
  isObject,
  keyLoc,
  keyString,
  resolveRef,
  schemaAt,
  where,
} from "./schema.js";

/** Keywords that only document a schema. */
export const ANNOTATIONS = new Set(["description", "$comment", "title", "default", "examples"]);
/** Keywords allowed only at a schema file's root. */
const ROOT_KEYWORDS = new Set(["$schema", "$id", "$defs"]);
/** The constraint keywords each kind of value takes. src/checks.ts says how decoders check them. */
const STRING_CONSTRAINTS = ["minLength", "maxLength", "pattern"];
const NUMBER_CONSTRAINTS = [
  "minimum",
  "exclusiveMinimum",
  "maximum",
  "exclusiveMaximum",
  "multipleOf",
];
const ARRAY_CONSTRAINTS = ["minItems", "maxItems", "uniqueItems"];
const MAP_CONSTRAINTS = ["minProperties", "maxProperties"];
/** Every constraint keyword. One beside a type it doesn't apply to fails generation. */
export const CONSTRAINTS: ReadonlySet<string> = new Set([
  ...STRING_CONSTRAINTS,
  ...NUMBER_CONSTRAINTS,
  ...ARRAY_CONSTRAINTS,
  ...MAP_CONSTRAINTS,
]);
/** The largest integer every language holds exactly, TypeScript's `Number.MAX_SAFE_INTEGER`. */
const SAFE = Number.MAX_SAFE_INTEGER;
/** Keywords that shape a type. Each is handled below, or rejected where it doesn't fit. */
const STRUCTURAL = new Set([
  "type",
  "$ref",
  "const",
  "enum",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "properties",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "format",
]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean"]);
/** The formats decoders check. They stay strings, so they re-encode byte for byte. */
const FORMATS: ReadonlySet<string> = new Set<Format>(["date-time", "date", "uuid"]);
/**
 * Keywords of a condition. No decoder checks one, so each fails generation rather than
 * being read for the type and then ignored.
 */
const CONDITIONS: ReadonlySet<string> = new Set(["if", "then", "else"]);
const CONDITION_HINT =
  'for a shape per case, use a tagged union: a "oneOf" of closed objects, each with a required const tag property and the keys of its case';
/** The hint for a type name that clashes or can't be used. */
const RENAME = RENAME_TYPE;
/** The hint for a type that contains itself through aliases. */
const CYCLE = "wrap the recursive part in an object, so a struct holds it";

/** Which defs become ID types: the defs of `<file>.json` whose names end in `suffix`. */
export interface IdRule {
  /** The schema file name, without `.json`, like `common`. */
  readonly file: string;
  /** The def name suffix, like `Id`, so `orderId` is an ID. */
  readonly suffix: string;
}

/** Options for building the model. */
export interface BuildOptions {
  /** Selects the ID defs. Left out, no def becomes an ID type. */
  readonly ids?: IdRule;
  /**
   * Puts the constraints, like `maxLength`, in the model, so decoders check them. Defaults to
   * true. When false, constraints are still read and a bad one still fails generation, but
   * the model leaves them out. A string's `pattern` stays, since it types TypeScript strings.
   */
  readonly validation?: boolean;
}

interface Ctx {
  readonly set: SchemaSet;
  readonly ids: IdRule | undefined;
  readonly validation: boolean;
  /** Type name per def key string, like `payment#cardPayment` to `CardPayment`. */
  readonly names: ReadonlyMap<string, string>;
  /** Def key strings that some allOf names as a base. */
  readonly bases: ReadonlySet<string>;
  readonly decls: Map<string, Decl>;
  /** The schema file of the root or def being declared, which owns every type hoisted meanwhile. */
  file: string;
}

interface Prop {
  readonly schema: JsonObject;
  readonly loc: Loc;
}

interface Branch {
  readonly schema: Json;
  readonly loc: Loc;
}

/**
 * Builds the model from a schema set. Throws a `CodegenError` naming the
 * schema path for any construct outside the supported schema conventions.
 */
export function buildModel(set: SchemaSet, options: BuildOptions = {}): Model {
  const ctx: Ctx = {
    set,
    ids: options.ids,
    validation: options.validation ?? true,
    names: nameDefs(set),
    bases: allOfBases(set),
    decls: new Map(),
    file: "",
  };
  for (const file of set) {
    ctx.file = file.name;
    const keys: DefKey[] = isDefsOnly(file.root) ? [] : [{ file: file.name, def: undefined }];
    for (const def of defNames(file.root)) keys.push({ file: file.name, def });
    for (const key of keys) declareDef(ctx, key);
  }
  checkAliasCycles(ctx);
  box(ctx);
  const decls = [...ctx.decls.values()].sort((a, b) => compare(a.name, b.name));
  return { decls };
}

function nameDefs(set: SchemaSet): Map<string, string> {
  const wanted = new Map<string, { key: DefKey; base: string }>();
  for (const file of set) {
    if (!isDefsOnly(file.root)) {
      const title = file.root.title;
      if (typeof title !== "string" || pascal(title) === "") {
        fail(
          { file: file.name, pointer: "/title" },
          "missing-title",
          "a typed schema needs a title to name its root type",
          'add a "title", like "title": "Order", or move the schema into $defs',
        );
      }
      wanted.set(`${file.name}#`, {
        key: { file: file.name, def: undefined },
        base: pascal(title),
      });
    }
    for (const def of defNames(file.root)) {
      wanted.set(`${file.name}#${def}`, { key: { file: file.name, def }, base: pascal(def) });
    }
  }
  const counts = new Map<string, number>();
  for (const { base } of wanted.values()) counts.set(base, (counts.get(base) ?? 0) + 1);
  const names = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const [id, { key, base }] of wanted) {
    const clash = (counts.get(base) ?? 0) > 1 && key.def !== undefined;
    const name = clash ? pascal(key.file) + base : base;
    const owner = owners.get(name);
    if (owner !== undefined)
      fail(keyLoc(key), "name-clash", `type name ${name} is also used by ${owner}`, RENAME);
    if (!/^[A-Za-z]/.test(name))
      fail(keyLoc(key), "unsupported-name", `type name ${name} must start with a letter`, RENAME);
    owners.set(name, where(keyLoc(key)));
    names.set(id, name);
  }
  return names;
}

/**
 * True for an ID def: a def of the rule's file whose name ends in its suffix, like `orderId`
 * in `common.json` for `{ file: "common", suffix: "Id" }`. Without a rule, nothing is an ID.
 * This is the one place that decides it.
 */
export function isIdDef(key: DefKey, ids: IdRule | undefined): boolean {
  return ids !== undefined && key.file === ids.file && key.def?.endsWith(ids.suffix) === true;
}

/**
 * An object that is neither closed nor a map, like `paymentBase`. It is only
 * allowed as an allOf base, so it gets no type of its own.
 */
function isOpenObject(schema: JsonObject): boolean {
  return (
    schema.type === "object" &&
    schema.unevaluatedProperties !== false &&
    schema.additionalProperties === undefined &&
    schema.propertyNames === undefined
  );
}

/** Every def an allOf names with a $ref, anywhere in the set. */
function allOfBases(set: SchemaSet): Set<string> {
  const bases = new Set<string>();
  const walk = (value: Json, loc: Loc): void => {
    if (Array.isArray(value)) {
      value.forEach((v: Json, i: number) => {
        walk(v, at(loc, i));
      });
      return;
    }
    if (!isObject(value)) return;
    const allOf = value.allOf;
    if (Array.isArray(allOf)) {
      for (const entry of allOf as readonly Json[]) {
        if (isObject(entry) && typeof entry.$ref === "string") {
          bases.add(keyString(resolveRef(set, entry.$ref, loc)));
        }
      }
    }
    for (const [key, child] of Object.entries(value)) walk(child, at(loc, key));
  };
  for (const file of set) walk(file.root, { file: file.name, pointer: "" });
  return bases;
}

function declareDef(ctx: Ctx, key: DefKey): void {
  const schema = schemaAt(ctx.set, key);
  // An open base is inlined where an allOf names it and gets no type of its own.
  if (ctx.bases.has(keyString(key)) && isOpenObject(schema)) return;
  const loc = keyLoc(key);
  const name = nameOf(ctx, key);
  const source: Source = { schema: key.file, def: key.def };
  if (typeof schema.$ref === "string") {
    const target = resolveRef(ctx.set, schema.$ref, loc);
    if (keyString(target) === keyString(key))
      fail(at(loc, "$ref"), "ref-cycle", "a def can't be a $ref to itself");
  }
  const type = typeOf(ctx, schema, loc, name, source);
  const base = { name, doc: docOf(schema), path: where(loc), schema: ctx.file, source };
  if (isIdDef(key, ctx.ids)) {
    if (type.kind !== "string") {
      return fail(
        loc,
        "type-mismatch",
        "an id must be a string",
        'give it "type": "string", or rename it so the ids suffix doesn\'t match',
      );
    }
    add(ctx, { ...base, kind: "id", type });
    return;
  }
  if (type.kind === "ref" && type.name === name) return;
  add(ctx, { ...base, kind: "alias", type });
}

function nameOf(ctx: Ctx, key: DefKey): string {
  const name = ctx.names.get(keyString(key));
  if (name === undefined) return fail(keyLoc(key), "internal", "def has no type name");
  return name;
}

function add(ctx: Ctx, decl: Decl): void {
  const other = ctx.decls.get(decl.name);
  if (other !== undefined) {
    throw new CodegenError(
      decl.path,
      "name-clash",
      `type name ${decl.name} is also used by ${other.path}`,
      RENAME,
    );
  }
  ctx.decls.set(decl.name, decl);
}

/** Reserves `name`, builds its declaration and returns a ref to it. */
function hoist(ctx: Ctx, name: string, loc: Loc, build: () => Decl): TypeExpr {
  const other = ctx.decls.get(name);
  if (other !== undefined)
    fail(loc, "name-clash", `type name ${name} is also used by ${other.path}`, RENAME);
  add(ctx, build());
  return { kind: "ref", name };
}

function docOf(schema: Json | undefined): string {
  return isObject(schema) && typeof schema.description === "string" ? schema.description : "";
}

function schemaObject(value: Json | undefined, loc: Loc): JsonObject {
  if (!isObject(value)) return fail(loc, "invalid-schema", "expected a schema object");
  return value;
}

function checkKeywords(schema: JsonObject, loc: Loc, root: boolean): void {
  for (const key of Object.keys(schema)) {
    if (CONDITIONS.has(key)) noCondition(loc, key);
    const known =
      ANNOTATIONS.has(key) ||
      CONSTRAINTS.has(key) ||
      STRUCTURAL.has(key) ||
      (root && ROOT_KEYWORDS.has(key));
    if (!known) {
      fail(
        at(loc, key),
        "unsupported-keyword",
        `unsupported keyword ${key}`,
        ROOT_KEYWORDS.has(key)
          ? `${key} is only allowed at the root of a schema file`
          : 'remove it, or keep the note in "description" or "$comment"',
      );
    }
  }
  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    fail(
      at(loc, "type"),
      "unsupported-type",
      "type must be one of object, array, string, integer, number or boolean",
      Array.isArray(type) && type.includes("null")
        ? "use one type and make the key optional instead of allowing null"
        : "use one of those types, or oneOf for a choice between them",
    );
  }
}

function noCondition(loc: Loc, key: string): never {
  return fail(
    at(loc, key),
    "unsupported-keyword",
    `unsupported keyword ${key}: no decoder checks if, then or else`,
    CONDITION_HINT,
  );
}

function structural(schema: JsonObject): string[] {
  return Object.keys(schema).filter((k) => STRUCTURAL.has(k));
}

/** Hints for a supported keyword in a place it doesn't fit. */
const MISPLACED_HINTS: Readonly<Record<string, string>> = {
  anyOf: 'anyOf is only read inside "propertyNames"; for a choice between types, use "oneOf"',
};

/**
 * Fails on a structural keyword outside `allowed`, and on any condition keyword, so every
 * place that limits its keywords rejects if, then and else whether or not it checked keywords.
 */
function only(
  schema: JsonObject,
  loc: Loc,
  allowed: readonly string[],
  hint: (key: string) => string | undefined = (key) => MISPLACED_HINTS[key],
): void {
  for (const key of Object.keys(schema)) if (CONDITIONS.has(key)) noCondition(loc, key);
  for (const key of structural(schema)) {
    if (!allowed.includes(key))
      fail(at(loc, key), "misplaced-keyword", `${key} is not supported here`, hint(key));
  }
}

function typeOf(
  ctx: Ctx,
  value: Json | undefined,
  loc: Loc,
  name: string,
  source?: Source,
): TypeExpr {
  const schema = schemaObject(value, loc);
  checkKeywords(schema, loc, source !== undefined && source.def === undefined);
  if (schema.$ref !== undefined) {
    noConstraints(schema, loc, "beside $ref", "put it on the def the $ref names");
    return refType(ctx, schema, loc);
  }
  const keys = structural(schema);
  if (keys.length === 0) {
    noConstraints(schema, loc, "without a type", 'add a "type", like "type": "string"');
    return { kind: "any" };
  }
  if (schema.not !== undefined && keys.length === 1) {
    if (isObject(schema.not)) checkKeywords(schema.not, at(loc, "not"), false);
    if (isNullConst(schema.not)) {
      noConstraints(schema, loc, "without a type", 'add a "type", like "type": "string"');
      return { kind: "nonNull" };
    }
    return fail(
      at(loc, "not"),
      "unsupported-not",
      'a schema with only not must be { "not": { "const": null } }',
    );
  }
  if (schema.const !== undefined) {
    noConstraints(schema, loc, "beside const", "remove it, the const is the only value");
    return constType(ctx, schema, loc, name, source);
  }
  if (schema.enum !== undefined) {
    noConstraints(schema, loc, "beside enum", "remove it, the enum lists every value");
    return enumType(ctx, schema, loc, name, source);
  }
  if (schema.oneOf !== undefined && schema.type === undefined) {
    noConstraints(schema, loc, "beside oneOf", "put it on the branches it applies to");
    only(schema, loc, ["oneOf"]);
    const branches = arrayAt(schema.oneOf, at(loc, "oneOf")).map((b, i) => ({
      schema: b,
      loc: at(loc, "oneOf", i),
    }));
    return hoist(ctx, name, loc, () => unionDecl(ctx, name, branches, loc, docOf(schema), source));
  }
  if (schema.anyOf !== undefined && schema.type === undefined) {
    fail(at(loc, "anyOf"), "misplaced-keyword", "anyOf is not supported here", MISPLACED_HINTS.anyOf);
  }
  switch (schema.type) {
    case "string":
      if (schema.not !== undefined) {
        fail(
          at(loc, "not"),
          "unsupported-not",
          "not beside a string type is not checked",
          'use "pattern" for the strings that are allowed, or an "enum" of them',
        );
      }
      only(schema, loc, ["type", "format"]);
      return stringType(ctx, schema, loc);
    case "integer":
    case "number":
      only(schema, loc, ["type"]);
      return numberType(ctx, schema, loc, schema.type);
    case "boolean":
      only(schema, loc, ["type"]);
      noConstraints(schema, loc, "to a boolean");
      return { kind: schema.type };
    case "array":
      return arrayType(ctx, schema, loc, name);
    case "object":
      return objectType(ctx, schema, loc, name, source);
    default:
      return fail(
        loc,
        "missing-type",
        "schema has no type, $ref, const, enum or oneOf",
        'add a "type", like "type": "object"',
      );
  }
}

function arrayAt(value: Json | undefined, loc: Loc): readonly Json[] {
  if (!Array.isArray(value) || value.length === 0)
    return fail(loc, "invalid-schema", "expected a non-empty array");
  return value as readonly Json[];
}

function isNullConst(value: Json | undefined): boolean {
  return (
    isObject(value) &&
    value.const === null &&
    Object.keys(value).every((key) => key === "const" || ANNOTATIONS.has(key))
  );
}

function refType(ctx: Ctx, schema: JsonObject, loc: Loc): TypeExpr {
  only(schema, loc, ["$ref", "type", "properties"]);
  if (typeof schema.$ref !== "string")
    return fail(at(loc, "$ref"), "invalid-schema", "$ref must be a string");
  // Siblings may only narrow the target, like `properties: { target: false }`. Validators keep that rule.
  if (schema.properties !== undefined) {
    const props = schemaObject(schema.properties, at(loc, "properties"));
    for (const [key, value] of Object.entries(props)) {
      if (value !== false)
        fail(
          at(loc, "properties", key),
          "ref-siblings",
          "properties beside $ref may only forbid a key with false",
        );
    }
  }
  const key = resolveRef(ctx.set, schema.$ref, loc);
  if (key.def !== undefined && isOpenObject(schemaAt(ctx.set, key))) {
    fail(
      loc,
      "open-object",
      `$ref ${schema.$ref} names an open object, which is only allowed as an allOf base`,
      'use it in "allOf" beside "unevaluatedProperties": false, or close it',
    );
  }
  if (schema.properties !== undefined) {
    // A key forbidden beside $ref holds only when the def already rejects it: no decoder checks it.
    for (const name of Object.keys(schemaObject(schema.properties, at(loc, "properties")))) {
      if (holdsKey(ctx, schema, loc, name, new Set()))
        fail(
          at(loc, "properties", name),
          "ref-siblings",
          `the def ${schema.$ref} can hold the key ${name}, and no decoder checks a key forbidden beside $ref`,
          `make a def without ${name}, and name that one`,
        );
    }
  }
  if (schema.type !== undefined) {
    // A type beside $ref only holds when it is the target's own, else no decoder checks it.
    const target = jsonTypeOf(ctx, schema, loc, new Set());
    if (target !== schema.type && !(schema.type === "number" && target === "integer"))
      fail(
        at(loc, "type"),
        "type-mismatch",
        `type ${String(schema.type)} beside $ref doesn't match the type of the def it names`,
        'remove "type", the def the $ref names gives the type',
      );
  }
  return { kind: "ref", name: nameOf(ctx, key) };
}

/** True when a value of the schema can be an object with the key: an open object, a map, any value. */
function holdsKey(ctx: Ctx, value: Json, loc: Loc, key: string, seen: Set<string>): boolean {
  const target = deref(ctx, value, loc);
  const s = target.schema;
  const place = where(target.loc);
  if (seen.has(place)) return false;
  seen.add(place);
  if (s.oneOf !== undefined && s.type === undefined)
    return arrayAt(s.oneOf, at(target.loc, "oneOf")).some((branch, i) =>
      holdsKey(ctx, branch, at(target.loc, "oneOf", i), key, seen),
    );
  if (s.type !== "object") return jsonTypeOf(ctx, s, target.loc, new Set()) === undefined;
  if (s.additionalProperties !== false && s.unevaluatedProperties !== false) return true;
  const props = new Map<string, Prop>();
  collect(ctx, s, target.loc, props, new Set());
  return props.has(key);
}

/**
 * The JSON type every value of a schema has, when the schema says it: "string" for an enum,
 * the branches' type for a union whose branches all have one.
 */
function jsonTypeOf(ctx: Ctx, value: Json, loc: Loc, path: ReadonlySet<string>): string | undefined {
  const target = deref(ctx, value, loc);
  const s = target.schema;
  if (typeof s.type === "string") return s.type;
  if (s.enum !== undefined) return "string";
  const c = s.const;
  if (typeof c === "string" || typeof c === "boolean") return typeof c;
  if (typeof c === "number") return Number.isInteger(c) ? "integer" : "number";
  if (s.oneOf === undefined) return undefined;
  const place = where(target.loc);
  if (path.has(place)) return undefined;
  const inner = new Set([...path, place]);
  const types = new Set(
    arrayAt(s.oneOf, at(target.loc, "oneOf")).map((b, i) =>
      jsonTypeOf(ctx, b, at(target.loc, "oneOf", i), inner),
    ),
  );
  if (types.has(undefined)) return undefined;
  if (types.size === 1) return [...types][0];
  return types.size === 2 && types.has("integer") && types.has("number") ? "number" : undefined;
}

function constType(
  ctx: Ctx,
  schema: JsonObject,
  loc: Loc,
  name: string,
  source?: Source,
): TypeExpr {
  only(schema, loc, ["const", "type"]);
  const value = schema.const;
  const want = typeof value === "number" ? ["integer", "number"] : [typeof value];
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type !== undefined && !want.includes(type)) {
    fail(at(loc, "type"), "unsupported-const", `type ${type} doesn't match the const`);
  }
  if ((typeof value === "number" && Number.isInteger(value)) || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  if (typeof value !== "string") {
    return fail(
      at(loc, "const"),
      "unsupported-const",
      "const must be a string, an integer or a boolean",
    );
  }
  if (LONE_SURROGATE.test(value)) {
    fail(at(loc, "const"), "unsupported-const", `the const holds a lone surrogate, ${NO_SURROGATES}`);
  }
  return hoist(ctx, name, loc, () => ({
    kind: "enum",
    name,
    doc: docOf(schema),
    path: where(loc),
    schema: ctx.file,
    source,
    values: [value],
  }));
}

/** A UTF-16 surrogate without its pair, which no Rust or Go string holds. */
const LONE_SURROGATE = /\p{Surrogate}/u;
const NO_SURROGATES = "which Rust and Go strings can't";

function enumType(ctx: Ctx, schema: JsonObject, loc: Loc, name: string, source?: Source): TypeExpr {
  only(schema, loc, ["enum", "type"]);
  if (schema.type !== undefined && schema.type !== "string")
    fail(at(loc, "type"), "unsupported-enum", "enums must be strings");
  const values = arrayAt(schema.enum, at(loc, "enum")).map((v, i) =>
    typeof v !== "string"
      ? fail(at(loc, "enum", i), "unsupported-enum", "enum values must be strings")
      : LONE_SURROGATE.test(v)
        ? fail(at(loc, "enum", i), "unsupported-enum", `the value holds a lone surrogate, ${NO_SURROGATES}`)
        : v,
  );
  if (new Set(values).size !== values.length)
    fail(at(loc, "enum"), "unsupported-enum", "enum values must be unique");
  return hoist(ctx, name, loc, () => ({
    kind: "enum",
    name,
    doc: docOf(schema),
    path: where(loc),
    schema: ctx.file,
    source,
    values,
  }));
}

function arrayType(
  ctx: Ctx,
  schema: JsonObject,
  loc: Loc,
  name: string,
): TypeExpr {
  only(schema, loc, ["type", "items", "allOf"]);
  if (schema.allOf !== undefined) {
    arrayAt(schema.allOf, at(loc, "allOf")).forEach((entry, i) => {
      const entryLoc = at(loc, "allOf", i);
      const fragment = schemaObject(entry, entryLoc);
      checkKeywords(fragment, entryLoc, false);
      only(fragment, entryLoc, ["type"]);
      noConstraints(fragment, entryLoc, "in an allOf entry", 'move it beside "items"');
      if (fragment.type !== undefined && fragment.type !== "array")
        fail(at(entryLoc, "type"), "type-mismatch", "expected type array");
    });
  }
  limitsOnly(schema, loc, ARRAY_CONSTRAINTS, "to an array");
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean")
    fail(at(loc, "uniqueItems"), "invalid-constraint", "uniqueItems must be true or false");
  const minItems = count(schema, loc, "minItems");
  const maxItems = count(schema, loc, "maxItems");
  ordered(loc, "minItems", minItems, "maxItems", maxItems, true);
  const limits = ctx.validation
    ? {
        ...defined("minItems", minItems),
        ...defined("maxItems", maxItems),
        ...(schema.uniqueItems === true ? { uniqueItems: true as const } : {}),
      }
    : {};
  if (schema.items === undefined)
    return fail(
      loc,
      "missing-items",
      "an array needs items",
      'add "items", like "items": { "type": "string" }',
    );
  return {
    kind: "array",
    items: typeOf(ctx, schema.items, at(loc, "items"), `${name}Item`),
    ...limits,
  };
}

function objectType(
  ctx: Ctx,
  schema: JsonObject,
  loc: Loc,
  name: string,
  source?: Source,
): TypeExpr {
  const isMap =
    schema.properties === undefined && schema.allOf === undefined && schema.oneOf === undefined;
  if (isMap && (schema.propertyNames !== undefined || isObject(schema.additionalProperties))) {
    only(schema, loc, ["type", "propertyNames", "additionalProperties"]);
    limitsOnly(schema, loc, MAP_CONSTRAINTS, "to a map");
    const minProperties = count(schema, loc, "minProperties");
    const maxProperties = count(schema, loc, "maxProperties");
    ordered(loc, "minProperties", minProperties, "maxProperties", maxProperties, true);
    const limits = ctx.validation
      ? { ...defined("minProperties", minProperties), ...defined("maxProperties", maxProperties) }
      : {};
    const values = schema.additionalProperties;
    if (!isObject(values))
      return fail(
        loc,
        "map-values",
        "a map needs an additionalProperties schema for its values",
        'add "additionalProperties" with the value schema, like { "type": "string" }',
      );
    const key =
      schema.propertyNames === undefined
        ? { kind: "string" as const }
        : keyType(ctx, schema.propertyNames, at(loc, "propertyNames"), `${name}Key`);
    return {
      kind: "map",
      key,
      value: typeOf(ctx, values, at(loc, "additionalProperties"), `${name}Value`),
      ...limits,
    };
  }
  noConstraints(schema, loc, "to an object with named properties", (key) =>
    MAP_CONSTRAINTS.includes(key)
      ? 'list the keys it needs in "required"; key counts only apply to maps, objects with "additionalProperties" and no "properties"'
      : constraintHint(key),
  );
  return hoist(ctx, name, loc, () => structDecl(ctx, name, schema, loc, source));
}

function keyType(ctx: Ctx, value: Json, loc: Loc, name: string): TypeExpr {
  const schema = schemaObject(value, loc);
  checkKeywords(schema, loc, false);
  if (schema.$ref !== undefined) {
    const target = deref(ctx, schema, loc).schema;
    if (target.type !== "string" && target.enum === undefined) {
      fail(loc, "unsupported-map-key", "a map key $ref must name a string or a string enum");
    }
    return typeOf(ctx, schema, loc, name);
  }
  if (schema.enum !== undefined) return typeOf(ctx, schema, loc, name);
  only(schema, loc, ["type"]);
  if (schema.type !== "string") fail(loc, "unsupported-map-key", "map keys must be strings");
  return stringType(ctx, schema, loc);
}

/** A string, with its `pattern`, `format` and length limits when it has them. */
function stringType(ctx: Ctx, schema: JsonObject, loc: Loc): StringType {
  limitsOnly(schema, loc, STRING_CONSTRAINTS, "to a string");
  const pattern = schema.pattern;
  if (pattern !== undefined && typeof pattern !== "string")
    fail(at(loc, "pattern"), "invalid-constraint", "pattern must be a string");
  const format = schema.format;
  if (format !== undefined && (typeof format !== "string" || !FORMATS.has(format))) {
    fail(
      at(loc, "format"),
      "unsupported-format",
      "only the date-time, date and uuid formats are supported",
      'remove "format", or check the shape with "pattern"',
    );
  }
  const minLength = count(schema, loc, "minLength");
  const maxLength = count(schema, loc, "maxLength");
  ordered(loc, "minLength", minLength, "maxLength", maxLength, true);
  const match = typeof pattern === "string" ? portable(pattern, at(loc, "pattern")) : undefined;
  return {
    kind: "string",
    ...(typeof pattern === "string" ? { pattern } : {}),
    ...(ctx.validation
      ? {
          ...(match === undefined ? {} : { match }),
          ...(typeof format === "string" ? { format: format as Format } : {}),
          ...defined("minLength", minLength),
          ...defined("maxLength", maxLength),
        }
      : {}),
  };
}

/** A pattern and its portable form, or a generation error saying why it has none. */
function portable(source: string, loc: Loc): Pattern {
  try {
    return { source, regex: portablePattern(source) };
  } catch (error) {
    if (!(error instanceof PatternError)) throw error;
    return fail(loc, "unsupported-pattern", error.message, error.hint);
  }
}

/** An integer or a number, with its bounds and, for an integer, `multipleOf`. */
function numberType(
  ctx: Ctx,
  schema: JsonObject,
  loc: Loc,
  kind: "integer" | "number",
): IntegerType | NumberType {
  const integer = kind === "integer";
  limitsOnly(schema, loc, NUMBER_CONSTRAINTS, integer ? "to an integer" : "to a number");
  if (!integer && schema.multipleOf !== undefined) {
    fail(
      at(loc, "multipleOf"),
      "unsupported-constraint",
      "multipleOf on a number can give different results in each language, since floats round",
      'use "type": "integer" with a multipleOf, or remove it',
    );
  }
  const minimum = bound(schema, loc, "minimum", integer);
  const exclusiveMinimum = bound(schema, loc, "exclusiveMinimum", integer);
  const maximum = bound(schema, loc, "maximum", integer);
  const exclusiveMaximum = bound(schema, loc, "exclusiveMaximum", integer);
  for (const [low, lowValue] of [
    ["minimum", minimum],
    ["exclusiveMinimum", exclusiveMinimum],
  ] as const) {
    for (const [high, highValue] of [
      ["maximum", maximum],
      ["exclusiveMaximum", exclusiveMaximum],
    ] as const) {
      ordered(loc, low, lowValue, high, highValue, low === "minimum" && high === "maximum");
    }
  }
  const bounds = ctx.validation
    ? {
        ...defined("minimum", minimum),
        ...defined("exclusiveMinimum", exclusiveMinimum),
        ...defined("maximum", maximum),
        ...defined("exclusiveMaximum", exclusiveMaximum),
      }
    : {};
  if (!integer) return { kind: "number", ...bounds };
  const multipleOf = schema.multipleOf;
  if (
    multipleOf !== undefined &&
    (typeof multipleOf !== "number" || !Number.isSafeInteger(multipleOf) || multipleOf <= 0)
  ) {
    fail(
      at(loc, "multipleOf"),
      "invalid-constraint",
      `multipleOf of an integer must be a whole number from 1 to ${String(SAFE)}`,
    );
  }
  return {
    kind: "integer",
    ...bounds,
    ...(ctx.validation && typeof multipleOf === "number" ? { multipleOf } : {}),
  };
}

/** `{ [key]: value }`, or nothing when value is undefined, for optional model fields. */
function defined<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: number });
}

/** A count limit, like `minLength`: a whole number from 0 up, or undefined when absent. */
function count(schema: JsonObject, loc: Loc, key: string): number | undefined {
  const value = schema[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return fail(
      at(loc, key),
      "invalid-constraint",
      `${key} must be a whole number from 0 to ${String(SAFE)}`,
    );
  }
  return value;
}

/**
 * A bound, like `minimum`: a finite number, and for an integer a safe integer, which every
 * language holds exactly. `-0` reads as `0`.
 */
function bound(schema: JsonObject, loc: Loc, key: string, integer: boolean): number | undefined {
  const value = schema[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    return fail(
      at(loc, key),
      "invalid-constraint",
      `${key} must be a number`,
      typeof value === "boolean" ? `give the bound itself, like "${key}": 0` : undefined,
    );
  }
  if (integer && !Number.isSafeInteger(value)) {
    return fail(
      at(loc, key),
      "invalid-constraint",
      `${key} of an integer must be a whole number from -${String(SAFE)} to ${String(SAFE)}`,
      "every language holds a bound in that range exactly",
    );
  }
  return value === 0 ? 0 : value;
}

/** Fails when a lower limit is above an upper one, or equal to it when either is exclusive. */
function ordered(
  loc: Loc,
  low: string,
  lowValue: number | undefined,
  high: string,
  highValue: number | undefined,
  inclusive: boolean,
): void {
  if (lowValue === undefined || highValue === undefined) return;
  if (inclusive ? lowValue <= highValue : lowValue < highValue) return;
  fail(
    at(loc, low),
    "invalid-constraint",
    `${low} ${String(lowValue)} and ${high} ${String(highValue)} leave no value that fits`,
  );
}

/** The usual place for a constraint keyword, for the hint when it is somewhere else. */
function constraintHint(key: string): string {
  if (STRING_CONSTRAINTS.includes(key)) return 'use it beside "type": "string"';
  if (NUMBER_CONSTRAINTS.includes(key)) return 'use it beside "type": "integer" or "number"';
  if (ARRAY_CONSTRAINTS.includes(key)) return 'use it beside "type": "array"';
  return 'use it on a map, an object with "additionalProperties" and no "properties"';
}

/** Fails on the first constraint keyword of schema that allowed doesn't list. */
function limitsOnly(schema: JsonObject, loc: Loc, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(schema)) {
    if (CONSTRAINTS.has(key) && !allowed.includes(key))
      fail(at(loc, key), "misplaced-keyword", `${key} doesn't apply ${where}`, constraintHint(key));
  }
}

/**
 * Fails on the first constraint keyword of schema, which doesn't apply `where`, like beside
 * $ref. The hint says where it goes, or what `hint` gives.
 */
function noConstraints(
  schema: JsonObject,
  loc: Loc,
  where: string,
  hint: string | ((key: string) => string) = constraintHint,
): void {
  for (const key of Object.keys(schema)) {
    if (CONSTRAINTS.has(key)) {
      fail(
        at(loc, key),
        "misplaced-keyword",
        `${key} doesn't apply ${where}`,
        typeof hint === "string" ? hint : hint(key),
      );
    }
  }
}

const STRUCT_KEYWORDS = [
  "type",
  "properties",
  "required",
  "allOf",
  "oneOf",
  "unevaluatedProperties",
  "additionalProperties",
  "propertyNames",
];

function structDecl(ctx: Ctx, name: string, schema: JsonObject, loc: Loc, source?: Source): Decl {
  noAnyOf(schema, loc);
  only(schema, loc, STRUCT_KEYWORDS);
  const props = new Map<string, Prop>();
  const required = new Set<string>();
  collect(ctx, schema, loc, props, required);
  const closed = checkClosing(schema, loc);
  const rest = isObject(schema.additionalProperties)
    ? restOf(ctx, schema, loc, name, props)
    : undefined;
  if (rest === undefined && schema.propertyNames !== undefined) {
    fail(
      at(loc, "propertyNames"),
      "map-values",
      "propertyNames needs an additionalProperties schema",
      'add "additionalProperties" with the schema of the other keys\' values',
    );
  }
  if (!closed && rest === undefined) {
    fail(
      loc,
      "open-object",
      "objects must be closed, unless only used as an allOf base",
      schema.allOf === undefined
        ? 'add "additionalProperties": false'
        : 'add "unevaluatedProperties": false',
    );
  }
  for (const key of required) {
    if (!props.has(key))
      fail(
        at(loc, "required"),
        "undeclared-key",
        `required key ${key} has no property schema`,
        `add ${key} to "properties"`,
      );
  }
  const fields = fieldsOf(ctx, name, props, required);
  const base = { name, doc: docOf(schema), path: where(loc), schema: ctx.file, source };
  if (schema.oneOf === undefined) {
    return { ...base, kind: "struct", fields, closed, forbidden: [], rest };
  }
  const choices = requiredOnly(schema.oneOf, at(loc, "oneOf"), props);
  return exclusive(
    ctx,
    { ...base, kind: "struct", fields, closed, forbidden: [], rest },
    choices,
    loc,
  );
}

/**
 * An object's anyOf, like "at least one of email or phone", is a condition no decoder checks,
 * so it fails generation.
 */
function noAnyOf(schema: JsonObject, loc: Loc): void {
  if (schema.anyOf === undefined) return;
  fail(
    at(loc, "anyOf"),
    "misplaced-keyword",
    "anyOf beside properties is not checked by the decoders",
    'for exactly one of the keys, use "oneOf" with the same branches; for all of them, list them in "required"',
  );
}

/** Checks how an object is closed, and returns true when unknown keys are rejected. */
function checkClosing(schema: JsonObject, loc: Loc): boolean {
  if (schema.unevaluatedProperties !== undefined && schema.unevaluatedProperties !== false) {
    fail(
      at(loc, "unevaluatedProperties"),
      "open-object",
      "unevaluatedProperties must be false",
      'set "unevaluatedProperties": false, or use "additionalProperties" with a schema for a map',
    );
  }
  if (schema.additionalProperties === true) {
    fail(
      at(loc, "additionalProperties"),
      "open-object",
      "open objects with additionalProperties true are not supported",
      'set "additionalProperties": false, or give it the schema of the extra values',
    );
  }
  if (schema.additionalProperties === false && schema.allOf !== undefined) {
    // additionalProperties doesn't see keys from allOf, so it would reject every base key.
    fail(
      at(loc, "additionalProperties"),
      "closed-with-allof",
      "use unevaluatedProperties false beside allOf",
      'replace "additionalProperties": false with "unevaluatedProperties": false',
    );
  }
  return schema.unevaluatedProperties === false || schema.additionalProperties === false;
}

function fieldsOf(
  ctx: Ctx,
  name: string,
  props: ReadonlyMap<string, Prop>,
  required: ReadonlySet<string>,
): Field[] {
  return [...props].map(([key, prop]) => {
    const type = typeOf(ctx, prop.schema, prop.loc, `${name}${pascal(key)}`);
    return { name: key, doc: docOf(prop.schema), type, required: required.has(key), boxed: false };
  });
}

/** An exactly-one oneOf of required-only branches, like a contact's email or phone: one struct per choice. */
function exclusive(ctx: Ctx, whole: StructDecl, choices: readonly string[][], loc: Loc): Decl {
  if (!whole.closed)
    fail(
      at(loc, "oneOf"),
      "open-object",
      "an exactly-one oneOf needs a closed object",
      'add "unevaluatedProperties": false',
    );
  const choiceKeys = new Set(choices.flat());
  const variants: UntaggedVariant[] = choices.map((keys) => {
    const variant = pascal(keys.join(" "));
    const struct: StructDecl = {
      ...whole,
      name: `${whole.name}${variant}`,
      source: undefined,
      fields: whole.fields
        .filter((f) => !choiceKeys.has(f.name) || keys.includes(f.name))
        .map((f) => ({ ...f, required: f.required || keys.includes(f.name) })),
      forbidden: [...choiceKeys].filter((k) => !keys.includes(k)),
    };
    hoist(ctx, struct.name, loc, () => struct);
    return { name: variant, type: { kind: "ref", name: struct.name }, boxed: false };
  });
  const { name, doc, path, schema, source } = whole;
  return { name, doc, path, schema, source, kind: "untagged", variants };
}

/** Collects properties and required keys through allOf bases and fragments. */
function collect(
  ctx: Ctx,
  schema: JsonObject,
  loc: Loc,
  props: Map<string, Prop>,
  required: Set<string>,
): void {
  if (schema.allOf !== undefined) {
    arrayAt(schema.allOf, at(loc, "allOf")).forEach((entry, i) => {
      const entryLoc = at(loc, "allOf", i);
      const fragment = schemaObject(entry, entryLoc);
      checkKeywords(fragment, entryLoc, false);
      if (fragment.$ref !== undefined) {
        only(fragment, entryLoc, ["$ref"]);
        if (typeof fragment.$ref !== "string")
          fail(at(entryLoc, "$ref"), "invalid-schema", "$ref must be a string");
        const key = resolveRef(ctx.set, fragment.$ref, entryLoc);
        const target = schemaAt(ctx.set, key);
        checkKeywords(target, keyLoc(key), key.def === undefined);
        if (target.type !== "object")
          fail(entryLoc, "type-mismatch", "an allOf base must be an object");
        checkFragment(target, keyLoc(key));
        if (target.unevaluatedProperties !== undefined && target.unevaluatedProperties !== false)
          fail(
            at(keyLoc(key), "unevaluatedProperties"),
            "misplaced-keyword",
            "unevaluatedProperties other than false in an allOf base is not checked by the decoders",
            'remove it, and close the object that names the base with "unevaluatedProperties": false',
          );
        collect(ctx, target, keyLoc(key), props, required);
      } else {
        if (fragment.unevaluatedProperties !== undefined)
          fail(
            at(entryLoc, "unevaluatedProperties"),
            "misplaced-keyword",
            "unevaluatedProperties in an allOf part is not checked by the decoders",
            'remove it, and close the object that holds the allOf with "unevaluatedProperties": false',
          );
        checkFragment(fragment, entryLoc);
        collect(ctx, fragment, entryLoc, props, required);
      }
    });
  }
  if (schema.properties !== undefined) {
    const own = schemaObject(schema.properties, at(loc, "properties"));
    for (const [key, value] of Object.entries(own)) {
      const propLoc = at(loc, "properties", key);
      const existing = props.get(key);
      if (value === true) {
        // Redeclared as true for Ajv strictRequired. The schema comes from a base.
        if (existing === undefined)
          fail(
            propLoc,
            "undeclared-key",
            `property ${key} is true but no base declares it`,
            `give ${key} a schema, or declare it in an allOf base`,
          );
        continue;
      }
      const prop = schemaObject(value, propLoc);
      if (existing !== undefined && !sameJson(existing.schema, prop)) {
        fail(
          propLoc,
          "property-redeclared",
          `property ${key} is redeclared with another schema (first at ${where(existing.loc)})`,
          `declare ${key} once, or redeclare it as true`,
        );
      }
      if (existing === undefined) props.set(key, { schema: prop, loc: propLoc });
    }
  }
  if (schema.required !== undefined) {
    arrayAt(schema.required, at(loc, "required")).forEach((key, i) => {
      if (typeof key !== "string")
        fail(at(loc, "required", i), "invalid-schema", "required keys must be strings");
      required.add(key);
    });
  }
}

function checkFragment(fragment: JsonObject, loc: Loc): void {
  noAnyOf(fragment, loc);
  only(fragment, loc, ["type", "properties", "required", "allOf", "unevaluatedProperties"], (key) =>
    key === "additionalProperties"
      ? 'an allOf part or base stays open; close the object that holds the allOf with "unevaluatedProperties": false'
      : MISPLACED_HINTS[key],
  );
  noConstraints(fragment, loc, "to an allOf part of an object", (key) =>
    MAP_CONSTRAINTS.includes(key)
      ? 'list the keys the object needs in "required" instead'
      : "put it on the property it limits",
  );
  if (fragment.type !== undefined && fragment.type !== "object")
    fail(at(loc, "type"), "type-mismatch", "expected type object");
}

/** Reads branches that only require keys, like `{ "properties": { "href": true }, "required": ["href"] }`. */
function requiredOnly(value: Json, loc: Loc, props: ReadonlyMap<string, Prop>): string[][] {
  return arrayAt(value, loc).map((entry, i) => {
    const branchLoc = at(loc, i);
    const branch = schemaObject(entry, branchLoc);
    checkKeywords(branch, branchLoc, false);
    only(branch, branchLoc, ["properties", "required"]);
    noConstraints(branch, branchLoc, "in a branch that only requires keys", "put it on the property it limits");
    if (branch.properties !== undefined) {
      for (const [key, v] of Object.entries(
        schemaObject(branch.properties, at(branchLoc, "properties")),
      )) {
        if (v !== true)
          fail(
            at(branchLoc, "properties", key),
            "unsupported-branch",
            "branch properties may only be true",
            "declare the property's schema on the object and list it as true in the branch",
          );
      }
    }
    const keys = arrayAt(branch.required, at(branchLoc, "required")).map((k, j) =>
      typeof k === "string" && props.has(k)
        ? k
        : fail(
            at(branchLoc, "required", j),
            "undeclared-key",
            "required key has no property",
            "declare the key in the object's properties",
          ),
    );
    return keys;
  });
}

/** The data keys of an object with named properties, like the currencies beside `default`. */
function restOf(
  ctx: Ctx,
  schema: JsonObject,
  loc: Loc,
  name: string,
  props: ReadonlyMap<string, Prop>,
): Rest {
  const value = typeOf(
    ctx,
    schema.additionalProperties,
    at(loc, "additionalProperties"),
    `${name}Value`,
  );
  const names = schema.propertyNames;
  if (names === undefined) return { key: { kind: "string" }, value };
  const namesLoc = at(loc, "propertyNames");
  const keySchema = schemaObject(names, namesLoc);
  checkKeywords(keySchema, namesLoc, false);
  if (keySchema.anyOf === undefined) {
    const key = keyType(ctx, keySchema, namesLoc, `${name}Key`);
    namedKeysAllowed(ctx, keySchema, namesLoc, props, false);
    return { key, value };
  }
  only(keySchema, namesLoc, ["type", "anyOf"]);
  // Named properties appear as consts, the remaining branch types the other keys.
  const others = arrayAt(keySchema.anyOf, at(namesLoc, "anyOf")).filter((branch, i) => {
    const branchLoc = at(namesLoc, "anyOf", i);
    if (!isObject(branch) || typeof branch.const !== "string") return true;
    checkKeywords(branch, branchLoc, false);
    only(branch, branchLoc, ["const"]);
    noConstraints(branch, branchLoc, "beside const", "remove it, the const is the only value");
    if (!props.has(branch.const))
      fail(
        branchLoc,
        "undeclared-key",
        `key ${branch.const} has no property schema`,
        `add ${branch.const} to "properties"`,
      );
    return false;
  });
  const [other] = others;
  if (others.length !== 1 || other === undefined) {
    return fail(
      namesLoc,
      "unsupported-branch",
      "propertyNames anyOf needs one non-const branch for the other keys",
    );
  }
  const key = keyType(ctx, other, namesLoc, `${name}Key`);
  namedKeysAllowed(ctx, keySchema, namesLoc, props, true);
  return { key, value };
}

/**
 * JSON Schema applies propertyNames to every key, the named ones too, but the decoders read a
 * named key by its property only. So each named key must be one the names schema allows.
 */
function namedKeysAllowed(
  ctx: Ctx,
  names: JsonObject,
  loc: Loc,
  props: ReadonlyMap<string, Prop>,
  withAnyOf: boolean,
): void {
  for (const [key, prop] of props) {
    if (keyAllowed(ctx, names, loc, key)) continue;
    fail(
      prop.loc,
      "invalid-constraint",
      `"propertyNames" doesn't allow the named key ${key}, and no decoder checks a named key against it`,
      withAnyOf
        ? `add { "const": "${key}" } to the "anyOf" of "propertyNames"`
        : `make "propertyNames" an "anyOf" of { "const": "${key}" } and the schema of the other keys`,
    );
  }
}

/** True when a key schema (an enum, a const, an anyOf, or a string with a pattern and lengths) allows the key. */
function keyAllowed(ctx: Ctx, value: Json, loc: Loc, key: string): boolean {
  const { schema, loc: schemaLoc } = deref(ctx, value, loc);
  if (schema.anyOf !== undefined)
    return arrayAt(schema.anyOf, at(schemaLoc, "anyOf")).some((b, i) =>
      keyAllowed(ctx, b, at(schemaLoc, "anyOf", i), key),
    );
  if (schema.enum !== undefined) return Array.isArray(schema.enum) && schema.enum.includes(key);
  if (schema.const !== undefined) return schema.const === key;
  if (schema.type !== undefined && schema.type !== "string") return false;
  const length = [...key].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) return false;
  if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
  if (typeof schema.pattern === "string") {
    // The pattern as JSON Schema reads it: ECMAScript with the u flag, unanchored.
    try {
      return new RegExp(schema.pattern, "u").test(key);
    } catch {
      return false;
    }
  }
  return true;
}

function unionDecl(
  ctx: Ctx,
  name: string,
  branches: readonly Branch[],
  loc: Loc,
  doc: string,
  source?: Source,
): Decl {
  const base = { name, doc, path: where(loc), schema: ctx.file, source };
  const leaves = branches.flatMap((b) => leavesOf(ctx, b, new Set([where(loc)])));
  const tag = tagOf(ctx, leaves, loc);
  if (tag !== undefined) {
    const variants: TaggedVariant[] = leaves.map((leaf, i) => {
      const value = tag.values[i] ?? "";
      const type = typeOf(ctx, leaf.schema, leaf.loc, `${name}${pascal(value)}`);
      if (type.kind !== "ref")
        return fail(leaf.loc, "type-mismatch", "a tagged branch must be an object");
      return { value, type: type.name, boxed: false };
    });
    return { ...base, kind: "tagged", tag: tag.key, variants };
  }
  const ranked = branches
    .map((branch, index) => ({ branch, index, rank: rankOf(ctx, branch.schema, branch.loc) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const seen = new Set<string>();
  const variants: UntaggedVariant[] = ranked.map(({ branch, index }) => {
    const type = typeOf(ctx, branch.schema, branch.loc, `${name}Variant${String(index + 1)}`);
    const variant = untaggedName(type);
    if (seen.has(variant))
      fail(
        branch.loc,
        "untagged-union",
        `two branches of the union are both named ${variant}`,
        'give every branch a required tag property with a distinct const, like "type": { "const": "card" }',
      );
    seen.add(variant);
    return { name: variant, type, boxed: false };
  });
  return { ...base, kind: "untagged", variants };
}

function untaggedName(type: TypeExpr): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "array":
      return "List";
    case "map":
      return "Map";
    case "any":
    case "nonNull":
      return "Json";
    default:
      return pascal(type.kind);
  }
}

/** Follows `$ref` only schemas to the schema they name. */
function deref(ctx: Ctx, schema: Json, loc: Loc): { schema: JsonObject; loc: Loc } {
  let current = schemaObject(schema, loc);
  let currentLoc = loc;
  for (let depth = 0; typeof current.$ref === "string"; depth++) {
    if (depth > 32) fail(loc, "ref-cycle", "$ref chain is too deep");
    const key = resolveRef(ctx.set, current.$ref, currentLoc);
    current = schemaAt(ctx.set, key);
    currentLoc = keyLoc(key);
  }
  return { schema: current, loc: currentLoc };
}

/** Branches of a union, with nested unions spread, for finding a shared tag. */
function leavesOf(ctx: Ctx, branch: Branch, path: ReadonlySet<string>): Branch[] {
  const target = deref(ctx, branch.schema, branch.loc);
  const { oneOf } = target.schema;
  if (oneOf === undefined || target.schema.type !== undefined) return [branch];
  const place = where(target.loc);
  if (path.has(place))
    fail(
      branch.loc,
      "ref-cycle",
      "a union can't be one of its own branches",
      "remove the branch, or wrap it in an object so a struct holds it",
    );
  const inner = new Set([...path, place]);
  return arrayAt(oneOf, at(target.loc, "oneOf")).flatMap((b, i) =>
    leavesOf(ctx, { schema: b, loc: at(target.loc, "oneOf", i) }, inner),
  );
}

/** The `const` tag every leaf shares, with distinct values, if there is one. */
function tagOf(
  ctx: Ctx,
  leaves: readonly Branch[],
  loc: Loc,
): { key: string; values: string[] } | undefined {
  const consts: Map<string, string>[] = [];
  for (const leaf of leaves) {
    const target = deref(ctx, leaf.schema, leaf.loc);
    const s = target.schema;
    if (s.type !== "object" || s.propertyNames !== undefined || isObject(s.additionalProperties))
      return undefined;
    const props = new Map<string, Prop>();
    const required = new Set<string>();
    collect(ctx, s, target.loc, props, required);
    const found = new Map<string, string>();
    for (const [key, prop] of props) {
      if (typeof prop.schema.const === "string" && required.has(key))
        found.set(key, prop.schema.const);
    }
    consts.push(found);
  }
  const keys = [...new Set(consts.flatMap((c) => [...c.keys()]))];
  for (const key of keys) {
    const values = consts.map((c) => c.get(key));
    if (values.every((v) => v !== undefined) && new Set(values).size === values.length) {
      return { key, values };
    }
  }
  // A const some branches carry and others don't, or with repeated values, is a broken tag.
  const [partial] = keys;
  if (partial !== undefined) {
    fail(
      loc,
      "union-tag",
      `branches carry the tag ${partial} only partly, or repeat its values`,
      `make ${partial} a required string const on every branch, with a different value on each`,
    );
  }
  return undefined;
}

/**
 * Decode order for untagged unions: objects with required keys first (like an
 * account reference), then arrays, maps (like a currency map), enums, strings, integers,
 * numbers, booleans, other unions and any JSON last.
 */
function rankOf(ctx: Ctx, schema: Json, loc: Loc): number {
  const { schema: s } = deref(ctx, schema, loc);
  if (s.enum !== undefined || typeof s.const === "string") return 3;
  if (s.oneOf !== undefined && s.type === undefined) return 8;
  switch (s.type) {
    case "object":
      return s.properties === undefined && s.allOf === undefined ? 2 : 0;
    case "array":
      return 1;
    case "string":
      return 4;
    case "integer":
      return 5;
    case "number":
      return 6;
    case "boolean":
      return 7;
    default:
      return 9;
  }
}

function sameJson(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Resolves a type through aliases to the declaration that holds it. */
function resolveAlias(ctx: Ctx, type: TypeExpr): string | undefined {
  let current = type;
  for (let depth = 0; current.kind === "ref"; depth++) {
    const decl = ctx.decls.get(current.name);
    if (decl?.kind !== "alias") return current.name;
    if (depth > ctx.decls.size)
      throw new CodegenError(decl.path, "alias-cycle", `alias cycle through ${decl.name}`, CYCLE);
    current = decl.type;
  }
  return undefined;
}

/** Aliases can't contain themselves, even through arrays or maps, since languages expand them eagerly. */
function checkAliasCycles(ctx: Ctx): void {
  const refsOf = (type: TypeExpr): string[] => {
    switch (type.kind) {
      case "ref":
        return [type.name];
      case "array":
        return refsOf(type.items);
      case "map":
        return [...refsOf(type.key), ...refsOf(type.value)];
      default:
        return [];
    }
  };
  for (const decl of ctx.decls.values()) {
    if (decl.kind !== "alias") continue;
    const stack = refsOf(decl.type);
    const seen = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop() ?? "";
      if (next === decl.name)
        throw new CodegenError(
          decl.path,
          "alias-cycle",
          `alias ${decl.name} contains itself`,
          CYCLE,
        );
      const target = ctx.decls.get(next);
      if (seen.has(next) || target?.kind !== "alias") continue;
      seen.add(next);
      stack.push(...refsOf(target.type));
    }
  }
}

interface Edge {
  readonly to: string;
  readonly mark: () => void;
}

function edgesOf(ctx: Ctx, decl: Decl): Edge[] {
  const edges: Edge[] = [];
  const push = (type: TypeExpr, mark: () => void): void => {
    const to = resolveAlias(ctx, type);
    if (to !== undefined) edges.push({ to, mark });
  };
  switch (decl.kind) {
    case "struct":
      for (const field of decl.fields) push(field.type, () => (field.boxed = true));
      break;
    case "tagged":
      for (const variant of decl.variants)
        push({ kind: "ref", name: variant.type }, () => (variant.boxed = true));
      break;
    case "untagged":
      for (const variant of decl.variants) push(variant.type, () => (variant.boxed = true));
      break;
    default:
      break;
  }
  return edges;
}

/**
 * Marks the fields and variants that need a pointer (a Rust `Box`) because a
 * type contains itself without an array or map between. A depth first walk
 * in name order boxes back edges only, so the result is deterministic.
 */
function box(ctx: Ctx): void {
  const state = new Map<string, "active" | "done">();
  const visit = (name: string): void => {
    const decl = ctx.decls.get(name);
    if (decl === undefined) return;
    state.set(name, "active");
    for (const edge of edgesOf(ctx, decl)) {
      const seen = state.get(edge.to);
      if (seen === "active") edge.mark();
      else if (seen === undefined) visit(edge.to);
    }
    state.set(name, "done");
  };
  for (const name of [...ctx.decls.keys()].sort(compare)) {
    if (!state.has(name) && ctx.decls.get(name)?.kind !== "alias") visit(name);
  }
}
