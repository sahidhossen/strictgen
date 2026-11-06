import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RULES as MAPPING_RULES } from "./conformance/coverage.js";
import { ERROR_CODES } from "./errors.js";
import { RULE_IDS } from "./rules.js";
import { CODE_CASES, declaration, docsFiles, fill, markers, region, SnippetError, Snippets } from "./snippets.js";
import { RULE_EXAMPLES } from "./snippets-rules.js";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

/** The lines of a section, from its heading to the next heading of the same level or higher. */
function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.indexOf(" ") <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

describe("snippet markers", () => {
  it("finds each snippet and the lines it spans", () => {
    const text = "a\n<!-- snippet: file x.json -->\nold\n<!-- /snippet -->\nb";
    expect(markers(text, "t.md")).toEqual([{ spec: "file x.json", from: 2, to: 3 }]);
  });

  it("fails on a start without an end, an end without a start, and a nested start", () => {
    expect(() => markers("<!-- snippet: file x -->\n", "t.md")).toThrow(SnippetError);
    expect(() => markers("<!-- /snippet -->\n", "t.md")).toThrow(/without a start/);
    expect(() => markers("<!-- snippet: a -->\n<!-- snippet: b -->\n<!-- /snippet -->", "t.md")).toThrow(/inside/);
    expect(() => markers("text <!-- snippet: a -->", "t.md")).toThrow(/a line of its own/);
  });

  it("replaces only what is between the markers", async () => {
    const text = "a\n<!-- snippet: x -->\nold\nlines\n<!-- /snippet -->\nb\n";
    const out = await fill(text, "t.md", (spec) => Promise.resolve(`new ${spec}\n`));
    expect(out).toBe("a\n<!-- snippet: x -->\nnew x\n<!-- /snippet -->\nb\n");
  });

  it("fails on an unknown kind", async () => {
    await expect(new Snippets(ROOT).make("nothing here")).rejects.toThrow(/unknown snippet kind/);
  });
});

describe("snippet extraction", () => {
  it("takes a region without its markers and common indent", () => {
    const text = "fn x() {\n    // docs:start a\n    let y = 1;\n      z();\n    // docs:end a\n}";
    expect(region(text, "a", "x.rs")).toBe("let y = 1;\n  z();");
    expect(() => region(text, "b", "x.rs")).toThrow(SnippetError);
  });

  it("takes a declaration with its doc comment and attributes, in each language", () => {
    const rust = "use x;\n\n/// An order.\n#[derive(Debug)]\npub struct Order {\n    pub id: String,\n}\n\nimpl Order {}";
    expect(declaration(rust, "Order", "a.rs")).toBe("/// An order.\n#[derive(Debug)]\npub struct Order {\n    pub id: String,\n}");
    const go = "package t\n\n// Order is an order.\ntype Order struct {\n\tId string\n}\n\nfunc x() {}";
    expect(declaration(go, "Order", "a.go")).toBe("// Order is an order.\ntype Order struct {\n\tId string\n}");
    const ts = "/** A status. */\nexport type Status =\n  | \"a\"\n  | \"b\";\nexport function f() {}";
    expect(declaration(ts, "Status", "a.ts")).toBe('/** A status. */\nexport type Status =\n  | "a"\n  | "b";');
    expect(() => declaration(go, "Missing", "a.go")).toThrow(SnippetError);
  });
});

describe("docs coverage", () => {
  it("has a section for every generation rule, with an example for every rule but internal", () => {
    const text = read("docs/schemas.md");
    for (const id of RULE_IDS) {
      const body = section(text, `### \`${id}\``);
      expect(body.includes(`<!-- snippet: rule ${id} -->`), id).toBe(id !== "internal");
      expect(RULE_EXAMPLES[id] === null, id).toBe(id === "internal");
    }
  });

  it("has one mapping table row per conformance mapping rule, in its order", () => {
    // The conformance RULES are the reference rather than the emitter tests' describe names:
    // each id is a construct the suite proves in all three languages, the list is checked
    // against the model's flags, and a rule without cases fails the suite.
    const rows = section(read("docs/mapping.md"), "## The table")
      .filter((l) => l.startsWith("| `"))
      .map((l) => /^\| `([^`]+)` \|/.exec(l)?.[1]);
    expect(rows).toEqual(MAPPING_RULES.map((r) => r.id));
  });

  it("has a section with a generated example for every error code", () => {
    const text = read("docs/error-codes.md");
    for (const { code } of ERROR_CODES) {
      expect(section(text, `### \`${code}\``), code).toContain(`<!-- snippet: error-code ${code} -->`);
    }
  });

  it("shows a conformance case that fails with each code", () => {
    expect(Object.keys(CODE_CASES).sort()).toEqual(ERROR_CODES.map((e) => e.code).sort());
    for (const [code, c] of Object.entries(CODE_CASES)) {
      const file = join(ROOT, "conformance", "cases", c.file);
      expect(existsSync(file), c.file).toBe(true);
      expect(c.file.startsWith(`${c.type}/invalid/`), c.file).toBe(true);
      const expect_ = JSON.parse(readFileSync(file.replace(/\.json$/, ".expect.json"), "utf8")) as { code: string };
      expect(expect_.code, c.file).toBe(code);
    }
  });

  it("links every doc page from the README", () => {
    const readme = read("README.md");
    for (const file of docsFiles(ROOT).filter((f) => f.startsWith("docs/"))) expect(readme, file).toContain(`(${file})`);
  });
});

/** Snippet kinds that need neither Rust nor Go nor a formatter, so they are checked here too. */
const LOCAL = new Set(["file", "region", "decl", "profile", "rule", "command"]);

describe("docs snippets", () => {
  it(
    "are up to date for every snippet that needs no toolchain",
    async () => {
      const snippets = new Snippets(ROOT);
      let checked = 0;
      for (const file of docsFiles(ROOT)) {
        const text = read(file);
        const lines = text.split("\n");
        for (const m of markers(text, file)) {
          const [kind, ...args] = m.spec.split(" ");
          // explain formats with rustfmt and gofmt; pnpm docs:check covers it in CI.
          if (kind === undefined || !LOCAL.has(kind) || (kind === "command" && args[1] === "explain")) continue;
          const body = lines.slice(m.from, m.to).join("\n");
          expect(body, `${file}: ${m.spec} is out of date, run pnpm docs`).toBe(await snippets.make(m.spec));
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(50);
    },
    60_000,
  );
});
