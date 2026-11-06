/**
 * The constraint checks every decoder runs, and the one order they run in, so Rust, Go and
 * TypeScript report the same first error. docs/error-codes.md describes the same rules for users.
 *
 * Structure comes first: a value whose structure doesn't fit its type (a wrong type, a missing
 * or unknown key, a bad tag) fails with that error, wherever it is, and no constraint is
 * checked. Only a value that decodes in full is checked, by one walk over it:
 *
 * - a value's own constraints come before the values inside it
 * - a struct's fields in schema order, then the keys of its rest map
 * - an array's items by index
 * - a map's keys in code point order, which is the byte order of their UTF-8, each key's own
 *   constraints before its value's
 * - a union's checks are those of the branch that decoded. Constraints never pick the branch
 *
 * A value's own constraints run in this order: `minLength`, `maxLength` for strings, counted in
 * code points; `minimum`, `exclusiveMinimum`, `maximum`, `exclusiveMaximum`, `multipleOf` for
 * integers and numbers; `minItems`, `maxItems` for arrays; `minProperties`, `maxProperties` for
 * maps. The walk stops at the first one that fails.
 */
import { numberText } from "./errors.js";
import type { Decl, IntegerType, NumberType, TypeExpr } from "./model.js";

/** One numeric check: the operator, the bound and the bound as errors show it. */
export interface Limit {
  /** `>=`, `>`, `<=` and `<` compare with the bound, `%` checks for a multiple of it. */
  readonly op: ">=" | ">" | "<=" | "<" | "%";
  readonly bound: number;
  readonly text: string;
}

/** The numeric checks of an integer or a number, in check order. */
export function limitsOf(type: IntegerType | NumberType): Limit[] {
  const out: Limit[] = [];
  const push = (op: Limit["op"], bound: number | undefined): void => {
    if (bound !== undefined) out.push({ op, bound, text: numberText(bound) });
  };
  push(">=", type.minimum);
  push(">", type.exclusiveMinimum);
  push("<=", type.maximum);
  push("<", type.exclusiveMaximum);
  if (type.kind === "integer") push("%", type.multipleOf);
  return out;
}

/** True when the type itself has a constraint to check, not counting the types inside it. */
export function hasOwnChecks(type: TypeExpr): boolean {
  switch (type.kind) {
    case "string":
      return type.minLength !== undefined || type.maxLength !== undefined;
    case "integer":
    case "number":
      return limitsOf(type).length > 0;
    case "array":
      return type.minItems !== undefined || type.maxItems !== undefined;
    case "map":
      return type.minProperties !== undefined || type.maxProperties !== undefined;
    default:
      return false;
  }
}

/**
 * Which values have constraints to check, inside them included. Emitters write a check only
 * where one of these says there is something to check, so a schema without constraints gets
 * the same code as before validation existed.
 */
export class Checks {
  readonly #decls: ReadonlyMap<string, Decl>;
  /** The declarations whose values hold a constraint somewhere. */
  readonly #checked = new Set<string>();

  constructor(decls: Iterable<Decl>) {
    this.#decls = new Map([...decls].map((d) => [d.name, d]));
    // A least fixed point, so types that hold themselves are settled too.
    for (let changed = true; changed; ) {
      changed = false;
      for (const decl of this.#decls.values()) {
        if (!this.#checked.has(decl.name) && this.#declHas(decl)) {
          this.#checked.add(decl.name);
          changed = true;
        }
      }
    }
  }

  /** True when a value of the declaration named `name` has a constraint to check. */
  decl(name: string): boolean {
    return this.#checked.has(name);
  }

  /** True when a value of `type` has a constraint to check, itself or inside it. */
  type(type: TypeExpr): boolean {
    if (hasOwnChecks(type)) return true;
    switch (type.kind) {
      case "ref":
        return this.#checked.has(type.name);
      case "array":
        return this.type(type.items);
      case "map":
        return this.type(type.key) || this.type(type.value);
      default:
        return false;
    }
  }

  /**
   * True for an alias that Rust and Go generate as a type of its own: one with constraints to
   * check that stands for a type that can't check them, like a list of codes or a string with
   * a length range. The type of its own carries the check, so the standard entry points, Rust's
   * `from_json` and Go's `json.Unmarshal`, run it. An alias of another declaration stays an
   * alias, since that declaration checks itself.
   */
  ownType(decl: Decl): boolean {
    return decl.kind === "alias" && decl.type.kind !== "ref" && this.#checked.has(decl.name);
  }

  /** True when any declaration has a constraint to check. */
  any(): boolean {
    return this.#checked.size > 0;
  }

  #declHas(decl: Decl): boolean {
    switch (decl.kind) {
      case "struct":
        return (
          decl.fields.some((f) => this.type(f.type)) ||
          (decl.rest !== undefined && (this.type(decl.rest.key) || this.type(decl.rest.value)))
        );
      case "tagged":
        return decl.variants.some((v) => this.#checked.has(v.type));
      case "untagged":
        return decl.variants.some((v) => this.type(v.type));
      case "alias":
        return this.type(decl.type);
      case "id":
        return hasOwnChecks(decl.type);
      case "enum":
        return false;
    }
  }
}
