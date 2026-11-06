#!/usr/bin/env node
/**
 * Builds the playground into a folder of static files: `index.html`, `style.css`, `app.js` (the
 * page) and `worker.js` (the generator, the TypeScript compiler and the decoders). Nothing is
 * loaded from anywhere else.
 *
 *   node scripts/playground-build.mjs [--out <dir>]     (default playground/dist, which git ignores)
 *
 * The generator is bundled from `src/` as it is. The build fails when a module it pulls in from
 * the repository imports one of Node's built in modules, so the browser never gets a stand-in
 * that behaves differently. Only files with fixed names are written; nothing is removed.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { builtinModules } from "node:module";

import { build } from "esbuild";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYGROUND = join(ROOT, "playground");
/** The built in profiles, as `src/llm-profile.ts` lists them. */
const PROFILES = ["anthropic", "gemini", "openai"];
/** The files a build writes, by name. */
export const OUTPUT_FILES = ["index.html", "style.css", "app.js", "worker.js"];

/** Node's built in modules, as Node lists them, with and without the `node:` prefix. */
const BUILTINS = new Set(builtinModules.flatMap((m) => (m.startsWith("node:") ? [m, m.slice(5)] : [m, `node:${m}`])));

/** True for an import of a built in module, like `fs`, `node:fs` or `fs/promises`. */
export function isBuiltin(path) {
  return BUILTINS.has(path) || path.startsWith("node:");
}

/** Node's globals that the browser doesn't have. */
const NODE_GLOBALS = new Set(["process", "Buffer", "__dirname", "__filename", "require", "global"]);

/**
 * The Node globals a TypeScript source refers to, by line. Only references count: a property
 * like `x.process`, a key, a name being declared or text in a string or comment doesn't.
 */
export function nodeGlobals(source, fileName = "source.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && isReference(node)) {
      found.push(`${node.text} on line ${String(file.getLineAndCharacterOfPosition(node.getStart()).line + 1)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function isReference(node) {
  const p = node.parent;
  if (p === undefined) return true;
  if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) && p.name === node) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return false;
  return true;
}

const ownCode = (path) => path !== "" && !path.split(sep).includes("node_modules");

/**
 * Fails the build when the repository's own code imports a Node built in module or refers to a
 * Node global, like `process` or `Buffer`. Bundled packages, like the TypeScript compiler, guard
 * their own use of Node.
 */
const browserOnly = {
  name: "browser-only",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (!ownCode(args.importer) || !isBuiltin(args.path)) return undefined;
      return {
        errors: [{ text: `${relative(ROOT, args.importer)} imports ${args.path}, which the browser doesn't have` }],
      };
    });
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      if (!ownCode(args.path)) return undefined;
      const found = nodeGlobals(readFileSync(args.path, "utf8"), args.path);
      if (found.length === 0) return undefined;
      return {
        errors: found.map((f) => ({ text: `${relative(ROOT, args.path)} uses the Node global ${f}, which the browser doesn't have` })),
      };
    });
  },
};

/** `strictgen:profiles`: the text of each built in profile file, by name. */
const profiles = {
  name: "profiles",
  setup(b) {
    b.onResolve({ filter: /^strictgen:profiles$/ }, () => ({ path: "profiles", namespace: "strictgen" }));
    b.onLoad({ filter: /.*/, namespace: "strictgen" }, () => {
      const texts = Object.fromEntries(PROFILES.map((p) => [p, readFileSync(join(ROOT, "profiles", `${p}.json`), "utf8")]));
      return { contents: `export default ${JSON.stringify(texts)};`, loader: "js" };
    });
  },
};

const COMMON = {
  bundle: true,
  minify: true,
  platform: "browser",
  target: ["es2022"],
  // Keeps the licence notices of bundled code, like the TypeScript compiler's.
  legalComments: "eof",
  charset: "ascii",
  logLevel: "silent",
  plugins: [browserOnly, profiles],
  tsconfig: join(PLAYGROUND, "tsconfig.json"),
};

/**
 * Bundles one entry point for the browser, as the playground build does, and returns the code.
 * Rejects with esbuild's errors, like an import of a Node built in module.
 */
export async function bundle(entry, format) {
  const result = await build({ ...COMMON, entryPoints: [resolve(ROOT, entry)], format, write: false, outdir: "out" });
  const file = result.outputFiles[0];
  if (result.outputFiles.length !== 1 || file === undefined) throw new Error(`${entry} bundled to ${String(result.outputFiles.length)} files`);
  return file.text;
}

/** Builds the playground into `out` and returns the size of each file written, by name. */
export async function buildPlayground(out) {
  // Both bundles are made before anything is written.
  const app = await bundle(join(PLAYGROUND, "src", "app.ts"), "esm");
  const worker = await bundle(join(PLAYGROUND, "src", "worker.ts"), "iife");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "app.js"), app);
  writeFileSync(join(out, "worker.js"), worker);
  copyFileSync(join(PLAYGROUND, "index.html"), join(out, "index.html"));
  copyFileSync(join(PLAYGROUND, "style.css"), join(out, "style.css"));
  return Object.fromEntries(OUTPUT_FILES.map((f) => [f, statSync(join(out, f)).size]));
}

function usage(message) {
  process.stderr.write(`${message}\nusage: node scripts/playground-build.mjs [--out <dir>]\n`);
  process.exit(2);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let out = join(PLAYGROUND, "dist");
  if (args.length === 2 && args[0] === "--out" && args[1] !== "") out = resolve(args[1]);
  else if (args.length !== 0) usage(`unknown arguments: ${args.join(" ")}`);
  try {
    const sizes = await buildPlayground(out);
    for (const [name, size] of Object.entries(sizes)) process.stdout.write(`${name}  ${String(Math.ceil(size / 1024))} KiB\n`);
    process.stdout.write(`built the playground in ${relative(process.cwd(), out) || "."}\n`);
  } catch (error) {
    const errors = error?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      for (const e of errors) process.stderr.write(`playground build: ${e.text}\n`);
    } else {
      process.stderr.write(`playground build: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  }
}
