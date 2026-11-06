import { describe, expect, it } from "vitest";

import { buildModel } from "./build.js";
import { commentText } from "./common.js";
import { emitGo } from "./emit-go.js";
import { emitRust } from "./emit-rust.js";
import { emitTypeScript } from "./emit-ts.js";
import type { JsonObject } from "./schema.js";
import { schemaSet } from "./schema.js";

// Built from code points, so this file holds none of them as raw characters.
const NUL = String.fromCodePoint(0);
const CR = String.fromCodePoint(0x0d);
const BOM = String.fromCodePoint(0xfeff);
const LS = String.fromCodePoint(0x2028);
const RLO = String.fromCodePoint(0x202e);
const SMILE = String.fromCodePoint(0x1f600);

/** Printable ASCII, tabs and line feeds: what every generated file must be written in. */
const ASCII = /^[\t\n\x20-\x7e]*$/;

const closed = (properties: JsonObject, required: string[]): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const model = buildModel(
  schemaSet({
    marks: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.com/schemas/v1/marks.json",
      title: "Marks",
      description: `Odd${BOM} text${LS} with${NUL} a${CR} return and ${RLO}bidi.`,
      ...closed(
        {
          mark: {
            description: `One mark${BOM}.`,
            enum: [`bom${BOM}`, `line${LS}sep`, `nul${NUL}`, "back\\slash", 'quote"', `astral${SMILE}`],
          },
          fixed: { const: `x${BOM}${LS}${NUL}\\"${SMILE}` },
          shape: { oneOf: [{ $ref: "#/$defs/dot" }, { $ref: "#/$defs/square" }] },
        },
        ["mark"],
      ),
      $defs: {
        dot: closed({ kind: { const: `dot${BOM}${LS}` } }, ["kind"]),
        square: closed({ kind: { const: `sq"\\${NUL}${SMILE}` } }, ["kind"]),
      },
    },
  }),
);

const files = [
  ...emitGo(model).map((f) => ["go", f] as const),
  ...emitRust(model).map((f) => ["rust", f] as const),
  ...emitTypeScript(model).map((f) => ["typescript", f] as const),
];

describe("generated literals and comments", () => {
  it.each(files.map(([lang, f]) => [lang, f.name, f.contents]))(
    "write %s %s in printable ASCII",
    (_lang, _name, contents) => {
      expect(contents).toMatch(ASCII);
    },
  );

  it("escape enum values, consts and tags in Go", () => {
    const go = emitGo(model).find((f) => f.name === "marks.go")?.contents ?? "";
    expect(go).toContain('MarksMarkBom MarksMark = "bom\\ufeff"');
    expect(go).toContain('MarksMarkNul MarksMark = "nul\\u0000"');
    expect(go).toContain('MarksMarkAstral MarksMark = "astral\\U0001f600"');
    expect(go).toContain('"dot\\ufeff\\u2028"');
    expect(go).toContain('"sq\\"\\\\\\u0000\\U0001f600"');
  });

  it("escape enum values, consts and tags in Rust", () => {
    const rust = emitRust(model).find((f) => f.name === "marks.rs")?.contents ?? "";
    expect(rust).toContain('#[serde(rename = "bom\\u{feff}")]');
    expect(rust).toContain('#[serde(rename = "astral\\u{1f600}")]');
    expect(rust).toContain('"dot\\u{feff}\\u{2028}"');
  });

  it("escape enum values, consts and tags in TypeScript", () => {
    const ts = emitTypeScript(model).find((f) => f.name === "marks.ts")?.contents ?? "";
    expect(ts).toContain('"bom\\ufeff"');
    expect(ts).toContain('"astral\\ud83d\\ude00"');
    expect(ts).toContain('"sq\\"\\\\\\u0000\\ud83d\\ude00"');
  });

  it("fail generation on an enum value or const holding a lone surrogate, which Rust and Go can't hold", () => {
    const lone = `a${String.fromCharCode(0xd800)}`;
    const build = (x: JsonObject): void => {
      buildModel(
        schemaSet({
          lib: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            $id: "https://example.com/schemas/v1/lib.json",
            title: "lib",
            $defs: { x },
          },
        }),
      );
    };
    expect(() => build({ enum: ["b", lone] })).toThrow(
      "lib.json#/$defs/x/enum/1: unsupported-enum: the value holds a lone surrogate, which Rust and Go strings can't",
    );
    expect(() => build({ const: lone })).toThrow(
      "lib.json#/$defs/x/const: unsupported-const: the const holds a lone surrogate, which Rust and Go strings can't",
    );
  });

  it("write hidden characters in comments as \\u{...} text", () => {
    expect(commentText(`a${NUL}b${CR}c${BOM}d${LS}e${RLO}f\tg${SMILE}`)).toBe(
      "a\\u{0}b\\u{d}c\\u{feff}d\\u{2028}e\\u{202e}f\tg" + SMILE,
    );
    expect(commentText("\ud800 lone")).toBe("\\u{d800} lone");
  });
});
