import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { builtinProfileFile } from "../../src/profile-files.js";
import { transpiler } from "./decode.js";
import { STYLE_NONCE } from "./editor.js";
import { SAMPLE } from "./sample.js";
import type { Request, Response } from "./session.js";
import { respond, Session } from "./session.js";
import { PROFILES } from "./state.js";

const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "playground-build.mjs");
/** Bundling the TypeScript compiler takes a few seconds. */
const TIMEOUT = 120_000;
/**
 * The most app.js may weigh, minified: the page and CodeMirror with its JSON, Rust, Go and
 * TypeScript modes, about 580 KiB. A jump past this means a dependency pulled in more than it should.
 */
const APP_BUDGET = 700 * 1024;

let out = "";

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "strictgen-playground-"));
  const run = spawnSync(process.execPath, [SCRIPT, "--out", out], { encoding: "utf8", timeout: TIMEOUT });
  if (run.status !== 0) throw new Error(`the build failed: ${run.stderr}`);
}, TIMEOUT);

afterAll(() => {
  if (out !== "") rmSync(out, { recursive: true, force: true });
});

/** Runs the built worker in a fresh context, as a browser would, and returns what it posts for each request. */
function runWorker(requests: readonly Request[]): unknown[] {
  const posted: unknown[] = [];
  const self: { onmessage: ((e: { data: Request }) => void) | null; postMessage: (m: unknown) => void } = {
    onmessage: null,
    postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))),
  };
  runInNewContext(readFileSync(join(out, "worker.js"), "utf8"), { self, TextEncoder, TextDecoder, console });
  for (const data of requests) self.onmessage?.({ data });
  return posted;
}

const PROFILE_TEXTS = Object.fromEntries(PROFILES.map((p) => [p, readFileSync(builtinProfileFile(p), "utf8")]));

function schemas(dir: string): Request["input"]["schemas"] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

describe("the playground build", () => {
  it("writes the page, its style, the app and the worker, and nothing else", () => {
    expect(readdirSync(out).sort()).toEqual(["app.js", "index.html", "style.css", "worker.js"]);
  });

  it("has a strict content security policy and loads nothing from elsewhere", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const csp = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
    expect(csp?.split("; ")).toEqual([
      "default-src 'none'",
      "script-src 'self'",
      "worker-src 'self'",
      // CodeMirror adds one style element at run time, carrying this nonce (editor.ts).
      `style-src 'self' 'nonce-${STYLE_NONCE}'`,
      "img-src 'self'",
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
    const refs = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
    expect(refs).toEqual(["./style.css", "./app.js"]);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
    // The only URLs in the page's code are the example schema's $id values, never fetched.
    expect(readFileSync(join(out, "style.css"), "utf8")).not.toMatch(/url\(|@import/);
    // worker.js names these once, in the names hidden from the generated code (decode.ts SHADOWED).
    for (const file of ["app.js", "worker.js"]) {
      expect(readFileSync(join(out, file), "utf8"), file).not.toMatch(
        /\bfetch\(|new (XMLHttpRequest|WebSocket|EventSource)\b|importScripts\(|sendBeacon/,
      );
    }
  });

  it("sets user text with textContent or as an editor's text, never as markup, in its own code and in the bundle", () => {
    for (const file of ["app.ts", "editor.ts", "locate.ts"]) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      expect(source, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\("style"/);
    }
    // Nor does any bundled package, CodeMirror included.
    expect(readFileSync(join(out, "app.js"), "utf8")).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/);
  });

  it("keeps app.js within its size budget", () => {
    const size = statSync(join(out, "app.js")).size;
    expect(size).toBeLessThan(APP_BUDGET);
    expect(size).toBeGreaterThan(100 * 1024);
  });

  it(
    "runs in a worker context and answers as the session does in Node, for the example and examples/basic",
    () => {
      const basic: Request = {
        id: 2,
        input: {
          schemas: schemas(join(ROOT, "examples", "basic", "schemas")),
          read: "report",
          profiles: ["openai"],
          cleanup: true,
          serdeBridge: true,
          ids: { file: "common", suffix: "Id" },
        },
        type: "Order",
        decoder: "normal",
        payload: '{"id": 5, "extra": true}',
      };
      const sample: Request = { id: 1, input: SAMPLE, type: SAMPLE.type, decoder: SAMPLE.decoder, payload: SAMPLE.payload };
      const posted = runWorker([sample, basic]);
      const node = new Session(transpiler(ts), PROFILE_TEXTS);
      const want = [respond(node, sample), respond(node, basic)].map((r) => JSON.parse(JSON.stringify(r)) as Response);
      expect(posted[0]).toEqual({ ready: true });
      expect(posted.slice(1)).toEqual(want);
      const first = want[0];
      expect(first?.decoded).toMatchObject({ kind: "rejected", error: { path: "/lines/1/quantity", code: "too_small" } });
      expect(first?.generated.ok === true ? first.generated.outputs.llm.length : 0).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    "exits quietly when the reader of the build's output goes away",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "strictgen-playground-pipe-"));
      try {
        const child = spawn(process.execPath, [SCRIPT, "--out", dir], { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.destroy();
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        const code = await new Promise<number | null>((done) => child.on("close", done));
        expect(stderr).toBe("");
        expect(code).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it("posts a failure instead of throwing on a broken request", () => {
    const posted = runWorker([{ id: 3 } as unknown as Request]);
    expect(posted[1]).toMatchObject({ id: 3, failure: expect.any(String) as unknown });
  });

  it(
    "refuses code that imports a Node built in module or uses a Node global, and takes the in-memory generator",
    () => {
      const check = (entry: string) =>
        spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { bundle } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};\n` +
              `await bundle(${JSON.stringify(entry)}, "esm").then(() => console.log("ok"), (e) => console.log(e.errors?.map((x) => x.text).join("\\n") ?? String(e)));`,
          ],
          { encoding: "utf8", timeout: TIMEOUT },
        ).stdout.trim();
      expect(check("src/config.ts")).toMatch(/^src\/config\.ts uses the Node global process on line \d+, which the browser doesn't have$/m);
      expect(check("src/targets.ts").split("\n")).toContain("src/targets.ts imports node:path, which the browser doesn't have");
      expect(check("src/memory.ts")).toBe("ok");
      // Any built in module Node lists, with or without the prefix, and the globals it adds.
      const dir = mkdtempSync(join(tmpdir(), "strictgen-guard-"));
      try {
        const entry = (name: string, text: string): string => {
          writeFileSync(join(dir, name), text);
          return join(dir, name);
        };
        const imports = entry("imports.ts", 'import "fs/promises";\nimport "worker_threads";\nimport "node:sqlite";\n');
        expect(check(imports).split("\n").map((l) => l.replace(/^.* imports /, ""))).toEqual([
          "fs/promises, which the browser doesn't have",
          "worker_threads, which the browser doesn't have",
          "node:sqlite, which the browser doesn't have",
        ]);
        const globals = entry(
          "globals.ts",
          'export const a = process.env.X;\nexport const b = Buffer.from("x");\n' +
            'export const c = { process: 1 }.process;\nexport const d = "process Buffer"; // process\n',
        );
        expect(check(globals).split("\n").map((l) => l.replace(/^.* uses /, ""))).toEqual([
          "the Node global process on line 1, which the browser doesn't have",
          "the Node global Buffer on line 2, which the browser doesn't have",
        ]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
