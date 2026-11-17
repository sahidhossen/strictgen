#!/usr/bin/env node
/**
 * Builds strictgen as one executable file for the platform it runs on, with Node's single
 * executable applications: the CLI bundled into one script, then injected into a copy of the
 * running `node` binary. The binary needs no Node, npm or package folder; `rustfmt` and `gofmt`
 * stay external, found on the PATH as they are for the npm package.
 *
 *   pnpm build && node scripts/binary-build.mjs [--out <dir>] [--node <version>]   (default dist-bin, which git ignores)
 *
 * It writes `strictgen-<os>-<arch>` (`.exe` on Windows), named after `process.platform` and
 * `process.arch`, and prints its path. `package.json` and the built in profiles are embedded as
 * assets under their paths from the package root; `src/package-files.ts` reads them there. Only
 * files with fixed names in the output folder are written; nothing is removed.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The fuse Node checks to find an injected blob, from Node's single executable docs. */
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
/** The platforms the release builds, as `process.platform`/`process.arch` and file names. */
const TARGETS = {
  "darwin-arm64": "strictgen-macos-arm64",
  "darwin-x64": "strictgen-macos-x64",
  "linux-arm64": "strictgen-linux-arm64",
  "linux-x64": "strictgen-linux-x64",
  "win32-x64": "strictgen-windows-x64.exe",
};

function fail(message) {
  process.stderr.write(`binary-build: ${message}\n`);
  process.exit(1);
}

function run(command, args, cwd = undefined) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd });
  if (result.error !== undefined) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(" ")} exited with ${String(result.status)}`);
}

/** The options: `--out <dir>`, and `--node <version>`, the Node version the build must run on. */
function options(argv) {
  const usage = "usage: node scripts/binary-build.mjs [--out <dir>] [--node <version>]";
  const found = { out: join(ROOT, "dist-bin"), node: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined || value === "") fail(usage);
    if (argv[i] === "--out") found.out = resolve(value);
    else if (argv[i] === "--node") found.node = value.trim();
    else fail(usage);
  }
  return found;
}

async function main() {
  const { out, node } = options(process.argv.slice(2));
  // The binary embeds this Node, so CI pins it and the release notes name it.
  if (node !== undefined && process.version !== `v${node}`) fail(`running on Node ${process.version}, not v${node}`);
  const name = TARGETS[`${process.platform}-${process.arch}`];
  if (name === undefined) fail(`no binary for ${process.platform}-${process.arch}`);
  // The asset list comes from the compiled code, so the embedded files are the ones it reads.
  let files;
  try {
    ({ PACKAGE_FILES: files } = await import(pathToFileURL(join(ROOT, "dist", "package-files.js")).href));
  } catch {
    fail("dist/package-files.js is missing: run pnpm build first");
  }
  mkdirSync(out, { recursive: true });

  // Single executables run one CommonJS script. import.meta.url has no value there, which is why
  // the code reads its package files from the embedded assets inside a binary.
  const bundle = join(out, "strictgen.cjs");
  await build({
    entryPoints: [join(ROOT, "src", "cli.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "error",
    logOverride: { "empty-import-meta": "silent" },
    legalComments: "none",
  });

  // Node keeps the path of `main` in the blob, so every path in the config is relative to the
  // output folder, where Node runs: an absolute path would put the build machine's folders into
  // the binary. Asset keys are the paths from the package root either way.
  const blob = join(out, "strictgen.blob");
  const config = join(out, "sea-config.json");
  const portable = (path) => {
    const from = relative(out, path);
    // On Windows, an output folder on another drive than the checkout has no relative path.
    if (isAbsolute(from)) fail(`${path} has no path relative to the output folder ${out}; build into a folder on the same drive`);
    return from.split("\\").join("/");
  };
  const assets = Object.fromEntries(files.map((f) => [f, portable(join(ROOT, f))]));
  writeFileSync(
    config,
    `${JSON.stringify({ main: portable(bundle), output: portable(blob), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2)}\n`,
  );
  run(process.execPath, ["--experimental-sea-config", "sea-config.json"], out);

  const binary = join(out, name);
  copyFileSync(process.execPath, binary);
  chmodSync(binary, 0o755);
  // macOS refuses to run a signed binary whose contents changed: drop Node's signature first,
  // then sign the result ad hoc (no identity), which Apple silicon needs to run it at all.
  if (process.platform === "darwin") run("codesign", ["--remove-signature", binary]);
  const { inject } = createRequire(import.meta.url)("postject");
  await inject(binary, "NODE_SEA_BLOB", readFileSync(blob), {
    sentinelFuse: FUSE,
    ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (process.platform === "darwin") run("codesign", ["--sign", "-", binary]);
  process.stdout.write(`${binary}\n`);
}

await main();
