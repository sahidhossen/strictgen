// Regenerates the example under examples/basic from its schemas, or checks that the committed
// output matches. Runs against the built package, so `pnpm build` first:
//
//   node --experimental-strip-types scripts/examples.ts           write the output
//   node --experimental-strip-types scripts/examples.ts --check   fail if the output differs
//
// `pnpm examples` and `pnpm examples:check` build and run it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { EmittedFile, IdRule, OutputFile, Target } from "../dist/index.js";
import {
  emitGo,
  emitGoAttributes,
  emitGoFixtures,
  emitRust,
  emitRustFixtures,
  emitTypeScript,
  generate,
  GO_FIXTURES,
  HEADER,
  loadSchemas,
  writeOutput,
} from "../dist/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "basic");
/** The Rust crate the generated modules live in, as `examples/basic/rust/Cargo.toml` names it. */
const CRATE = "example_basic";
const IDS: IdRule = { file: "common", suffix: "Id" };

function under(dir: string, files: readonly EmittedFile[]): OutputFile[] {
  return files.map((f) => ({ path: `${dir}/${f.name}`, contents: f.contents }));
}

/**
 * TypeScript and Rust write to folders they own. Go shares its folder with the hand written
 * `go.mod` and fixture test, so only the generated files there are replaced.
 */
const TARGETS: readonly Target[] = [
  {
    name: "typescript",
    dirs: ["ts/generated"],
    emit: (model) => under("ts/generated", emitTypeScript(model)),
  },
  {
    name: "rust",
    dirs: ["rust/src/generated", "rust/tests/generated"],
    emit: (model) => [
      ...under("rust/src/generated", emitRust(model)),
      { path: "rust/tests/generated/registry.rs", contents: emitRustFixtures(model, CRATE) },
    ],
  },
  {
    name: "go",
    dirs: [],
    shared: ["go"],
    emit: (model) => {
      const files = emitGo(model);
      return [
        ...under("go", files),
        { path: `go/${GO_FIXTURES}`, contents: emitGoFixtures(model) },
        {
          path: "go/.gitattributes",
          contents: emitGoAttributes([...files.map((f) => f.name), GO_FIXTURES]),
        },
      ];
    },
  },
];

function run(): OutputFile[] {
  return generate(loadSchemas(join(ROOT, "schemas")), TARGETS, { ids: IDS });
}

/** Every file below `dir`, as paths relative to the example root. */
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [relative(ROOT, path)];
  });
}

/** The differences between `files` and what is on disk, one line each. */
function differences(files: readonly OutputFile[]): string[] {
  const out: string[] = [];
  const expected = new Set(files.map((f) => f.path));
  for (const file of files) {
    const path = join(ROOT, file.path);
    if (!existsSync(path)) out.push(`missing: ${file.path}`);
    else if (readFileSync(path, "utf8") !== file.contents) out.push(`differs: ${file.path}`);
  }
  const owned = TARGETS.flatMap((t) => t.dirs).flatMap((dir) => walk(join(ROOT, dir)));
  const shared = TARGETS.flatMap((t) => t.shared ?? []).flatMap((dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(dir, e.name))
      .filter((path) => readFileSync(join(ROOT, path), "utf8").startsWith(`${HEADER}\n`)),
  );
  for (const path of [...owned, ...shared].sort()) {
    if (!expected.has(path.split("\\").join("/"))) out.push(`stale: ${path}`);
  }
  return out;
}

const check = process.argv.includes("--check");
const files = run();
const again = run();
if (JSON.stringify(files) !== JSON.stringify(again)) {
  process.stderr.write("examples: two runs gave different output\n");
  process.exit(1);
}
if (check) {
  const found = differences(files);
  if (found.length > 0) {
    process.stderr.write(
      `examples: the committed output is out of date, run pnpm examples\n${found.join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`examples: ${String(files.length)} files up to date\n`);
} else {
  writeOutput(ROOT, TARGETS, files);
  process.stdout.write(`examples: wrote ${String(files.length)} files\n`);
}
