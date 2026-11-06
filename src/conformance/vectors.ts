/**
 * The shared vectors of `examples/llm` as conformance cases, so the run holds every language to
 * them in the generated code of report mode too, beside the strict mode the example's own tests
 * run:
 *
 * - `llm-vectors.json`: payloads for the LLM decoders. A valid one must decode to the value its
 *   `json` decodes to with the normal decoder, compared by canonical bytes, and that `json` must
 *   decode too; an invalid one must fail with its `error`, the compact form of the first error
 * - `cleanup-vectors.json`: inputs of the cleanup step and the exact text it must return
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ERROR_CODES } from "../errors.js";
import type { Case, Outcome } from "./cases.js";
import { LayoutError } from "./cases.js";

const ACCEPTED: Outcome = { accepted: true, unknown: [] };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** True when the text has a UTF-16 surrogate without its pair, which has no UTF-8 form. */
function loneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    }
  }
  return false;
}

function readList(file: string, shown: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new LayoutError([`${shown}: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`]);
  }
  if (!Array.isArray(value) || value.length === 0) throw new LayoutError([`${shown}: expected a list of vectors`]);
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The path and code of an error's compact form, `<path> <code>, expected ..., found ...` or
 * `<code>...` at the root, or undefined when it isn't one.
 */
export function parseCompact(compact: string): { path: string; code: string } | undefined {
  const ends = (rest: string): boolean => rest === "" || rest.startsWith(", ");
  for (const { code } of ERROR_CODES) {
    if (compact.startsWith(code) && ends(compact.slice(code.length))) return { path: "", code };
  }
  if (!compact.startsWith("/")) return undefined;
  // The path ends at the first space followed by a code: a key may hold a space, but the run
  // compares the whole compact form too, so a wrong split can't pass.
  for (let i = compact.indexOf(" "); i >= 0; i = compact.indexOf(" ", i + 1)) {
    const rest = compact.slice(i + 1);
    for (const { code } of ERROR_CODES) {
      if (rest.startsWith(code) && ends(rest.slice(code.length))) return { path: compact.slice(0, i), code };
    }
  }
  return undefined;
}

/** The compact form of an error's fields, as every language writes it. */
export function compactOf(error: { path: string; code: string; expected: string | null; found: string | null }): string {
  return `${error.path === "" ? "" : `${error.path} `}${error.code}${error.expected === null ? "" : `, expected ${error.expected}`}${
    error.found === null ? "" : `, found ${error.found}`
  }`;
}

/** The cases of the shared LLM vectors: for the LLM decoders, and the normal JSON of the valid ones for the normal decoders. */
export function loadLlmVectors(folder: string): { llm: Case[]; normal: Case[] } {
  const shown = "examples/llm/llm-vectors.json";
  const problems: string[] = [];
  const llm: Case[] = [];
  const normal: Case[] = [];
  readList(join(folder, "llm-vectors.json"), shown).forEach((v, i) => {
    const at = `${shown}: vector ${String(i)}`;
    if (!isObject(v) || typeof v.name !== "string" || typeof v.type !== "string" || typeof v.llm !== "string") {
      problems.push(`${at}: needs a name, a type and llm text`);
      return;
    }
    const id = `${shown}/${String(i)}`;
    if (loneSurrogate(v.llm) || (typeof v.json === "string" && loneSurrogate(v.json))) {
      problems.push(`${at}: text with a lone surrogate has no UTF-8 form`);
      return;
    }
    if (typeof v.json === "string" && v.error === undefined) {
      llm.push({ id, type: v.type, valid: true, bytes: bytes(v.llm), strict: ACCEPTED, report: ACCEPTED, encodes: bytes(v.json) });
      normal.push({ id: `${id} json`, type: v.type, valid: true, bytes: bytes(v.json), strict: ACCEPTED, report: ACCEPTED });
      return;
    }
    if (typeof v.error !== "string" || v.json !== undefined) {
      problems.push(`${at}: needs json for a valid vector or error for an invalid one`);
      return;
    }
    const parsed = parseCompact(v.error);
    if (parsed === undefined) {
      problems.push(`${at}: ${JSON.stringify(v.error)} is not the compact form of an error`);
      return;
    }
    const outcome: Outcome = { accepted: false, ...parsed };
    llm.push({ id, type: v.type, valid: false, bytes: bytes(v.llm), strict: outcome, report: outcome, compact: v.error });
  });
  if (problems.length > 0) throw new LayoutError(problems);
  return { llm, normal };
}

/** The cases of the shared cleanup vectors. */
export function loadCleanupVectors(folder: string): Case[] {
  const shown = "examples/llm/cleanup-vectors.json";
  const problems: string[] = [];
  const out: Case[] = [];
  readList(join(folder, "cleanup-vectors.json"), shown).forEach((v, i) => {
    const at = `${shown}: vector ${String(i)}`;
    if (!isObject(v) || typeof v.name !== "string" || typeof v.input !== "string" || typeof v.output !== "string" || Object.keys(v).length !== 3) {
      problems.push(`${at}: needs exactly a name, an input and an output`);
      return;
    }
    if (loneSurrogate(v.input) || loneSurrogate(v.output)) {
      problems.push(`${at}: text with a lone surrogate has no UTF-8 form`);
      return;
    }
    out.push({ id: `${shown}/${String(i)}`, type: "", valid: true, bytes: bytes(v.input), strict: ACCEPTED, report: ACCEPTED, cleaned: v.output });
  });
  if (problems.length > 0) throw new LayoutError(problems);
  return out;
}
