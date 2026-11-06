/**
 * `strictgen docs`: a page per type, in Markdown, or every type in one self-contained HTML page.
 *
 * Each page has the type's description, where the schema defines it, its type in every
 * configured language, its fields, values or variants with their constraints, a valid example
 * from the payload generator (src/payloads.ts) and links to the types it uses and that use it.
 * Both formats are rendered from one document model, so they hold the same content, and every
 * piece of schema text is escaped for the format: descriptions, keys, enum values, patterns.
 *
 * The docs folder is shared, like Go's: strictgen only replaces or removes the files in it that
 * start with the generated header, so hand-written pages beside them stay.
 */
import { relative, sep } from "node:path";

import { limitsOf } from "./checks.js";
import { commentText, compare, declTypes, markupHeader, typeRefs } from "./common.js";
import type { Config, DocsFormat, ReadMode } from "./config.js";
import { goFieldType, goType } from "./emit-go.js";
import { rustFieldType, rustType } from "./emit-rust.js";
import { tsType } from "./emit-ts.js";
import type { OutputFile, Target } from "./main.js";
import type { Decl, Field, Model, StructDecl, TypeExpr } from "./model.js";
import { GenerateError, PayloadGenerator } from "./payloads.js";
import { CodegenError } from "./schema.js";

/** The Markdown page that lists every type. */
export const DOCS_INDEX = "index.md";
/** The HTML page, which holds every type. */
export const DOCS_HTML = "index.html";
/** The seed of every example, so each page stays the same while its type does. */
const EXAMPLE_SEED = 0;

/** A piece of text in a line: plain text, code, or a link to a type's page. */
type Inline = { readonly text: string } | { readonly code: string } | { readonly link: string };

type Piece =
  | { readonly kind: "title"; readonly text: string }
  | { readonly kind: "paragraph"; readonly parts: readonly Inline[] }
  | { readonly kind: "list"; readonly items: readonly (readonly Inline[])[] }
  | {
      readonly kind: "table";
      readonly head: readonly string[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly kind: "code"; readonly text: string };

/** One type's page. */
interface TypeDoc {
  readonly name: string;
  readonly pieces: readonly Piece[];
}

/** A language a target is written in, and how it names types. */
interface Language {
  readonly name: string;
  readonly type: (type: TypeExpr) => string;
  readonly field: (field: Field) => string;
}

const text = (t: string): Inline => ({ text: t });
const code = (t: string): Inline => ({ code: t });
const link = (name: string): Inline => ({ link: name });

/** The configured languages, in the order explain shows them: Rust, Go, TypeScript. */
function languages(config: Config, model: Model): Language[] {
  const decls = new Map(model.decls.map((d) => [d.name, d]));
  const { rust, go, typescript } = config.targets;
  return [
    ...(rust === undefined ? [] : [{ name: "Rust", type: rustType, field: rustFieldType }]),
    ...(go === undefined ? [] : [{ name: "Go", type: goType, field: (f: Field) => goFieldType(decls, f) }]),
    ...(typescript === undefined
      ? []
      : [
          {
            name: "TypeScript",
            type: (t: TypeExpr) => tsType(t, decls),
            field: (f: Field) => tsType(f.type, decls),
          },
        ]),
  ];
}

/** The read modes of the configured targets, which examples must hold in. */
export function readModes(config: Config): ReadMode[] {
  const { rust, go, typescript } = config.targets;
  const modes = [rust?.read, go?.read, typescript?.read].filter((m): m is ReadMode => m !== undefined);
  return [...new Set(modes)].sort(compare);
}

/** A type as a line of words, with links to the types it names. */
function described(type: TypeExpr): Inline[] {
  switch (type.kind) {
    case "ref":
      return [link(type.name)];
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return [text(type.kind)];
    case "literal":
      return [text("the constant "), code(String(type.value))];
    case "any":
      return [text("any JSON value")];
    case "nonNull":
      return [text("any JSON value but null")];
    case "array":
      return [text("array of "), ...described(type.items)];
    case "map":
      return [text("map of "), ...described(type.key), text(" to "), ...described(type.value)];
  }
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function range(min: number | undefined, max: number | undefined, one: string, many: string): string | undefined {
  if (min !== undefined && max !== undefined) {
    return min === max ? count(min, one, many) : `${String(min)} to ${count(max, one, many)}`;
  }
  if (min !== undefined) return `at least ${count(min, one, many)}`;
  if (max !== undefined) return `at most ${count(max, one, many)}`;
  return undefined;
}

/** The constraints of a type, each a line, those of the values inside it after its own. */
function constraints(type: TypeExpr, prefix = ""): Inline[][] {
  const out: Inline[][] = [];
  const add = (...parts: Inline[]): void => {
    out.push(prefix === "" ? parts : [text(prefix), ...parts]);
  };
  switch (type.kind) {
    case "string": {
      const length = range(type.minLength, type.maxLength, "character", "characters");
      if (length !== undefined) add(text(length));
      if (type.match !== undefined) add(text("matching "), code(type.match.source));
      if (type.format !== undefined) add(text(`a ${type.format === "uuid" ? "UUID" : type.format}`));
      break;
    }
    case "integer":
    case "number":
      for (const limit of limitsOf(type)) {
        add(text(limit.op === "%" ? `a multiple of ${limit.text}` : `${limit.op} ${limit.text}`));
      }
      break;
    case "array": {
      const items = range(type.minItems, type.maxItems, "item", "items");
      if (items !== undefined) add(text(items));
      if (type.uniqueItems === true) add(text("unique items"));
      out.push(...constraints(type.items, `${prefix}each item: `));
      break;
    }
    case "map": {
      const keys = range(type.minProperties, type.maxProperties, "key", "keys");
      if (keys !== undefined) add(text(keys));
      out.push(...constraints(type.key, `${prefix}each key: `));
      out.push(...constraints(type.value, `${prefix}each value: `));
      break;
    }
    default:
      break;
  }
  return out;
}

/** Constraints joined into one table cell. */
function constraintCell(type: TypeExpr): Inline[] {
  return constraints(type).flatMap((line, i) => (i === 0 ? line : [text("; "), ...line]));
}

/** Text without ASCII white space at either end. `trim` would also take a byte order mark, which pages show. */
function trimmed(raw: string): string {
  return raw.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
}

function docLines(doc: string): Piece[] {
  return doc
    .split(/\n[\t\r ]*\n/)
    .map(trimmed)
    .filter((p) => p !== "")
    .map((p) => ({ kind: "paragraph", parts: [text(p)] }));
}

function kindLine(decl: Decl): Inline[] {
  switch (decl.kind) {
    case "struct":
      return [text(decl.rest === undefined ? "An object with these keys, and no others." : "An object with these keys, and others as a map.")];
    case "enum":
      return [text(decl.values.length === 1 ? "A string constant." : "A string, one of the values below.")];
    case "tagged":
      return [text("A tagged union: the "), code(decl.tag), text(" key picks the branch.")];
    case "untagged":
      return [text("One of the variants below, tried in this order: the first whose structure fits is the value.")];
    case "alias":
      return [text("Another name for "), ...described(decl.type), text(".")];
    case "id":
      return [text("An id: a string, kept apart from ids of other kinds.")];
  }
}

function typeDoc(decl: Decl, langs: readonly Language[], usedBy: readonly string[], example: Piece): TypeDoc {
  const pieces: Piece[] = [{ kind: "title", text: decl.name }, ...docLines(decl.doc)];
  pieces.push({ kind: "paragraph", parts: [...kindLine(decl), text(" Defined at "), code(decl.path), text(".")] });
  if (langs.length > 0) {
    const holds = decl.kind === "alias" ? decl.type : decl.kind === "id" ? decl.type : undefined;
    pieces.push({ kind: "title", text: "Generated types" });
    pieces.push({
      kind: "table",
      head: holds === undefined ? ["Language", "Type"] : ["Language", "Type", "Holds"],
      rows: langs.map((l) => [[text(l.name)], [code(decl.name)], ...(holds === undefined ? [] : [[code(l.type(holds))]])]),
    });
  }
  pieces.push(...body(decl, langs));
  pieces.push({ kind: "title", text: "Example" }, example);
  const uses = [...new Set(declTypes(decl).flatMap(typeRefs))].sort(compare);
  if (uses.length > 0 || usedBy.length > 0) {
    pieces.push({ kind: "title", text: "References" });
    const items: Inline[][] = [];
    if (uses.length > 0) items.push([text("Uses: "), ...joined(uses.map(link))]);
    if (usedBy.length > 0) items.push([text("Used by: "), ...joined(usedBy.map(link))]);
    pieces.push({ kind: "list", items });
  }
  return { name: decl.name, pieces };
}

function joined(parts: readonly Inline[]): Inline[] {
  return parts.flatMap((p, i) => (i === 0 ? [p] : [text(", "), p]));
}

function body(decl: Decl, langs: readonly Language[]): Piece[] {
  switch (decl.kind) {
    case "struct":
      return fields(decl, langs);
    case "enum":
      return [{ kind: "title", text: "Values" }, { kind: "list", items: decl.values.map((v) => [code(JSON.stringify(v))]) }];
    case "tagged":
      return [
        { kind: "title", text: "Branches" },
        {
          kind: "table",
          head: [`Tag ${decl.tag}`, "Type"],
          rows: decl.variants.map((v) => [[code(JSON.stringify(v.value))], [link(v.type)]]),
        },
      ];
    case "untagged":
      return [
        { kind: "title", text: "Variants" },
        {
          kind: "table",
          head: ["Order", "Variant", "Type", "Constraints"],
          rows: decl.variants.map((v, i) => [[text(String(i + 1))], [code(v.name)], described(v.type), constraintCell(v.type)]),
        },
      ];
    case "alias":
    case "id": {
      const lines = constraints(decl.type);
      return lines.length === 0 ? [] : [{ kind: "title", text: "Constraints" }, { kind: "list", items: lines }];
    }
  }
}

function fields(decl: StructDecl, langs: readonly Language[]): Piece[] {
  const rows = decl.fields.map((f) => [
    [code(f.name)],
    described(f.type),
    [text(f.required ? "yes" : "no")],
    ...langs.map((l) => [code(l.field(f))]),
    constraintCell(f.type),
    [text(trimmed(f.doc.replace(/[\t\n\r ]+/g, " ")))],
  ]);
  if (decl.rest !== undefined) {
    const rest: TypeExpr = { kind: "map", key: decl.rest.key, value: decl.rest.value };
    rows.push([
      [text("other keys")],
      described(rest),
      [text("no")],
      ...langs.map((l) => [code(l.type(rest))]),
      constraintCell(rest),
      [text("Keys the object doesn't name, with their values.")],
    ]);
  }
  const out: Piece[] = [
    { kind: "title", text: "Fields" },
    {
      kind: "table",
      head: ["Key", "Type", "Required", ...langs.map((l) => l.name), "Constraints", "Description"],
      rows,
    },
  ];
  if (decl.forbidden.length > 0) {
    out.push({ kind: "paragraph", parts: [text("Must not have the keys "), ...joined(decl.forbidden.map(code)), text(".")] });
  }
  return out;
}

/** JSON text with the characters that are hard to see written as \u escapes, which JSON reads back as the same string. */
function visibleJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu,
    (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );
}

function examplePiece(model: Model, decl: Decl, modes: readonly ReadMode[]): Piece {
  try {
    const value = new PayloadGenerator(model, { seed: EXAMPLE_SEED, read: modes }).valid(decl.name);
    return { kind: "code", text: visibleJson(value) };
  } catch (error) {
    if (!(error instanceof GenerateError)) throw error;
    return { kind: "paragraph", parts: [text(`No example: ${error.message}.`)] };
  }
}

/** Every type's page, sorted by name, and the index of them by schema file. */
function document(config: Config, model: Model): { types: TypeDoc[]; index: Piece[] } {
  const langs = languages(config, model);
  const modes = readModes(config);
  const usedBy = new Map<string, Set<string>>();
  for (const decl of model.decls) {
    for (const name of declTypes(decl).flatMap(typeRefs)) {
      if (!usedBy.has(name)) usedBy.set(name, new Set());
      usedBy.get(name)?.add(decl.name);
    }
  }
  const types = model.decls.map((decl) =>
    typeDoc(decl, langs, [...(usedBy.get(decl.name) ?? [])].sort(compare), examplePiece(model, decl, modes)),
  );
  const index: Piece[] = [];
  for (const schema of [...new Set(model.decls.map((d) => d.schema))].sort(compare)) {
    index.push({ kind: "title", text: `${schema}.json` });
    index.push({
      kind: "list",
      items: model.decls
        .filter((d) => d.schema === schema)
        .map((d) => {
          const summary = trimmed(d.doc.split("\n")[0] ?? "");
          return summary === "" ? [link(d.name)] : [link(d.name), text(`: ${summary}`)];
        }),
    });
  }
  return { types, index };
}

// Markdown.

/**
 * Plain text for Markdown, within a line: every character that could start inline markup
 * escaped, and hard-to-see characters as \u{...}. Line feeds stay; {@link markdownLines} makes
 * the start of each line safe.
 */
export function markdownText(raw: string): string {
  return raw
    .split("\n")
    .map((line) => commentText(line).replace(/[\\`*_[\]<>&|~!]/g, "\\$&"))
    .join("\n");
}

/**
 * Markdown lines made safe at their start: no indent, which would make code, and the marks of a
 * title, a list, a quote or an underline escaped. Inline text is already escaped.
 */
function markdownLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimStart().replace(/^[#+\-=]/, "\\$&").replace(/^(\d+)([.)])/, "$1\\$2"))
    .join("\n");
}

/** A Markdown code span that holds `raw` as it is. In a table, `|` is escaped, which tables need even in code. */
export function markdownCode(raw: string, cell: boolean): string {
  let body = commentText(raw);
  if (cell) body = body.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = body.startsWith("`") || body.endsWith("`") || body.startsWith(" ") || body.endsWith(" ") ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

function markdownInline(parts: readonly Inline[], cell: boolean): string {
  const line = parts
    .map((p) => {
      if ("code" in p) return markdownCode(p.code, cell);
      if ("link" in p) return `[${markdownText(p.link)}](${encodeURIComponent(p.link)}.md)`;
      return markdownText(cell ? p.text.replace(/[\t\n\r ]+/g, " ") : p.text);
    })
    .join("");
  return markdownLines(line);
}

function markdownPieces(pieces: readonly Piece[], top: boolean): string {
  return pieces
    .map((block, i) => {
      switch (block.kind) {
        case "title":
          return `${top && i === 0 ? "#" : "##"} ${markdownText(block.text.replace(/[\t\n\r ]+/g, " "))}`;
        case "paragraph":
          return markdownInline(block.parts, false);
        case "list":
          return block.items.map((item) => `- ${markdownInline(item, false)}`).join("\n");
        case "table": {
          const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
          return [
            row(block.head.map((h) => markdownText(h.replace(/[\t\n\r ]+/g, " ")))),
            row(block.head.map(() => "---")),
            ...block.rows.map((cells) => row(cells.map((c) => (c.length === 0 ? " " : markdownInline(c, true))))),
          ].join("\n");
        }
        case "code": {
          const longest = Math.max(0, ...[...block.text.matchAll(/`+/g)].map((m) => m[0].length));
          const fence = "`".repeat(Math.max(3, longest + 1));
          return `${fence}json\n${block.text}\n${fence}`;
        }
      }
    })
    .join("\n\n");
}

function markdownFiles(config: Config, model: Model): { name: string; contents: string }[] {
  const { types, index } = document(config, model);
  const head = `${markupHeader(config.header)}\n\n`;
  const indexPage = markdownPieces(
    [{ kind: "title", text: "Types" }, { kind: "paragraph", parts: [text("One page per type, generated from the schemas.")] }, ...index],
    true,
  );
  return [
    { name: DOCS_INDEX, contents: `${head}${indexPage}\n` },
    ...types.map((doc) => ({
      name: `${doc.name}.md`,
      contents: `${head}${markdownPieces(doc.pieces, true)}\n\n[All types](${DOCS_INDEX})\n`,
    })),
  ];
}

// HTML.

/** Text for HTML, in an element or an attribute: `&`, `<`, `>`, `"` and `'` escaped, and hard-to-see characters as \u{...}. */
export function htmlText(raw: string): string {
  return commentText(raw).replace(/[&<>"']/g, (c) => `&#${String(c.codePointAt(0) ?? 0)};`);
}

const anchor = (name: string): string => `type-${htmlText(name)}`;

function htmlInline(parts: readonly Inline[]): string {
  return parts
    .map((p) => {
      if ("code" in p) return `<code>${htmlText(p.code)}</code>`;
      if ("link" in p) return `<a href="#${anchor(p.link)}">${htmlText(p.link)}</a>`;
      return htmlText(p.text);
    })
    .join("");
}

function htmlPieces(pieces: readonly Piece[], level: number): string {
  return pieces
    .map((block, i) => {
      switch (block.kind) {
        case "title": {
          const h = i === 0 ? level : level + 1;
          return `<h${String(h)}>${htmlText(block.text)}</h${String(h)}>`;
        }
        case "paragraph":
          return `<p>${htmlInline(block.parts)}</p>`;
        case "list":
          return `<ul>\n${block.items.map((item) => `<li>${htmlInline(item)}</li>`).join("\n")}\n</ul>`;
        case "table":
          return (
            `<div class="table"><table>\n<thead><tr>${block.head.map((h) => `<th>${htmlText(h)}</th>`).join("")}</tr></thead>\n<tbody>\n` +
            block.rows.map((cells) => `<tr>${cells.map((c) => `<td>${htmlInline(c)}</td>`).join("")}</tr>`).join("\n") +
            "\n</tbody>\n</table></div>"
          );
        case "code":
          return `<pre><code>${htmlText(block.text)}</code></pre>`;
      }
    })
    .join("\n");
}

const STYLE = `:root { color-scheme: light dark; --fg: #1f2328; --bg: #ffffff; --muted: #59636e; --line: #d1d9e0; --code: #f6f8fa; --link: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --bg: #0d1117; --muted: #9198a1; --line: #3d444d; --code: #151b23; --link: #4493f8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
a { color: var(--link); }
h1, h2, h3 { line-height: 1.25; }
section { border-top: 1px solid var(--line); margin-top: 2.5rem; padding-top: 0.5rem; }
code, pre { font: 0.875em/1.45 ui-monospace, monospace; background: var(--code); border-radius: 4px; }
code { padding: 0.1em 0.3em; overflow-wrap: anywhere; }
pre { padding: 0.75rem 1rem; overflow-x: auto; }
pre code { padding: 0; background: none; }
.table { overflow-x: auto; }
table { border-collapse: collapse; margin: 0.5rem 0; }
th, td { border: 1px solid var(--line); padding: 0.35rem 0.6rem; text-align: left; vertical-align: top; }
th { background: var(--code); }`;

function htmlFile(config: Config, model: Model): string {
  const { types, index } = document(config, model);
  const sections = types.map((doc) => `<section id="${anchor(doc.name)}">\n${htmlPieces(doc.pieces, 2)}\n</section>`);
  return [
    markupHeader(config.header),
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Types</title>",
    `<style>\n${STYLE}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<h1>Types</h1>",
    "<p>Every type, generated from the schemas.</p>",
    `<nav>\n${htmlPieces([{ kind: "title", text: "" }, ...index], 1).replace(/^<h1><\/h1>\n/, "")}\n</nav>`,
    ...sections,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// Output.

/** The docs folder, relative to the config's folder, with `/` separators. */
function docsDir(config: Config): string {
  const docs = config.docs;
  if (docs === undefined) throw new Error("no docs config");
  const rel = relative(config.root, docs.out).split(sep).join("/");
  return rel === "" ? "." : rel;
}

/**
 * The docs files for a model, as `generate` places output: paths relative to the folder that
 * holds the config. Fails with a {@link CodegenError} when two pages would share a file name on
 * a filesystem that ignores case.
 */
export function docsFiles(config: Config, model: Model, format: DocsFormat): OutputFile[] {
  const dir = docsDir(config);
  const files = format === "html" ? [{ name: DOCS_HTML, contents: htmlFile(config, model) }] : markdownFiles(config, model);
  const seen = new Map<string, string>();
  for (const file of files) {
    const folded = file.name.toLowerCase();
    const other = seen.get(folded);
    if (other !== undefined) {
      throw new CodegenError(
        file.name,
        "name-clash",
        `the docs pages ${other} and ${file.name} differ only in case`,
        "rename one of the types",
      );
    }
    seen.set(folded, file.name);
  }
  return files.map((f) => ({ path: dir === "." ? f.name : `${dir}/${f.name}`, contents: f.contents }));
}

/** The docs folder as a shared target folder: only the files with the generated header are its own. */
export function docsTarget(config: Config): Target {
  return { name: "docs", dirs: [], shared: [docsDir(config)], emit: () => [] };
}
