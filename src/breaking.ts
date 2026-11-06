/**
 * `strictgen breaking`: compares the schemas with an older version, a folder or a git ref, at the
 * model level, and says who each change breaks. Comparing models instead of raw JSON means a
 * change that leaves the JSON on the wire the same, like renaming a def or the name a hoisted
 * type gets, doesn't show. docs/breaking-changes.md has the full rule table.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { BuildOptions } from "./build.js";
import { buildModel } from "./build.js";
import type { Config } from "./config.js";
import { ConfigError, loadConfig, parseConfig } from "./config.js";
import type {
  Bounds,
  Decl,
  EnumDecl,
  Model,
  StructDecl,
  TaggedDecl,
  TypeExpr,
  UntaggedDecl,
} from "./model.js";
import type { Json, JsonObject, SchemaSet } from "./schema.js";
import { CodegenError, isObject, schemaSet } from "./schema.js";
import { loadSchemas } from "./schema-files.js";

/** Who a change breaks. A change that breaks nobody is safe. */
export type Impact = "all-consumers" | "strict-consumers" | "producers";

/** Impacts in the order output lists them. */
export const IMPACTS: readonly Impact[] = ["all-consumers", "strict-consumers", "producers"];

/** What changed. docs/breaking-changes.md lists who each kind breaks. */
export type ChangeKind =
  | "type-added"
  | "type-removed"
  | "type-changed"
  | "type-widened"
  | "type-narrowed"
  | "made-nullable"
  | "field-added"
  | "required-field-added"
  | "field-added-to-other-keys"
  | "field-removed"
  | "field-made-optional"
  | "field-made-required"
  | "other-keys-allowed"
  | "other-keys-removed"
  | "key-forbidden"
  | "key-allowed"
  | "enum-value-added"
  | "enum-value-removed"
  | "branch-added"
  | "branch-removed"
  | "branch-order-changed"
  | "constraint-tightened"
  | "constraint-loosened"
  | "constraint-changed";

/**
 * One change between the base and the current schemas. `base` and `current` are its locations,
 * like `order.json#/properties/total`, in each version. For something added, `base` is where it
 * would be in the base, the object or union that now holds it; for something removed, `current`
 * is that place in the current schemas. A location is `null` only when its whole schema file is
 * missing from that version.
 */
export interface Change {
  readonly kind: ChangeKind;
  readonly base: string | null;
  readonly current: string | null;
  /** What changed, in words, without generated type names. */
  readonly detail: string;
  /** Who it breaks, in {@link IMPACTS} order. Empty when it is safe. */
  readonly breaks: readonly Impact[];
}

/** Who each kind of change breaks, before the report-mode rule. */
export const BREAKS: Readonly<Record<ChangeKind, readonly Impact[]>> = {
  "type-added": [],
  "type-removed": ["all-consumers"],
  "type-changed": ["all-consumers", "producers"],
  "type-widened": ["all-consumers"],
  "type-narrowed": ["producers"],
  "made-nullable": ["all-consumers"],
  "field-added": ["strict-consumers"],
  "required-field-added": ["strict-consumers", "producers"],
  "field-added-to-other-keys": ["all-consumers"],
  "field-removed": ["all-consumers"],
  "field-made-optional": ["all-consumers"],
  "field-made-required": ["producers"],
  "other-keys-allowed": ["strict-consumers"],
  "other-keys-removed": ["producers"],
  "key-forbidden": ["producers"],
  "key-allowed": ["all-consumers"],
  "enum-value-added": ["all-consumers"],
  "enum-value-removed": ["producers"],
  "branch-added": ["all-consumers"],
  "branch-removed": ["producers"],
  "branch-order-changed": ["all-consumers"],
  "constraint-tightened": ["producers"],
  "constraint-loosened": ["all-consumers"],
  "constraint-changed": ["all-consumers", "producers"],
};

/** A compound declaration, which {@link Node}s compare by kind. */
type Compound = StructDecl | EnumDecl | TaggedDecl | UntaggedDecl;

/**
 * A type to compare: a compound declaration, or a plain type expression with refs to aliases and
 * ids followed, since those are the same JSON as the type they name. `at` is its schema location,
 * and `id` the name of the declaration it came from, which stops a recursive type from looping.
 */
type Node =
  | { readonly decl: Compound; readonly at: string; readonly id: string }
  | {
      readonly decl?: undefined;
      readonly expr: Exclude<TypeExpr, { kind: "ref" }>;
      readonly at: string;
      readonly id: string | undefined;
    };

/** A JSON pointer segment, escaped. */
function segment(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Names a node's kind of JSON, for messages. */
function describe(node: Node): string {
  if (node.decl !== undefined) {
    switch (node.decl.kind) {
      case "struct":
        return "object";
      case "enum":
        return node.decl.values.length === 1 ? "string constant" : "string enum";
      case "tagged":
        return `tagged union on ${quoted(node.decl.tag)}`;
      case "untagged":
        return "union";
    }
  }
  const expr = node.expr;
  switch (expr.kind) {
    case "any":
      return "any JSON value";
    case "nonNull":
      return "any non-null JSON value";
    case "literal":
      return `constant ${JSON.stringify(expr.value)}`;
    case "map":
      return "map";
    default:
      return expr.kind;
  }
}

/** A lower or upper bound, inclusive or not. */
interface Bound {
  readonly value: number;
  readonly exclusive: boolean;
}

function boundText(bound: Bound | undefined, lower: boolean): string {
  if (bound === undefined) return "none";
  return `${lower ? ">" : "<"}${bound.exclusive ? "" : "="} ${String(bound.value)}`;
}

/**
 * The tighter of an inclusive and an exclusive bound. Integer bounds are made inclusive whole
 * numbers, so `exclusiveMinimum: 4` and `minimum: 5` compare equal.
 */
function bound(
  inclusive: number | undefined,
  exclusive: number | undefined,
  lower: boolean,
  integer: boolean,
): Bound | undefined {
  const sign = lower ? 1 : -1;
  const candidates: Bound[] = [];
  if (inclusive !== undefined) {
    candidates.push(
      integer
        ? { value: lower ? Math.ceil(inclusive) : Math.floor(inclusive), exclusive: false }
        : { value: inclusive, exclusive: false },
    );
  }
  if (exclusive !== undefined) {
    candidates.push(
      integer
        ? { value: lower ? Math.floor(exclusive) + 1 : Math.ceil(exclusive) - 1, exclusive: false }
        : { value: exclusive, exclusive: true },
    );
  }
  let best: Bound | undefined;
  for (const c of candidates) {
    if (best === undefined || tighter(c, best, sign) > 0) best = c;
  }
  return best;
}

/** Positive when `a` is tighter than `b`, negative when looser, 0 when the same. */
function tighter(a: Bound, b: Bound, sign: number): number {
  if (a.value !== b.value) return (a.value - b.value) * sign > 0 ? 1 : -1;
  if (a.exclusive === b.exclusive) return 0;
  return a.exclusive ? 1 : -1;
}

/** Compares two models. The changes are sorted and each is listed once. */
export function diffModels(base: Model, current: Model): Change[] {
  return new Differ(base, current).run();
}

class Differ {
  private readonly changes = new Map<string, Change>();
  private readonly seen = new Set<string>();
  private readonly baseDecls: ReadonlyMap<string, Decl>;
  private readonly currentDecls: ReadonlyMap<string, Decl>;

  constructor(
    private readonly base: Model,
    private readonly current: Model,
  ) {
    this.baseDecls = new Map(base.decls.map((d) => [d.name, d]));
    this.currentDecls = new Map(current.decls.map((d) => [d.name, d]));
  }

  run(): Change[] {
    const entries = (model: Model): Map<string, Decl> =>
      new Map(
        model.decls.flatMap((d) =>
          d.source === undefined ? [] : [[`${d.source.schema}#${d.source.def ?? ""}`, d] as const],
        ),
      );
    const before = entries(this.base);
    const after = entries(this.current);
    const files = (model: Model): Set<string> => new Set(model.decls.map((d) => d.schema));
    const baseFiles = files(this.base);
    const currentFiles = files(this.current);
    const holder = (file: string, def: string | undefined, present: Set<string>): string | null =>
      present.has(file) ? (def === undefined ? `${file}.json#` : `${file}.json#/$defs`) : null;
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const was = before.get(key);
      const now = after.get(key);
      if (was !== undefined && now !== undefined) {
        this.compare(this.node(this.baseDecls, was), this.node(this.currentDecls, now));
      } else if (was !== undefined) {
        const def = was.source?.def;
        this.add("type-removed", was.path, holder(was.schema, def, currentFiles), "type removed");
      } else if (now !== undefined) {
        const def = now.source?.def;
        this.add("type-added", holder(now.schema, def, baseFiles), now.path, "type added");
      }
    }
    return [...this.changes.values()].sort(
      (a, b) =>
        order(a.current, b.current) ||
        order(a.base, b.base) ||
        order(a.kind, b.kind) ||
        order(a.detail, b.detail),
    );
  }

  private add(kind: ChangeKind, base: string | null, current: string | null, detail: string): void {
    const change: Change = { kind, base, current, detail, breaks: BREAKS[kind] };
    this.changes.set(JSON.stringify([kind, base, current, detail]), change);
  }

  /** The node a declaration stands for, following aliases and ids to the type they name. */
  private node(decls: ReadonlyMap<string, Decl>, decl: Decl): Node {
    switch (decl.kind) {
      case "alias":
      case "id":
        return this.exprNode(decls, decl.type, decl.path, decl.name, 0);
      default:
        return { decl, at: decl.path, id: decl.name };
    }
  }

  private exprNode(
    decls: ReadonlyMap<string, Decl>,
    expr: TypeExpr,
    at: string,
    id: string | undefined,
    depth: number,
  ): Node {
    if (expr.kind !== "ref") return { expr, at, id };
    const decl = decls.get(expr.name);
    if (decl === undefined || depth > decls.size) {
      throw new CodegenError(at, "internal", `unknown type ${expr.name} in the model`);
    }
    if (decl.kind === "alias" || decl.kind === "id") {
      return this.exprNode(decls, decl.type, decl.path, decl.name, depth + 1);
    }
    return { decl, at: decl.path, id: decl.name };
  }

  private baseNode(expr: TypeExpr, at: string): Node {
    return this.exprNode(this.baseDecls, expr, at, undefined, 0);
  }

  private currentNode(expr: TypeExpr, at: string): Node {
    return this.exprNode(this.currentDecls, expr, at, undefined, 0);
  }

  /** True when two nodes have no change between them, checked without recording anything. */
  private same(a: Node, b: Node): boolean {
    const probe = new Differ(this.base, this.current);
    probe.compare(a, b);
    return probe.changes.size === 0;
  }

  private compare(a: Node, b: Node): void {
    if (a.id !== undefined && b.id !== undefined) {
      const key = `${a.id}|${b.id}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    const aTop = a.decl === undefined ? a.expr.kind : undefined;
    const bTop = b.decl === undefined ? b.expr.kind : undefined;
    if (aTop === "any" && bTop === "any") return;
    if (aTop === "nonNull" && bTop === "nonNull") return;
    if (bTop === "any") {
      this.add("made-nullable", a.at, b.at, `${describe(a)} is now any JSON value, null included`);
      return;
    }
    if (aTop === "any") {
      this.add("type-narrowed", a.at, b.at, `any JSON value is now ${describe(b)}`);
      return;
    }
    if (bTop === "nonNull") {
      this.add("type-widened", a.at, b.at, `${describe(a)} is now any non-null JSON value`);
      return;
    }
    if (aTop === "nonNull") {
      this.add("type-narrowed", a.at, b.at, `any non-null JSON value is now ${describe(b)}`);
      return;
    }
    if (a.decl !== undefined && b.decl !== undefined && a.decl.kind === b.decl.kind) {
      this.compareDecls(a.decl, b.decl);
      return;
    }
    if (a.decl === undefined && b.decl === undefined) {
      this.compareExprs(a.expr, a.at, b.expr, b.at);
      return;
    }
    this.add("type-changed", a.at, b.at, `type changed from ${describe(a)} to ${describe(b)}`);
  }

  private compareDecls(a: Compound, b: Compound): void {
    if (a.kind === "struct" && b.kind === "struct") this.compareStructs(a, b);
    else if (a.kind === "enum" && b.kind === "enum") this.compareEnums(a, b);
    else if (a.kind === "tagged" && b.kind === "tagged") this.compareTagged(a, b);
    else if (a.kind === "untagged" && b.kind === "untagged") this.compareUntagged(a, b);
  }

  private compareStructs(a: StructDecl, b: StructDecl): void {
    // StructDecl.closed is skipped on purpose: it isn't on the wire, `rest` and the fields are.
    const before = new Map(a.fields.map((f) => [f.name, f]));
    const after = new Map(b.fields.map((f) => [f.name, f]));
    const names = [...new Set([...before.keys(), ...after.keys()])].sort();
    for (const name of names) {
      const was = before.get(name);
      const now = after.get(name);
      const aAt = `${a.path}/properties/${segment(name)}`;
      const bAt = `${b.path}/properties/${segment(name)}`;
      if (was === undefined && now !== undefined) {
        const which = now.required ? "required" : "optional";
        if (a.rest !== undefined) {
          // An old consumer of an object with other keys reads the new field as one of them.
          this.add(
            "field-added-to-other-keys",
            a.path,
            bAt,
            `${which} field ${quoted(name)} added, which old consumers read as one of the other keys`,
          );
          if (now.required) {
            this.add("field-made-required", a.path, bAt, `field ${quoted(name)} is required`);
          }
        } else if (now.required) {
          this.add("required-field-added", a.path, bAt, `required field ${quoted(name)} added`);
        } else {
          this.add("field-added", a.path, bAt, `optional field ${quoted(name)} added`);
        }
        continue;
      }
      if (now === undefined && was !== undefined) {
        this.add("field-removed", aAt, b.path, `field ${quoted(name)} removed`);
        continue;
      }
      if (was === undefined || now === undefined) continue;
      if (was.required && !now.required) {
        this.add("field-made-optional", aAt, bAt, `field ${quoted(name)} is now optional`);
      } else if (!was.required && now.required) {
        this.add("field-made-required", aAt, bAt, `field ${quoted(name)} is now required`);
      }
      this.compare(this.baseNode(was.type, aAt), this.currentNode(now.type, bAt));
    }
    for (const key of [...new Set([...a.forbidden, ...b.forbidden])].sort()) {
      if (!a.forbidden.includes(key)) {
        this.add("key-forbidden", a.path, b.path, `key ${quoted(key)} is now forbidden`);
      } else if (!b.forbidden.includes(key)) {
        this.add("key-allowed", a.path, b.path, `key ${quoted(key)} is no longer forbidden`);
      }
    }
    if (a.rest === undefined && b.rest !== undefined) {
      this.add("other-keys-allowed", a.path, b.path, "object now accepts other keys");
    } else if (a.rest !== undefined && b.rest === undefined) {
      this.add("other-keys-removed", a.path, b.path, "object no longer accepts other keys");
    } else if (a.rest !== undefined && b.rest !== undefined) {
      const aKey = `${a.path}/propertyNames`;
      const bKey = `${b.path}/propertyNames`;
      this.compare(this.baseNode(a.rest.key, aKey), this.currentNode(b.rest.key, bKey));
      const aValue = `${a.path}/additionalProperties`;
      const bValue = `${b.path}/additionalProperties`;
      this.compare(this.baseNode(a.rest.value, aValue), this.currentNode(b.rest.value, bValue));
    }
  }

  private compareEnums(a: EnumDecl, b: EnumDecl): void {
    for (const value of [...new Set([...a.values, ...b.values])].sort(order)) {
      if (!a.values.includes(value)) {
        this.add("enum-value-added", a.path, b.path, `value ${quoted(value)} added`);
      } else if (!b.values.includes(value)) {
        this.add("enum-value-removed", a.path, b.path, `value ${quoted(value)} removed`);
      }
    }
  }

  private compareTagged(a: TaggedDecl, b: TaggedDecl): void {
    if (a.tag !== b.tag) {
      this.add(
        "type-changed",
        a.path,
        b.path,
        `tag changed from ${quoted(a.tag)} to ${quoted(b.tag)}`,
      );
      return;
    }
    const before = new Map(a.variants.map((v) => [v.value, v]));
    const after = new Map(b.variants.map((v) => [v.value, v]));
    for (const value of [...new Set([...before.keys(), ...after.keys()])].sort(order)) {
      const was = before.get(value);
      const now = after.get(value);
      if (was !== undefined && now !== undefined) {
        const aNode = this.baseNode({ kind: "ref", name: was.type }, a.path);
        const bNode = this.currentNode({ kind: "ref", name: now.type }, b.path);
        this.compare(aNode, bNode);
      } else if (now !== undefined) {
        const at = this.currentNode({ kind: "ref", name: now.type }, b.path).at;
        this.add("branch-added", a.path, at, `branch ${quoted(a.tag)}: ${quoted(value)} added`);
      } else if (was !== undefined) {
        const at = this.baseNode({ kind: "ref", name: was.type }, a.path).at;
        this.add("branch-removed", at, b.path, `branch ${quoted(a.tag)}: ${quoted(value)} removed`);
      }
    }
  }

  /**
   * Untagged branches have generated names, so they pair up by content: first the branches that
   * didn't change, then the ones left of each kind, in order, when each side has as many of that
   * kind, which are compared like any type. The rest are added or removed. Decoders try branches in order, so a
   * new order of the paired branches is a change too.
   */
  private compareUntagged(a: UntaggedDecl, b: UntaggedDecl): void {
    const before = a.variants.map((v) => this.baseNode(v.type, a.path));
    const after = b.variants.map((v) => this.currentNode(v.type, b.path));
    const pairs = new Map<number, number>();
    const taken = new Set<number>();
    for (const [j, now] of after.entries()) {
      const i = before.findIndex((was, k) => !taken.has(k) && this.same(was, now));
      if (i !== -1) {
        pairs.set(j, i);
        taken.add(i);
      }
    }
    const kindOf = (node: Node): string => (node.decl === undefined ? node.expr.kind : node.decl.kind);
    const leftBefore = before.flatMap((n, i) => (taken.has(i) ? [] : [{ n, i }]));
    const leftAfter = after.flatMap((n, j) => (pairs.has(j) ? [] : [{ n, j }]));
    for (const { n, j } of leftAfter) {
      const kind = kindOf(n);
      const olds = leftBefore.filter((o) => kindOf(o.n) === kind);
      const news = leftAfter.filter((o) => kindOf(o.n) === kind);
      const old = olds[news.findIndex((o) => o.j === j)];
      if (olds.length === news.length && old !== undefined) {
        pairs.set(j, old.i);
        taken.add(old.i);
        this.compare(old.n, n);
      }
    }
    for (const [j, now] of after.entries()) {
      if (!pairs.has(j)) {
        this.add("branch-added", a.path, now.at, `branch added: ${describe(now)}`);
      }
    }
    for (const [i, was] of before.entries()) {
      if (!taken.has(i)) {
        this.add("branch-removed", was.at, b.path, `branch removed: ${describe(was)}`);
      }
    }
    const kept = [...pairs.entries()].sort(([x], [y]) => x - y).map(([, i]) => i);
    if (kept.some((i, k) => k > 0 && i < (kept[k - 1] ?? i))) {
      this.add("branch-order-changed", a.path, b.path, "the order decoders try branches in changed");
    }
  }

  private compareExprs(
    a: Exclude<TypeExpr, { kind: "ref" }>,
    aAt: string,
    b: Exclude<TypeExpr, { kind: "ref" }>,
    bAt: string,
  ): void {
    const limit = (name: string, was: number | undefined, now: number | undefined, lower: boolean) =>
      this.limit(aAt, bAt, name, was, now, lower);
    if (a.kind === "integer" && b.kind === "number") {
      this.add("type-widened", aAt, bAt, "integer is now number");
      this.bounds(aAt, bAt, a, b, false);
      return;
    }
    if (a.kind === "number" && b.kind === "integer") {
      this.add("type-narrowed", aAt, bAt, "number is now integer");
      this.bounds(aAt, bAt, a, b, false);
      return;
    }
    if (a.kind === "string" && b.kind === "string") {
      limit("minLength", a.minLength, b.minLength, true);
      limit("maxLength", a.maxLength, b.maxLength, false);
      const was = a.match;
      const now = b.match;
      if (was === undefined && now !== undefined) {
        this.add("constraint-tightened", aAt, bAt, `pattern ${quoted(now.source)} added`);
      } else if (was !== undefined && now === undefined) {
        this.add("constraint-loosened", aAt, bAt, `pattern ${quoted(was.source)} removed`);
      } else if (was !== undefined && now !== undefined && was.regex !== now.regex) {
        this.add(
          "constraint-changed",
          aAt,
          bAt,
          `pattern changed from ${quoted(was.source)} to ${quoted(now.source)}, which can't be compared`,
        );
      }
      if (a.format === undefined && b.format !== undefined) {
        this.add("constraint-tightened", aAt, bAt, `format ${quoted(b.format)} added`);
      } else if (a.format !== undefined && b.format === undefined) {
        this.add("constraint-loosened", aAt, bAt, `format ${quoted(a.format)} removed`);
      } else if (a.format !== undefined && b.format !== undefined && a.format !== b.format) {
        this.add(
          "constraint-changed",
          aAt,
          bAt,
          `format changed from ${quoted(a.format)} to ${quoted(b.format)}`,
        );
      }
      return;
    }
    if (a.kind === "integer" && b.kind === "integer") {
      this.bounds(aAt, bAt, a, b, true);
      this.multipleOf(aAt, bAt, a.multipleOf, b.multipleOf);
      return;
    }
    if (a.kind === "number" && b.kind === "number") {
      this.bounds(aAt, bAt, a, b, false);
      return;
    }
    if (a.kind === "boolean" && b.kind === "boolean") return;
    if (a.kind === "literal" && b.kind === "literal") {
      if (a.value !== b.value) {
        const text = `constant changed from ${JSON.stringify(a.value)} to ${JSON.stringify(b.value)}`;
        this.add("type-changed", aAt, bAt, text);
      }
      return;
    }
    if (a.kind === "array" && b.kind === "array") {
      limit("minItems", a.minItems, b.minItems, true);
      limit("maxItems", a.maxItems, b.maxItems, false);
      if (a.uniqueItems === undefined && b.uniqueItems !== undefined) {
        this.add("constraint-tightened", aAt, bAt, "uniqueItems added");
      } else if (a.uniqueItems !== undefined && b.uniqueItems === undefined) {
        this.add("constraint-loosened", aAt, bAt, "uniqueItems removed");
      }
      this.compare(this.baseNode(a.items, `${aAt}/items`), this.currentNode(b.items, `${bAt}/items`));
      return;
    }
    if (a.kind === "map" && b.kind === "map") {
      limit("minProperties", a.minProperties, b.minProperties, true);
      limit("maxProperties", a.maxProperties, b.maxProperties, false);
      const aKey = `${aAt}/propertyNames`;
      const bKey = `${bAt}/propertyNames`;
      this.compare(this.baseNode(a.key, aKey), this.currentNode(b.key, bKey));
      const aValue = `${aAt}/additionalProperties`;
      const bValue = `${bAt}/additionalProperties`;
      this.compare(this.baseNode(a.value, aValue), this.currentNode(b.value, bValue));
      return;
    }
    const was = describe({ expr: a, at: aAt, id: undefined });
    const now = describe({ expr: b, at: bAt, id: undefined });
    this.add("type-changed", aAt, bAt, `type changed from ${was} to ${now}`);
  }

  /** A count limit, like `minLength`: a higher minimum or a lower maximum is tighter. */
  private limit(
    aAt: string,
    bAt: string,
    name: string,
    was: number | undefined,
    now: number | undefined,
    lower: boolean,
  ): void {
    if (was === now) return;
    const text = `${name} ${shownLimit(was)} -> ${shownLimit(now)}`;
    const tightened =
      was === undefined || (now !== undefined && (lower ? now > was : now < was));
    this.add(tightened ? "constraint-tightened" : "constraint-loosened", aAt, bAt, text);
  }

  private bounds(aAt: string, bAt: string, a: Bounds, b: Bounds, integer: boolean): void {
    for (const lower of [true, false]) {
      const pick = (x: Bounds): Bound | undefined =>
        lower
          ? bound(x.minimum, x.exclusiveMinimum, true, integer)
          : bound(x.maximum, x.exclusiveMaximum, false, integer);
      const was = pick(a);
      const now = pick(b);
      if (was === undefined && now === undefined) continue;
      const side = lower ? "lower bound" : "upper bound";
      const text = `${side} ${boundText(was, lower)} -> ${boundText(now, lower)}`;
      if (was === undefined) this.add("constraint-tightened", aAt, bAt, text);
      else if (now === undefined) this.add("constraint-loosened", aAt, bAt, text);
      else {
        const t = tighter(now, was, lower ? 1 : -1);
        if (t > 0) this.add("constraint-tightened", aAt, bAt, text);
        else if (t < 0) this.add("constraint-loosened", aAt, bAt, text);
      }
    }
  }

  /** A multiple of the old `multipleOf` is tighter, a divisor of it looser; anything else both. */
  private multipleOf(
    aAt: string,
    bAt: string,
    was: number | undefined,
    now: number | undefined,
  ): void {
    if (was === now) return;
    const text = `multipleOf ${shownLimit(was)} -> ${shownLimit(now)}`;
    if (was === undefined || (now !== undefined && now % was === 0)) {
      this.add("constraint-tightened", aAt, bAt, text);
    } else if (now === undefined || was % now === 0) {
      this.add("constraint-loosened", aAt, bAt, text);
    } else {
      this.add("constraint-changed", aAt, bAt, text);
    }
  }
}

function shownLimit(value: number | undefined): string {
  return value === undefined ? "none" : String(value);
}

/** Code-unit order, the same on every machine, with `null` first. */
function order(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * Applies the report-mode rule: when every configured target reads in report mode, no consumer is
 * strict, so changes that only break strict consumers, like an added optional field, are safe.
 */
export function classify(changes: readonly Change[], everyTargetReports: boolean): Change[] {
  if (!everyTargetReports) return [...changes];
  return changes.map((c) => ({ ...c, breaks: c.breaks.filter((i) => i !== "strict-consumers") }));
}

/** True when the config lists at least one target and every one reads in report mode. */
export function everyTargetReports(config: Config): boolean {
  const modes = Object.values(config.targets).map((t: { read: string }) => t.read);
  return modes.length > 0 && modes.every((m) => m === "report");
}

/**
 * A problem with the base, as one line. `exit` is 2 when the base can't be loaded, like a ref that
 * doesn't exist or a base schema that can't be read or mapped, so CI can tell it from a breaking
 * change, which exits 1.
 */
export class BreakingError extends Error {
  constructor(
    message: string,
    readonly exit: 1 | 2,
  ) {
    super(message);
    this.name = "BreakingError";
  }
}

/** One version of the schemas, ready to build. */
interface Version {
  readonly schemas: SchemaSet;
  readonly options: BuildOptions;
  /** Where the schemas were read from, for messages. */
  readonly where: string;
}

function buildOptions(config: Config): BuildOptions {
  return {
    ...(config.ids === undefined ? {} : { ids: config.ids }),
    validation: config.validation,
  };
}

function currentVersion(config: Config): Version {
  const schemas = loadSchemas(
    config.schemas,
    config.idBase === undefined ? {} : { idBase: config.idBase },
  );
  return { schemas, options: buildOptions(config), where: config.schemas };
}

/** Runs `fn` on the base, naming the base in any schema or config error it throws. */
function onBase<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof CodegenError) throw new BreakingError(`base ${label}: ${error.message}`, 2);
    if (error instanceof ConfigError) throw new BreakingError(`base ${label}: ${error.message}`, 2);
    throw error;
  }
}

/**
 * The base from a folder: a project folder when it holds a config file named like the current
 * one, whose schemas folder and options are used; otherwise a schemas folder, read with the
 * current options and the `$id` base its own schemas share.
 */
function folderVersion(config: Config, dir: string, label: string): Version {
  return onBase(label, () => {
    const file = join(dir, basename(config.file));
    if (existsSync(file)) {
      const base = loadConfig(file, dir);
      return currentVersion(base);
    }
    return { schemas: loadSchemas(dir), options: buildOptions(config), where: dir };
  });
}

const GIT_TIMEOUT = 60_000;

interface GitResult {
  readonly stdout: Buffer | undefined;
  /** The first line git wrote to stderr, or "" when it wrote nothing. */
  readonly stderr: string;
}

/** Runs git in `cwd`, returning stdout, or undefined when it exits non-zero. */
function git(env: NodeJS.ProcessEnv, cwd: string, args: readonly string[]): Buffer | undefined {
  return gitResult(env, cwd, args).stdout;
}

function gitResult(env: NodeJS.ProcessEnv, cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    env,
    timeout: GIT_TIMEOUT,
    maxBuffer: 1 << 30,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    throw new BreakingError(
      code === "ENOENT"
        ? "git is not installed, so --base can only name a folder"
        : `git failed: ${result.error.message}`,
      2,
    );
  }
  const stderr = result.stderr.toString("utf8").split("\n")[0]?.trim() ?? "";
  return { stdout: result.status === 0 ? result.stdout : undefined, stderr };
}

/** ` (git: <first stderr line>)`, or "" when git said nothing. */
function said(stderr: string): string {
  return stderr === "" ? "" : ` (git: ${stderr})`;
}

/** A path inside the repository, with `/` separators, or undefined when it is outside. */
function inRepo(top: string, path: string): string | undefined {
  const rel = relative(real(top), real(path)).split(sep).join("/");
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return undefined;
  return rel;
}

/**
 * `path` with symbolic links resolved in the part of it that exists, like `/var` to
 * `/private/var` on macOS, so it compares with the folder git names.
 */
function real(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.push(basename(at));
      at = parent;
    }
  }
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
  readonly path: string;
}

/** The entries `git ls-tree -z` lists for `path` at `commit`. */
function lsTree(env: NodeJS.ProcessEnv, top: string, commit: string, path: string): TreeEntry[] {
  const out = git(env, top, ["ls-tree", "-z", commit, "--", path === "" ? "." : path]);
  if (out === undefined) throw new BreakingError(`git ls-tree failed for ${path}`, 2);
  return out
    .toString("utf8")
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", object = ""] = line.slice(0, tab).split(" ");
      return { mode, type, object, path: line.slice(tab + 1) };
    });
}

function blob(env: NodeJS.ProcessEnv, top: string, object: string, shown: string): string {
  const out = git(env, top, ["cat-file", "blob", object]);
  if (out === undefined) throw new BreakingError(`can't read ${shown} from git`, 2);
  return out.toString("utf8");
}

/**
 * The base from a git ref, read with `git ls-tree` and `git cat-file`, so nothing is checked out
 * or written. The config file at the ref, at the same path as the current one, gives the schemas
 * folder and options; without one, the current config's schemas folder and options are used.
 */
function gitVersion(config: Config, ref: string, env: NodeJS.ProcessEnv): Version {
  if (ref.startsWith("-")) throw new BreakingError(`--base ${quoted(ref)} is not a git ref`, 2);
  const topRun = gitResult(env, config.root, ["rev-parse", "--show-toplevel"]);
  const topOut = topRun.stdout;
  if (topOut === undefined) {
    throw new BreakingError(
      `--base ${quoted(ref)} is not a folder, and ${config.root} is not in a git repository` +
        said(topRun.stderr),
      2,
    );
  }
  const top = topOut.toString("utf8").trim();
  const commitRun = gitResult(env, top, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const commitOut = commitRun.stdout;
  if (commitOut === undefined) {
    throw new BreakingError(
      `--base ${quoted(ref)} is neither a folder nor a git ref${said(commitRun.stderr)}. ` +
        "If it is a ref, fetch it first (in CI, check out with fetch-depth: 0)",
      2,
    );
  }
  const commit = commitOut.toString("utf8").trim();
  const label = ref;
  const configPath = inRepo(top, config.file);
  return onBase(label, () => {
    let base = config;
    let fromConfig = false;
    if (configPath !== undefined) {
      const entry = lsTree(env, top, commit, configPath).find((e) => e.path === configPath);
      if (entry !== undefined && entry.type === "blob") {
        const shown = `${ref}:${configPath}`;
        let value: unknown;
        try {
          value = JSON.parse(blob(env, top, entry.object, shown));
        } catch (error) {
          if (error instanceof BreakingError) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          throw new ConfigError(shown, "", `not valid JSON: ${reason}`);
        }
        base = parseConfig(value, join(top, ...configPath.split("/")), shown);
        fromConfig = true;
      }
    }
    const folder = inRepo(top, base.schemas);
    if (folder === undefined) {
      throw new BreakingError(
        `base ${label}: the schemas folder ${base.schemas} is outside the repository`,
        2,
      );
    }
    const prefix = folder === "" ? "" : `${folder}/`;
    const entries = folder === "" ? lsTree(env, top, commit, "") : lsTree(env, top, commit, prefix);
    const isTree = (e: TreeEntry): boolean => e.path === folder && e.type === "tree";
    if (folder !== "" && !lsTree(env, top, commit, folder).some(isTree)) {
      throw new BreakingError(`base ${label}: there is no schemas folder ${folder} at this ref`, 2);
    }
    const files: Record<string, JsonObject> = {};
    for (const entry of entries) {
      const name = entry.path.slice(prefix.length);
      if (entry.type !== "blob" || !name.endsWith(".json") || name.includes("/")) continue;
      const shown = name;
      if (entry.mode === "120000") {
        throw new CodegenError(shown, "read-failed", "a symbolic link in git can't be read as a schema");
      }
      let parsed: Json;
      try {
        parsed = JSON.parse(blob(env, top, entry.object, `${ref}:${entry.path}`)) as Json;
      } catch (error) {
        if (error instanceof BreakingError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        throw new CodegenError(shown, "invalid-json", `not valid JSON: ${reason}`);
      }
      if (!isObject(parsed)) throw new CodegenError(shown, "invalid-schema", "schema is not an object");
      files[name.slice(0, -5)] = parsed;
    }
    const idBase = fromConfig ? base.idBase : undefined;
    return {
      schemas: schemaSet(files, idBase === undefined ? {} : { idBase }),
      options: buildOptions(fromConfig ? base : config),
      where: `${ref}:${folder === "" ? "." : folder}`,
    };
  });
}

/** The result of comparing the schemas with a base. */
export interface Breaking {
  /** The `--base` argument. */
  readonly base: string;
  /** True when every configured target reads in report mode, so no consumer is strict. */
  readonly everyTargetReports: boolean;
  readonly changes: readonly Change[];
}

/**
 * Compares the config's schemas with `base`, a folder (when one exists at that path, relative to
 * `cwd`) or a git ref in the repository that holds the config. Throws a {@link BreakingError} for
 * a base that can't be read and a {@link CodegenError} for current schemas that can't be mapped.
 */
export function breaking(
  config: Config,
  base: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (line: string) => void = () => undefined,
): Breaking {
  const current = currentVersion(config);
  const currentModel = buildModel(current.schemas, current.options);
  const dir = resolve(cwd, base);
  const isDir = base !== "" && existsSync(dir) && statSync(dir).isDirectory();
  if (isDir && isRef(config, base, env)) {
    warn(`warning: --base ${quoted(base)} is both a folder and a git ref; comparing with the folder`);
  }
  const version = isDir ? folderVersion(config, dir, base) : gitVersion(config, base, env);
  if (version.schemas.length === 0) {
    throw new BreakingError(`base ${base}: no schema files in ${version.where}`, 2);
  }
  const baseModel = onBase(base, () => buildModel(version.schemas, version.options));
  if (baseModel.decls.length === 0) {
    throw new BreakingError(`base ${base}: the schemas in ${version.where} declare no types`, 2);
  }
  const reports = everyTargetReports(config);
  const changes = classify(diffModels(baseModel, currentModel), reports);
  return { base, everyTargetReports: reports, changes };
}

/** True when `ref` names a commit in the repository that holds the config. Never throws. */
function isRef(config: Config, ref: string, env: NodeJS.ProcessEnv): boolean {
  if (ref.startsWith("-")) return false;
  try {
    const args = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
    return git(env, config.root, args) !== undefined;
  } catch {
    return false;
  }
}

/** True when any change breaks someone, which makes `strictgen breaking` exit 1. */
export function breaksAnything(result: Breaking): boolean {
  return result.changes.some((c) => c.breaks.length > 0);
}

const HEADINGS: Readonly<Record<Impact | "safe", string>> = {
  "all-consumers": "Breaks all consumers",
  "strict-consumers": "Breaks strict consumers",
  producers: "Breaks producers",
  safe: "Safe",
};

/** The text form: one group per impact, then the safe changes, then a summary line. */
export function breakingLines(result: Breaking): string[] {
  const lines: string[] = [];
  const groups: (Impact | "safe")[] = [...IMPACTS, "safe"];
  for (const group of groups) {
    const members = result.changes.filter((c) =>
      group === "safe" ? c.breaks.length === 0 : c.breaks.includes(group),
    );
    if (members.length === 0) continue;
    if (lines.length > 0) lines.push("");
    lines.push(`${HEADINGS[group]}:`);
    for (const c of members) {
      lines.push(`  ${c.detail}`);
      lines.push(`    base:    ${c.base ?? "(no such file)"}`);
      lines.push(`    current: ${c.current ?? "(no such file)"}`);
    }
  }
  const broken = result.changes.filter((c) => c.breaks.length > 0).length;
  const safe = result.changes.length - broken;
  if (lines.length > 0) lines.push("");
  const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
  lines.push(
    result.changes.length === 0
      ? `No changes since ${result.base}.`
      : `${plural(broken, "breaking change")} and ${plural(safe, "safe change")} since ${result.base}.`,
  );
  if (result.everyTargetReports) {
    lines.push("Every target reads in report mode, so changes that only break strict consumers are safe.");
  }
  return lines;
}

/** The `--json` form, documented in docs/breaking-changes.md. */
export function breakingJson(result: Breaking): object {
  return {
    base: result.base,
    breaking: breaksAnything(result),
    everyTargetReports: result.everyTargetReports,
    changes: result.changes.map((c) => ({
      kind: c.kind,
      breaks: c.breaks,
      base: c.base,
      current: c.current,
      detail: c.detail,
    })),
  };
}

