/**
 * What the coverage report and the LLM projection of cases share: reading a case's JSON along the
 * model, as the decoders do. Values keep their spelling (`canonical.ts`'s tree), so a number like
 * `1.0` or `9223372036854775807` reads as the text it is.
 */

import { inFormat, PayloadGenerator } from "../payloads.js";
import type { Payload } from "../payloads.js";
import type { Decl, Model, StringType, TypeExpr } from "../model.js";
import type { Json } from "./canonical.js";
import { JsonNumber } from "./canonical.js";

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/;

/** The declarations of a model by name, and the structure check the payload generator uses. */
export class ModelWalk {
  readonly decls: ReadonlyMap<string, Decl>;
  readonly #generator: PayloadGenerator;

  constructor(readonly model: Model) {
    this.decls = new Map(model.decls.map((d) => [d.name, d]));
    this.#generator = new PayloadGenerator(model);
  }

  decl(name: string): Decl {
    const decl = this.decls.get(name);
    if (decl === undefined) throw new Error(`no type named ${name}`);
    return decl;
  }

  /** The type a reference names, through aliases that only refer to another type. */
  resolve(type: TypeExpr): TypeExpr | Decl {
    return type.kind === "ref" ? this.decl(type.name) : type;
  }

  /** True when the structure of `value` fits `type` in strict mode, as the decoders read it. */
  fits(type: TypeExpr, value: Json): boolean {
    return this.#generator.fits(type, toPayload(value));
  }

  /**
   * The code a string fails with as a value of `type`, its own constraints in the decoders'
   * order, or undefined when it holds. For map keys, which are checked before their values.
   */
  stringViolation(type: TypeExpr, text: string): string | undefined {
    if (type.kind === "ref") {
      const decl = this.decl(type.name);
      switch (decl.kind) {
        case "enum":
          if (decl.values.includes(text)) return undefined;
          return decl.values.length === 1 ? "not_const" : "not_in_enum";
        case "alias":
          return this.stringViolation(decl.type, text);
        case "id":
          return stringConstraint(decl.type, text);
        default:
          return undefined;
      }
    }
    return type.kind === "string" ? stringConstraint(type, text) : undefined;
  }
}

/** The first constraint of a string type a text breaks, in the decoders' order. */
export function stringConstraint(type: StringType, text: string): string | undefined {
  const length = [...text].length;
  if (type.minLength !== undefined && length < type.minLength) return "too_short";
  if (type.maxLength !== undefined && length > type.maxLength) return "too_long";
  if (type.match !== undefined && !new RegExp(type.match.regex, "u").test(text)) return "pattern_mismatch";
  if (type.format !== undefined && !inFormat(type.format, text)) return "bad_format";
  return undefined;
}

/**
 * A tree value as the payload generator holds it, for its structure check. A number spelled
 * with a fraction or an exponent isn't an integer to the decoders, so it becomes one that isn't,
 * and `-0` stays `-0`.
 */
export function toPayload(value: Json): Payload {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (value instanceof JsonNumber) {
    const n = Number(value.raw);
    if (INTEGER.test(value.raw)) return n;
    return Number.isInteger(n) ? n + 0.5 : n;
  }
  if (Array.isArray(value)) return value.map(toPayload);
  const out: { [key: string]: Payload } = {};
  for (const [k, v] of value) Object.defineProperty(out, k, { value: toPayload(v), writable: true, enumerable: true, configurable: true });
  return out;
}

/** A JSON Pointer segment. */
export function segment(s: string | number): string {
  return `/${String(s).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** Writes a tree value as JSON text, every number as it was spelled, keys in their order. */
export function writeJson(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof JsonNumber) return value.raw;
  if (Array.isArray(value)) return `[${value.map(writeJson).join(",")}]`;
  return `{${[...value].map(([k, v]) => `${JSON.stringify(k)}:${writeJson(v)}`).join(",")}}`;
}

/** How many arrays and objects the deepest value is inside, the value itself included. */
export function depth(value: Json): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (value instanceof Map) return 1 + Math.max(0, ...[...value.values()].map(depth));
  return 0;
}
