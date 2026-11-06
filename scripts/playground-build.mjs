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

import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYGROUND = join(ROOT, "playground");
/** The built in profiles, as `src/llm-profile.ts` lists them. */
const PROFILES = ["anthropic", "gemini", "openai"];
/** The files a build writes, by name. */
export const OUTPUT_FILES = ["index.html", "style.css", "app.js", "worker.js"];

const BUILTIN = /^node:|^(assert|buffer|child_process|crypto|events|fs|module|os|path|process|stream|url|util|worker_threads)(\/.*)?$/;

/** Fails the build on an import of a Node built in module from the repository's own code. */
const browserOnly = {
  name: "browser-only",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.importer === "" || args.importer.split(sep).includes("node_modules")) return undefined;
      if (!BUILTIN.test(args.path)) return undefined;
      return {
        errors: [{ text: `${relative(ROOT, args.importer)} imports ${args.path}, which the browser doesn't have` }],
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
