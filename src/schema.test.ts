import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fieldIdent, serdeCamel } from "./emit-rust.js";
import { emitRust } from "./emit-rust.js";
import { pascal, variantName } from "./naming.js";
import type { SchemaSet } from "./schema.js";
import {
  at,
  CodegenError,
  idBaseOf,
  resolveRef,
  schemaAt,
  schemaSet,
  where,
} from "./schema.js";
import { loadSchemas } from "./schema-files.js";

const BASE = "https://example.com/schemas/v1/";

const set: SchemaSet = schemaSet({
  common: { $id: `${BASE}common.json`, $defs: { orderId: { type: "string" } } },
  payment: { $id: `${BASE}payment.json`, type: "object" },
});

function codegenError(run: () => unknown): CodegenError {
  try {
    run();
  } catch (error) {
    if (error instanceof CodegenError) return error;
    throw error;
  }
  throw new Error("expected a CodegenError");
}

describe("resolveRef", () => {
  const loc = { file: "payment", pointer: "/properties/id" };

  it("resolves local and absolute refs", () => {
    expect(resolveRef(set, `${BASE}common.json#/$defs/orderId`, loc)).toEqual({
      file: "common",
      def: "orderId",
    });
    expect(resolveRef(set, `${BASE}payment.json`, loc)).toEqual({
      file: "payment",
      def: undefined,
    });
    expect(resolveRef(set, "#", loc)).toEqual({ file: "payment", def: undefined });
  });

  it.each([
    ["https://example.com/x.json", "unresolved-ref", "is outside the schema set"],
    [`${BASE}missing.json`, "unresolved-ref", "names an unknown schema"],
    [`${BASE}common.json#/properties/x`, "ref-form", "must point at a $defs entry"],
    [`${BASE}common.json#/$defs/nope`, "unresolved-ref", "names an unknown def"],
  ])("rejects %s", (ref, rule, reason) => {
    expect(codegenError(() => resolveRef(set, ref, loc))).toMatchObject({
      path: "payment.json#/properties/id",
      rule,
      reason: `$ref ${ref} ${reason}`,
    });
  });
});

describe("schemas", () => {
  it("reads every .json schema from a folder, sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "schemas-"));
    try {
      writeFileSync(join(dir, "b.json"), JSON.stringify({ $id: `${BASE}b.json` }));
      writeFileSync(join(dir, "a.json"), JSON.stringify({ $id: `${BASE}a.json` }));
      writeFileSync(join(dir, "README.md"), "# Schemas\n");
      expect(loadSchemas(dir).map((s) => s.name)).toEqual(["a", "b"]);
      writeFileSync(join(dir, "c.json"), "[]");
      expect(codegenError(() => loadSchemas(dir)).path).toBe("c.json#");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks each $id against the file name", () => {
    expect(codegenError(() => schemaSet({ a: { $id: `${BASE}b.json` } })).path).toBe(
      "a.json#/$id",
    );
  });

  it("finds defs and roots, and fails on unknown ones", () => {
    expect(schemaAt(set, { file: "common", def: "orderId" })).toEqual({ type: "string" });
    expect(codegenError(() => schemaAt(set, { file: "common", def: "x" })).path).toBe(
      "common.json#/$defs/x",
    );
    expect(codegenError(() => schemaAt(set, { file: "x", def: undefined })).path).toBe("x.json#");
  });

  it("escapes JSON Pointer segments", () => {
    expect(where(at({ file: "a", pointer: "" }, "properties", "a/b~c", 0))).toBe(
      "a.json#/properties/a~1b~0c/0",
    );
  });
});

describe("idBase", () => {
  const other = "https://other.example/v2/";

  it("accepts every $id under an explicit base", () => {
    const explicit = schemaSet(
      { a: { $id: `${other}a.json` }, b: { $id: `${other}b.json` } },
      { idBase: other },
    );
    expect(explicit.map((s) => s.name)).toEqual(["a", "b"]);
    expect(idBaseOf(explicit)).toBe(other);
    expect(resolveRef(explicit, `${other}b.json`, { file: "a", pointer: "" })).toEqual({
      file: "b",
      def: undefined,
    });
  });

  it("names the file, the pointer, the expected base and a fix for an explicit base", () => {
    const error = codegenError(() =>
      schemaSet({ a: { $id: `${BASE}a.json` } }, { idBase: other }),
    );
    expect(error.path).toBe("a.json#/$id");
    expect(error.message).toBe(
      `a.json#/$id: schema-id: $id is "${BASE}a.json", expected ${other}a.json (base ${other}, from the idBase option). Hint: set the $id to ${other}a.json, or change the idBase option`,
    );
  });

  it("derives the base from the first schema by file name", () => {
    const derived = schemaSet({ b: { $id: `${other}b.json` }, a: { $id: `${other}a.json` } });
    expect(idBaseOf(derived)).toBe(other);
    expect(idBaseOf(set)).toBe(BASE);
    expect(idBaseOf(schemaSet({}))).toBeUndefined();
    expect(resolveRef(derived, `${other}b.json`, { file: "a", pointer: "" })).toEqual({
      file: "b",
      def: undefined,
    });
  });

  it("fails on a schema whose base differs from the derived one", () => {
    const error = codegenError(() =>
      schemaSet({ a: { $id: `${BASE}a.json` }, b: { $id: `${other}b.json` } }),
    );
    expect(error.path).toBe("b.json#/$id");
    expect(error.message).toBe(
      `b.json#/$id: schema-id: $id is "${other}b.json", expected ${BASE}b.json (base ${BASE}, taken from a.json). Hint: set the $id to ${BASE}b.json, or set the idBase option`,
    );
  });

  it("fails when no base can be derived from the first schema", () => {
    for (const root of [{}, { $id: 1 }, { $id: `${BASE}x.json` }]) {
      const error = codegenError(() => schemaSet({ a: root }));
      expect(error.path).toBe("a.json#/$id");
      expect(error.message).toContain("expected <idBase>a.json");
      expect(error.message).toContain("so no idBase can be taken from it");
      expect(error.message).toContain(
        "Hint: set the $id to a base ending in / or # followed by a.json, or set the idBase option",
      );
    }
  });

  it("fails on the first schema when its base doesn't end in / or #", () => {
    const error = codegenError(() =>
      schemaSet({
        a: { $id: "https://example.com/schemas/v1a.json" },
        b: { $id: `${BASE}b.json` },
      }),
    );
    expect(error.path).toBe("a.json#/$id");
    expect(error.message).toContain("so no idBase can be taken from it");
  });

  it("fails on a relative $id, which leaves an empty base", () => {
    const error = codegenError(() => schemaSet({ a: { $id: "a.json" } }));
    expect(error.path).toBe("a.json#/$id");
    expect(error.message).toContain("so no idBase can be taken from it");
  });

  it("fails on a $id whose file name only ends like the schema's", () => {
    const error = codegenError(() => schemaSet({ event: { $id: `${BASE}my-event.json` } }));
    expect(error.path).toBe("event.json#/$id");
    expect(error.message).toContain("so no idBase can be taken from it");
  });

  it("accepts a derived base ending in #", () => {
    const hashed = schemaSet({ a: { $id: "urn:example:schemas#a.json" } });
    expect(idBaseOf(hashed)).toBe("urn:example:schemas#");
  });

  it("rejects a $ref under a base other than the set's", () => {
    expect(
      codegenError(() => resolveRef(set, `${other}payment.json`, { file: "payment", pointer: "" }))
        .message,
    ).toContain("is outside the schema set");
  });
});

describe("naming", () => {
  it.each([
    ["cardPayment", "CardPayment"],
    ["sans-serif", "SansSerif"],
    ["image/webp", "ImageWebp"],
    ["GET", "Get"],
    ["pt-BR", "PtBr"],
    ["Op batch", "OpBatch"],
  ])("pascal(%s) is %s", (input, output) => {
    expect(pascal(input)).toBe(output);
  });

  it.each([
    ["_self", "SelfValue"],
    ["419", "V419"],
    ["", "Empty"],
    ["_blank", "Blank"],
  ])("variantName(%j) is %s", (input, output) => {
    expect(variantName(input)).toBe(output);
  });

  it.each([
    ["shippedAt", "shipped_at"],
    ["$account", "account"],
    ["type", "r#type"],
    ["self", "self_"],
    ["h1", "h1"],
  ])("fieldIdent(%s) is %s", (key, ident) => {
    expect(fieldIdent(key, "x")).toBe(ident);
  });

  it("rejects a key with no Rust field name", () => {
    expect(codegenError(() => fieldIdent("42", "x.json#")).message).toBe(
      "x.json#: unsupported-name: key 42 has no Rust field name. Hint: start the key with a letter",
    );
  });

  it("matches serde's camelCase", () => {
    expect(serdeCamel("shipped_at")).toBe("shippedAt");
    expect(serdeCamel("r#type")).toBe("type");
    expect(serdeCamel("account")).toBe("account");
  });

  it("reserves NonNullJson in Rust", () => {
    const model = {
      decls: [
        {
          kind: "alias" as const,
          name: "NonNullJson",
          doc: "",
          path: "x",
          schema: "x",
          source: undefined,
          type: { kind: "string" as const },
        },
      ],
    };
    expect(() => emitRust(model)).toThrow(CodegenError);
  });
});
