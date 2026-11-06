import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { expected, loadCases, loadMarks } from "../../src/conformance/cases.js";
import { canonicalize } from "../../src/conformance/canonical.js";
import { builtinProfileFile } from "../../src/profile-files.js";
import type { Outcome } from "./decode.js";
import { evaluate, SHADOWED, transpiler } from "./decode.js";
import type { GenerateInput } from "./session.js";
import { respond, Session } from "./session.js";
import { PROFILES } from "./state.js";

const ROOT = join(import.meta.dirname, "..", "..");
const CONFORMANCE = join(ROOT, "conformance");

/** Generating and transpiling the conformance schemas takes a moment on a cold start. */
const TIMEOUT = 60_000;

const PROFILE_TEXTS = Object.fromEntries(PROFILES.map((p) => [p, readFileSync(builtinProfileFile(p), "utf8")]));

function session(): Session {
  return new Session(transpiler(ts), PROFILE_TEXTS);
}

function schemas(dir: string): GenerateInput["schemas"] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function text(bytes: Uint8Array): string | undefined {
  try {
    return UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

describe("the playground decoders", () => {
  for (const read of ["strict", "report"] as const) {
    it(
      `give every conformance case's expected result in ${read} mode`,
      () => {
        const s = session();
        const generated = s.generate({
          schemas: schemas(join(CONFORMANCE, "schemas")),
          read,
          profiles: [],
          cleanup: false,
          serdeBridge: false,
          ids: { file: "common", suffix: "Id" },
        });
        if (!generated.ok) throw new Error(generated.error);
        const cases = loadCases(join(CONFORMANCE, "cases"), new Set(generated.types));
        // The conformance suite holds TypeScript to these instead of the expectation.
        const unsafe = new Map(
          loadMarks(join(CONFORMANCE, "marks.json"), cases)
            .filter((m) => m.kind === "ts-unsafe-integer")
            .map((m) => [m.case, m.path ?? ""]),
        );
        let checked = 0;
        for (const c of cases) {
          const input = text(c.bytes);
          // The page takes text, so a case of bytes that aren't UTF-8 can't be typed into it.
          if (input === undefined || c.unlabelled?.includes(read) === true) continue;
          const at = unsafe.get(c.id);
          const want = at === undefined ? expected(c, read) : { accepted: false as const, path: at, code: "out_of_range_integer" };
          const got = s.decode(c.type, "normal", input);
          if (want.accepted) {
            expect(got.kind, c.id).toBe("accepted");
            const accepted = got as Extract<Outcome, { kind: "accepted" }>;
            expect(accepted.unknown, c.id).toEqual(want.unknown);
            if (want.unknown.length === 0 && accepted.encoded !== null) {
              expect(canonicalize(accepted.encoded), c.id).toBe(canonicalize(input));
            }
          } else {
            expect(got.kind, c.id).toBe("rejected");
            const { error } = got as Extract<Outcome, { kind: "rejected" }>;
            expect({ path: error.path, code: error.code }, c.id).toEqual({ path: want.path, code: want.code });
            expect(error.message.length, c.id).toBeGreaterThan(0);
            expect(error.compact.startsWith(error.path === "" ? error.code : `${error.path} ${error.code}`), c.id).toBe(true);
          }
          checked++;
        }
        expect(checked).toBeGreaterThan(300);
      },
      TIMEOUT,
    );
  }

  it(
    "give the shared LLM vectors' values and compact errors",
    () => {
      const s = session();
      const generated = s.generate({
        schemas: schemas(join(ROOT, "examples", "llm", "schemas")),
        read: "strict",
        profiles: [...PROFILES],
        cleanup: true,
        serdeBridge: false,
        ids: null,
      });
      if (!generated.ok) throw new Error(generated.error);
      const vectors = JSON.parse(readFileSync(join(ROOT, "examples", "llm", "llm-vectors.json"), "utf8")) as {
        name: string;
        type: string;
        llm: string;
        json?: string;
        error?: string;
      }[];
      expect(vectors.length).toBeGreaterThan(1000);
      for (const v of vectors) {
        const got = s.decode(v.type, "llm", v.llm);
        if (v.json !== undefined) {
          expect(got.kind, v.name).toBe("accepted");
          const encoded = (got as Extract<Outcome, { kind: "accepted" }>).encoded;
          expect(encoded === null ? null : canonicalize(encoded), v.name).toBe(canonicalize(v.json));
        } else {
          expect(got.kind, v.name).toBe("rejected");
          expect((got as Extract<Outcome, { kind: "rejected" }>).error.compact, v.name).toBe(v.error);
        }
      }
    },
    TIMEOUT,
  );
});

const ORDER = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://example.com/schemas/order.json",
  title: "Order",
  type: "object",
  properties: { quantity: { type: "integer", minimum: 1 }, note: { type: "string" } },
  required: ["quantity"],
  additionalProperties: false,
});

const INPUT: GenerateInput = {
  schemas: [{ name: "order.json", text: ORDER }],
  read: "strict",
  profiles: [],
  cleanup: false,
  serdeBridge: false,
  ids: null,
};

describe("evaluate", () => {
  it("hides the network, code loading and the global object from generated code", () => {
    const exports: Record<string, unknown> = {};
    evaluate(`"use strict";\nexports.seen = [${SHADOWED.map((n) => `typeof ${n}`).join(", ")}];`, exports, () => undefined);
    expect(exports.seen).toEqual(SHADOWED.map(() => "undefined"));
    expect(SHADOWED).toEqual(expect.arrayContaining(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts"]));
  });
});

describe("respond", () => {
  it("generates, then decodes the payload as the type asked for", () => {
    const r = respond(session(), { id: 7, input: INPUT, type: "Order", decoder: "normal", payload: '{"quantity": 0}' });
    expect(r.id).toBe(7);
    expect(r.type).toBe("Order");
    expect(r.generated.ok).toBe(true);
    expect(r.decoded).toEqual({
      kind: "rejected",
      error: {
        path: "/quantity",
        code: "too_small",
        expected: ">= 1",
        found: "0",
        message: "/quantity: too small, expected >= 1, found 0",
        compact: "/quantity too_small, expected >= 1, found 0",
      },
    });
  });

  it("reports unknown keys in report mode", () => {
    const r = respond(session(), {
      id: 1,
      input: { ...INPUT, read: "report" },
      type: "Order",
      decoder: "normal",
      payload: '{"quantity": 2, "gift": true}',
    });
    expect(r.decoded).toEqual({ kind: "accepted", unknown: ["/gift"], encoded: '{"quantity":2}', encodeError: null });
  });

  it("picks the first type when the one asked for isn't there, and decodes nothing without a payload", () => {
    const r = respond(session(), { id: 1, input: INPUT, type: "Missing", decoder: "normal", payload: "  " });
    expect(r.type).toBe("Order");
    expect(r.decoded).toBeNull();
  });

  it("says why there is no LLM decoder without a profile", () => {
    const r = respond(session(), { id: 1, input: INPUT, type: "Order", decoder: "llm", payload: "{}" });
    expect(r.decoded).toEqual({ kind: "unavailable", reason: "pick an LLM profile to get the LLM decoders" });
  });

  it("gives the generator's error for a schema outside the conventions", () => {
    const bad = { ...INPUT, schemas: [{ name: "order.json", text: ORDER.replace('"additionalProperties":false', '"additionalProperties":true') }] };
    const r = respond(session(), { id: 1, input: bad, type: "Order", decoder: "normal", payload: "{}" });
    expect(r.generated.ok).toBe(false);
    expect(r.generated.ok ? "" : r.generated.error).toMatch(/^order\.json#\/additionalProperties: open-object: /);
    expect(r.decoded).toBeNull();
    const broken = respond(session(), { id: 1, input: { ...INPUT, schemas: [{ name: "order.json", text: "{" }] }, type: "", decoder: "normal", payload: "" });
    expect(broken.generated.ok ? "" : broken.generated.error).toMatch(/^order\.json: invalid-json: /);
  });

  it("generates once for the same input, and again for a new one", () => {
    let transpiled = 0;
    const counting = new Session((source, name) => {
      transpiled++;
      return transpiler(ts)(source, name);
    }, PROFILE_TEXTS);
    const first = counting.generate(INPUT);
    const count = transpiled;
    expect(count).toBeGreaterThan(0);
    expect(counting.generate({ ...INPUT, schemas: [...INPUT.schemas] })).toBe(first);
    expect(transpiled).toBe(count);
    counting.generate({ ...INPUT, read: "report" });
    expect(transpiled).toBe(2 * count);
  });

  it("calls a decoder that throws something other than a DecodeError a crash", () => {
    const s = new Session(transpiler(ts), PROFILE_TEXTS, (body, exports, require) => {
      evaluate(body, exports, require);
      // Only in order.ts, where the export is a value; index.ts re-exports it with a getter.
      if (Object.getOwnPropertyDescriptor(exports, "decodeOrderFromJson")?.writable === true) {
        exports.decodeOrderFromJson = () => {
          throw new TypeError("boom");
        };
      }
    });
    s.generate(INPUT);
    expect(s.decode("Order", "normal", "{}")).toEqual({ kind: "crash", message: "TypeError: boom" });
  });
});
