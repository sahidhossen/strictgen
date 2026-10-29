import type {
  Decl,
  Field,
  Model,
  Rest,
  Source,
  StructDecl,
  TaggedVariant,
  TypeExpr,
  UntaggedVariant,
} from "./model.js";
import { compare } from "./common.js";
import { pascal } from "./naming.js";
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
/** Value rules the types don't carry. A validator checks them, not the generated types. */
const CONSTRAINTS = new Set([
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contains",
]);
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
  "if",
  "then",
  "else",
  "properties",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "format",
]);
const TYPES = new Set(["object", "array", "string", "integer", "number", "boolean"]);
/** `date-time` and `date` stay strings, so they re-encode byte for byte. */
const FORMATS = new Set(["date-time", "date"]);

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
}

interface Ctx {
  readonly set: SchemaSet;
  readonly ids: IdRule | undefined;
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

interface Conditional {
  readonly branches: readonly { readonly schema: JsonObject; readonly loc: Loc }[];
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
          "a typed schema needs a title to name its root type",
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
    if (owner !== undefined) fail(keyLoc(key), `type name ${name} is also used by ${owner}`);
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
      fail(at(loc, "$ref"), "a def can't be a $ref to itself");
  }
  const type = typeOf(ctx, schema, loc, name, source);
  const base = { name, doc: docOf(schema), path: where(loc), schema: ctx.file, source };
  if (isIdDef(key, ctx.ids)) {
    if (type.kind !== "string") fail(loc, "an id must be a string");
    add(ctx, { ...base, kind: "id" });
    return;
  }
  if (type.kind === "ref" && type.name === name) return;
  add(ctx, { ...base, kind: "alias", type });
}

function nameOf(ctx: Ctx, key: DefKey): string {
  const name = ctx.names.get(keyString(key));
  if (name === undefined) return fail(keyLoc(key), "def has no type name");
  return name;
}

function add(ctx: Ctx, decl: Decl): void {
  const other = ctx.decls.get(decl.name);
  if (other !== undefined) {
    throw new CodegenError(decl.path, `type name ${decl.name} is also used by ${other.path}`);
  }
  ctx.decls.set(decl.name, decl);
}

/** Reserves `name`, builds its declaration and returns a ref to it. */
function hoist(ctx: Ctx, name: string, loc: Loc, build: () => Decl): TypeExpr {
  const other = ctx.decls.get(name);
  if (other !== undefined) fail(loc, `type name ${name} is also used by ${other.path}`);
  add(ctx, build());
  return { kind: "ref", name };
}

function docOf(schema: Json | undefined): string {
  return isObject(schema) && typeof schema.description === "string" ? schema.description : "";
}

function schemaObject(value: Json | undefined, loc: Loc): JsonObject {
  if (!isObject(value)) return fail(loc, "expected a schema object");
  return value;
}

function checkKeywords(schema: JsonObject, loc: Loc, root: boolean): void {
  for (const key of Object.keys(schema)) {
    const known =
      ANNOTATIONS.has(key) ||
      CONSTRAINTS.has(key) ||
      STRUCTURAL.has(key) ||
      (root && ROOT_KEYWORDS.has(key));
    if (!known) fail(at(loc, key), `unsupported keyword ${key}`);
  }
  const type = schema.type;
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    fail(at(loc, "type"), "type must be one of object, array, string, integer, number or boolean");
  }
}

function structural(schema: JsonObject): string[] {
  return Object.keys(schema).filter((k) => STRUCTURAL.has(k));
}

function only(schema: JsonObject, loc: Loc, allowed: readonly string[]): void {
  for (const key of structural(schema)) {
    if (!allowed.includes(key)) fail(at(loc, key), `${key} is not supported here`);
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
  if (schema.$ref !== undefined) return refType(ctx, schema, loc);
  const keys = structural(schema);
  if (keys.length === 0) return { kind: "any" };
  if (schema.not !== undefined && keys.length === 1) {
    if (isNullConst(schema.not)) return { kind: "nonNull" };
    return fail(at(loc, "not"), 'a schema with only not must be { "not": { "const": null } }');
  }
  if (schema.const !== undefined) return constType(ctx, schema, loc, name, source);
  if (schema.enum !== undefined) return enumType(ctx, schema, loc, name, source);
  if (schema.oneOf !== undefined && schema.type === undefined) {
    only(schema, loc, ["oneOf"]);
    const branches = arrayAt(schema.oneOf, at(loc, "oneOf")).map((b, i) => ({
      schema: b,
      loc: at(loc, "oneOf", i),
    }));
    return hoist(ctx, name, loc, () => unionDecl(ctx, name, branches, loc, docOf(schema), source));
  }
  switch (schema.type) {
    case "string":
      only(schema, loc, ["type", "not", "format"]);
      if (schema.not !== undefined && !isStringExclusion(schema.not)) {
        fail(at(loc, "not"), "not beside a string type may only exclude a pattern or values");
      }
      if (
        schema.format !== undefined &&
        (typeof schema.format !== "string" || !FORMATS.has(schema.format))
      ) {
        fail(at(loc, "format"), "only the date-time and date formats are supported");
      }
      return { kind: "string" };
    case "integer":
    case "number":
    case "boolean":
      only(schema, loc, ["type"]);
      return { kind: schema.type };
    case "array":
      return arrayType(ctx, schema, loc, name, undefined);
    case "object":
      return objectType(ctx, schema, loc, name, source);
    default:
      return fail(loc, "schema has no type, $ref, const, enum or oneOf");
  }
}

function arrayAt(value: Json | undefined, loc: Loc): readonly Json[] {
  if (!Array.isArray(value) || value.length === 0) return fail(loc, "expected a non-empty array");
  return value as readonly Json[];
}

function isNullConst(value: Json | undefined): boolean {
  return isObject(value) && structural(value).length === 1 && value.const === null;
}

/** A `not` beside a string type that excludes a pattern or a list of values, like reserved field keys. */
function isStringExclusion(value: Json | undefined): boolean {
  if (!isObject(value)) return false;
  const keys = structural(value);
  const excludes = typeof value.pattern === "string" || Array.isArray(value.enum);
  return (
    excludes &&
    keys.every((k) => k === "type" || k === "enum") &&
    (value.type === undefined || value.type === "string")
  );
}

function refType(ctx: Ctx, schema: JsonObject, loc: Loc): TypeExpr {
  only(schema, loc, ["$ref", "type", "properties"]);
  if (typeof schema.$ref !== "string") return fail(at(loc, "$ref"), "$ref must be a string");
  // Siblings may only narrow the target, like `properties: { target: false }`. Validators keep that rule.
  if (schema.properties !== undefined) {
    const props = schemaObject(schema.properties, at(loc, "properties"));
    for (const [key, value] of Object.entries(props)) {
      if (value !== false)
        fail(at(loc, "properties", key), "properties beside $ref may only forbid a key with false");
    }
  }
  const key = resolveRef(ctx.set, schema.$ref, loc);
  if (key.def !== undefined && isOpenObject(schemaAt(ctx.set, key))) {
    fail(loc, `$ref ${schema.$ref} names an open object, which is only allowed as an allOf base`);
  }
  return { kind: "ref", name: nameOf(ctx, key) };
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
    fail(at(loc, "type"), `type ${type} doesn't match the const`);
  }
  if ((typeof value === "number" && Number.isInteger(value)) || typeof value === "boolean") {
    return { kind: "literal", value };
  }
  if (typeof value !== "string") {
    return fail(at(loc, "const"), "const must be a string, an integer or a boolean");
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

function enumType(ctx: Ctx, schema: JsonObject, loc: Loc, name: string, source?: Source): TypeExpr {
  only(schema, loc, ["enum", "type"]);
  if (schema.type !== undefined && schema.type !== "string")
    fail(at(loc, "type"), "enums must be strings");
  const values = arrayAt(schema.enum, at(loc, "enum")).map((v, i) =>
    typeof v === "string" ? v : fail(at(loc, "enum", i), "enum values must be strings"),
  );
  if (new Set(values).size !== values.length) fail(at(loc, "enum"), "enum values must be unique");
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
  lifted: TypeExpr | undefined,
): TypeExpr {
  only(schema, loc, ["type", "items", "allOf"]);
  if (schema.allOf !== undefined) {
    // Array rules like `contains` inside allOf, as in a workflow's statuses.
    arrayAt(schema.allOf, at(loc, "allOf")).forEach((entry, i) => {
      const entryLoc = at(loc, "allOf", i);
      const fragment = schemaObject(entry, entryLoc);
      checkKeywords(fragment, entryLoc, false);
      only(fragment, entryLoc, ["type"]);
      if (fragment.type !== undefined && fragment.type !== "array")
        fail(at(entryLoc, "type"), "expected type array");
    });
  }
  if (lifted !== undefined) return { kind: "array", items: lifted };
  if (schema.items === undefined) return fail(loc, "an array needs items");
  return { kind: "array", items: typeOf(ctx, schema.items, at(loc, "items"), `${name}Item`) };
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
    const values = schema.additionalProperties;
    if (!isObject(values))
      return fail(loc, "a map needs an additionalProperties schema for its values");
    const key =
      schema.propertyNames === undefined
        ? { kind: "string" as const }
        : keyType(ctx, schema.propertyNames, at(loc, "propertyNames"), `${name}Key`);
    return {
      kind: "map",
      key,
      value: typeOf(ctx, values, at(loc, "additionalProperties"), `${name}Value`),
    };
  }
  return hoist(ctx, name, loc, () => structDecl(ctx, name, schema, loc, source));
}

function keyType(ctx: Ctx, value: Json, loc: Loc, name: string): TypeExpr {
  const schema = schemaObject(value, loc);
  checkKeywords(schema, loc, false);
  if (schema.$ref !== undefined) {
    const target = deref(ctx, schema, loc).schema;
    if (target.type !== "string" && target.enum === undefined) {
      fail(loc, "a map key $ref must name a string or a string enum");
    }
    return typeOf(ctx, schema, loc, name);
  }
  if (schema.enum !== undefined) return typeOf(ctx, schema, loc, name);
  only(schema, loc, ["type"]);
  if (schema.type !== "string") fail(loc, "map keys must be strings");
  return { kind: "string" };
}

const STRUCT_KEYWORDS = [
  "type",
  "properties",
  "required",
  "allOf",
  "oneOf",
  "anyOf",
  "if",
  "then",
  "else",
  "unevaluatedProperties",
  "additionalProperties",
  "propertyNames",
];

function structDecl(ctx: Ctx, name: string, schema: JsonObject, loc: Loc, source?: Source): Decl {
  only(schema, loc, STRUCT_KEYWORDS);
  const props = new Map<string, Prop>();
  const required = new Set<string>();
  const conditionals: Conditional[] = [];
  collect(ctx, schema, loc, props, required, conditionals);
  const closed = checkClosing(schema, loc);
  const rest = isObject(schema.additionalProperties)
    ? restOf(ctx, schema, loc, name, props)
    : undefined;
  if (rest === undefined && schema.propertyNames !== undefined) {
    fail(at(loc, "propertyNames"), "propertyNames needs an additionalProperties schema");
  }
  if (!closed && rest === undefined) {
    fail(loc, "an open object is only allowed as an allOf base");
  }
  for (const key of required) {
    if (!props.has(key)) fail(at(loc, "required"), `required key ${key} has no property schema`);
  }
  const fields = fieldsOf(ctx, name, props, required, liftItems(ctx, name, conditionals, props));
  if (schema.anyOf !== undefined) requiredOnly(schema.anyOf, at(loc, "anyOf"), props); // An at least one rule.
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

/** Checks how an object is closed, and returns true when unknown keys are rejected. */
function checkClosing(schema: JsonObject, loc: Loc): boolean {
  if (schema.unevaluatedProperties !== undefined && schema.unevaluatedProperties !== false) {
    fail(at(loc, "unevaluatedProperties"), "unevaluatedProperties must be false");
  }
  if (schema.additionalProperties === true) {
    fail(
      at(loc, "additionalProperties"),
      "open objects with additionalProperties true are not supported",
    );
  }
  if (schema.additionalProperties === false && schema.allOf !== undefined) {
    // additionalProperties doesn't see keys from allOf, so it would reject every base key.
    fail(at(loc, "additionalProperties"), "use unevaluatedProperties false beside allOf");
  }
  return schema.unevaluatedProperties === false || schema.additionalProperties === false;
}

function fieldsOf(
  ctx: Ctx,
  name: string,
  props: ReadonlyMap<string, Prop>,
  required: ReadonlySet<string>,
  lifted: ReadonlyMap<string, TypeExpr>,
): Field[] {
  return [...props].map(([key, prop]) => {
    const fieldName = `${name}${pascal(key)}`;
    const liftedItems = lifted.get(key);
    const type =
      liftedItems === undefined
        ? typeOf(ctx, prop.schema, prop.loc, fieldName)
        : arrayType(ctx, prop.schema, prop.loc, fieldName, liftedItems);
    return { name: key, doc: docOf(prop.schema), type, required: required.has(key), boxed: false };
  });
}

/** An exactly-one oneOf of required-only branches, like a contact's email or phone: one struct per choice. */
function exclusive(ctx: Ctx, whole: StructDecl, choices: readonly string[][], loc: Loc): Decl {
  if (!whole.closed) fail(at(loc, "oneOf"), "an exactly-one oneOf needs a closed object");
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
  conditionals: Conditional[],
): void {
  if (schema.allOf !== undefined) {
    arrayAt(schema.allOf, at(loc, "allOf")).forEach((entry, i) => {
      const entryLoc = at(loc, "allOf", i);
      const fragment = schemaObject(entry, entryLoc);
      checkKeywords(fragment, entryLoc, false);
      if (fragment.if !== undefined) {
        conditionals.push(conditional(fragment, entryLoc));
      } else if (fragment.$ref !== undefined) {
        only(fragment, entryLoc, ["$ref"]);
        if (typeof fragment.$ref !== "string") fail(at(entryLoc, "$ref"), "$ref must be a string");
        const key = resolveRef(ctx.set, fragment.$ref, entryLoc);
        const target = schemaAt(ctx.set, key);
        if (target.type !== "object") fail(entryLoc, "an allOf base must be an object");
        checkFragment(target, keyLoc(key));
        collect(ctx, target, keyLoc(key), props, required, conditionals);
      } else {
        checkFragment(fragment, entryLoc);
        collect(ctx, fragment, entryLoc, props, required, conditionals);
      }
    });
  }
  if (schema.if !== undefined) conditionals.push(conditional(schema, loc));
  if (schema.properties !== undefined) {
    const own = schemaObject(schema.properties, at(loc, "properties"));
    for (const [key, value] of Object.entries(own)) {
      const propLoc = at(loc, "properties", key);
      const existing = props.get(key);
      if (value === true) {
        // Redeclared as true for Ajv strictRequired. The schema comes from a base.
        if (existing === undefined)
          fail(propLoc, `property ${key} is true but no base declares it`);
        continue;
      }
      const prop = schemaObject(value, propLoc);
      if (existing !== undefined && !sameJson(existing.schema, prop)) {
        fail(
          propLoc,
          `property ${key} is redeclared with another schema (first at ${where(existing.loc)})`,
        );
      }
      if (existing === undefined) props.set(key, { schema: prop, loc: propLoc });
    }
  }
  if (schema.required !== undefined) {
    arrayAt(schema.required, at(loc, "required")).forEach((key, i) => {
      if (typeof key !== "string") fail(at(loc, "required", i), "required keys must be strings");
      required.add(key);
    });
  }
}

function checkFragment(fragment: JsonObject, loc: Loc): void {
  only(fragment, loc, [
    "type",
    "properties",
    "required",
    "allOf",
    "if",
    "then",
    "else",
    "unevaluatedProperties",
  ]);
  if (fragment.type !== undefined && fragment.type !== "object")
    fail(at(loc, "type"), "expected type object");
}

function conditional(schema: JsonObject, loc: Loc): Conditional {
  only(schema, loc, [
    "type",
    "if",
    "then",
    "else",
    "properties",
    "required",
    "unevaluatedProperties",
    "allOf",
  ]);
  const branches: { schema: JsonObject; loc: Loc }[] = [];
  for (const key of ["then", "else"] as const) {
    if (schema[key] !== undefined)
      branches.push({ schema: schemaObject(schema[key], at(loc, key)), loc: at(loc, key) });
  }
  return { branches };
}

/**
 * Checks if/then properties exist on the object, and lifts array items that
 * only a then branch declares, like the commands of a batch per target kind.
 */
function liftItems(
  ctx: Ctx,
  name: string,
  conditionals: readonly Conditional[],
  props: ReadonlyMap<string, Prop>,
): Map<string, TypeExpr> {
  const items = new Map<string, Branch[]>();
  for (const { branches } of conditionals) {
    for (const branch of branches) {
      const own = branch.schema.properties;
      if (own === undefined) continue;
      for (const [key, value] of Object.entries(schemaObject(own, at(branch.loc, "properties")))) {
        const prop = props.get(key);
        const propLoc = at(branch.loc, "properties", key);
        if (prop === undefined)
          fail(propLoc, `conditional property ${key} is not declared on the object`);
        if (
          isObject(value) &&
          value.items !== undefined &&
          prop.schema.type === "array" &&
          prop.schema.items === undefined
        ) {
          const list = items.get(key) ?? [];
          list.push({ schema: value.items, loc: at(propLoc, "items") });
          items.set(key, list);
        }
      }
    }
  }
  const lifted = new Map<string, TypeExpr>();
  for (const [key, branches] of items) {
    const itemName = `${name}${pascal(key)}Item`;
    const [first] = branches;
    if (branches.length === 1 && first !== undefined) {
      lifted.set(key, typeOf(ctx, first.schema, first.loc, itemName));
      continue;
    }
    const loc = props.get(key)?.loc ?? { file: "", pointer: "" };
    const doc = `One item of ${key}.`;
    lifted.set(
      key,
      hoist(ctx, itemName, loc, () =>
        unionDecl(ctx, itemName, branches, loc, doc, undefined, true),
      ),
    );
  }
  return lifted;
}

/** Reads branches that only require keys, like `{ "properties": { "href": true }, "required": ["href"] }`. */
function requiredOnly(value: Json, loc: Loc, props: ReadonlyMap<string, Prop>): string[][] {
  return arrayAt(value, loc).map((entry, i) => {
    const branchLoc = at(loc, i);
    const branch = schemaObject(entry, branchLoc);
    checkKeywords(branch, branchLoc, false);
    only(branch, branchLoc, ["properties", "required"]);
    if (branch.properties !== undefined) {
      for (const [key, v] of Object.entries(
        schemaObject(branch.properties, at(branchLoc, "properties")),
      )) {
        if (v !== true)
          fail(at(branchLoc, "properties", key), "branch properties may only be true");
      }
    }
    const keys = arrayAt(branch.required, at(branchLoc, "required")).map((k, j) =>
      typeof k === "string" && props.has(k)
        ? k
        : fail(at(branchLoc, "required", j), "required key has no property"),
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
  if (keySchema.anyOf === undefined)
    return { key: keyType(ctx, keySchema, namesLoc, `${name}Key`), value };
  only(keySchema, namesLoc, ["type", "anyOf"]);
  // Named properties appear as consts, the remaining branch types the other keys.
  const others = arrayAt(keySchema.anyOf, at(namesLoc, "anyOf")).filter((branch, i) => {
    const branchLoc = at(namesLoc, "anyOf", i);
    if (!isObject(branch) || typeof branch.const !== "string") return true;
    if (!props.has(branch.const)) fail(branchLoc, `key ${branch.const} has no property schema`);
    return false;
  });
  const [other] = others;
  if (others.length !== 1 || other === undefined) {
    return fail(namesLoc, "propertyNames anyOf needs one non-const branch for the other keys");
  }
  return { key: keyType(ctx, other, namesLoc, `${name}Key`), value };
}

function unionDecl(
  ctx: Ctx,
  name: string,
  branches: readonly Branch[],
  loc: Loc,
  doc: string,
  source?: Source,
  shared = false,
): Decl {
  const base = { name, doc, path: where(loc), schema: ctx.file, source };
  const perBranch = branches.map((b) => leavesOf(ctx, b));
  const leaves = shared ? distinctLeaves(ctx, perBranch) : perBranch.flat();
  const tag = tagOf(ctx, leaves, loc);
  if (tag !== undefined) {
    const variants: TaggedVariant[] = leaves.map((leaf, i) => {
      const value = tag.values[i] ?? "";
      const type = typeOf(ctx, leaf.schema, leaf.loc, `${name}${pascal(value)}`);
      if (type.kind !== "ref") return fail(leaf.loc, "a tagged branch must be an object");
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
    if (seen.has(variant)) fail(branch.loc, `two branches of the union are both named ${variant}`);
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
    if (depth > 32) fail(loc, "$ref chain is too deep");
    const key = resolveRef(ctx.set, current.$ref, currentLoc);
    current = schemaAt(ctx.set, key);
    currentLoc = keyLoc(key);
  }
  return { schema: current, loc: currentLoc };
}

/** Branches of a union, with nested unions spread, for finding a shared tag. */
function leavesOf(ctx: Ctx, branch: Branch): Branch[] {
  const target = deref(ctx, branch.schema, branch.loc);
  const { oneOf } = target.schema;
  if (oneOf === undefined || target.schema.type !== undefined) return [branch];
  return arrayAt(oneOf, at(target.loc, "oneOf")).flatMap((b, i) =>
    leavesOf(ctx, { schema: b, loc: at(target.loc, "oneOf", i) }),
  );
}

/**
 * The leaves of `then` branches that list the same item union, like the commands an
 * order batch and a shipment batch share: a def an earlier branch already allows
 * gives no second variant. A def one branch lists twice is kept every time, so
 * the tag check still rejects it as the schema mistake it is.
 */
function distinctLeaves(ctx: Ctx, perBranch: readonly (readonly Branch[])[]): Branch[] {
  const earlier = new Set<string>();
  return perBranch.flatMap((leaves) => {
    const keys = leaves.map((leaf) => where(deref(ctx, leaf.schema, leaf.loc).loc));
    const repeated = (key: string): boolean => keys.indexOf(key) !== keys.lastIndexOf(key);
    const kept = leaves.filter((_, i) => {
      const key = keys[i] ?? "";
      return !earlier.has(key) || repeated(key);
    });
    for (const key of keys) earlier.add(key);
    return kept;
  });
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
    collect(ctx, s, target.loc, props, required, []);
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
    fail(loc, `branches carry the tag ${partial} only partly, or repeat its values`);
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
      throw new CodegenError(decl.path, `alias cycle through ${decl.name}`);
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
        throw new CodegenError(decl.path, `alias ${decl.name} contains itself`);
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
