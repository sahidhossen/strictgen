#!/usr/bin/env node
/**
 * Serves a built playground on this machine only, since browsers don't start workers from
 * file:// pages.
 *
 *   node scripts/playground-serve.mjs [--dir <dir>] [--port <port>]   (default playground/dist, 4173)
 *
 * It serves only the files the build writes, by name, from 127.0.0.1, and nothing else.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {
  "index.html": "text/html; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "worker.js": "text/javascript; charset=utf-8",
};

// A closed stdout or stderr, like `| head`, doesn't stop the server or print a stack trace: the
// line it prints is only a note.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code !== "EPIPE") process.exit(1);
  });
}

function usage(message) {
  process.stderr.write(`${message}\nusage: node scripts/playground-serve.mjs [--dir <dir>] [--port <port>]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let dir = join(ROOT, "playground", "dist");
let port = 4173;
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (value === undefined) usage(`${args[i]} needs a value`);
  if (args[i] === "--dir") dir = resolve(value);
  else if (args[i] === "--port" && /^[0-9]{1,5}$/.test(value) && Number(value) <= 65535) port = Number(value);
  else usage(`unknown argument ${args[i]} ${value}`);
}

const files = {};
for (const name of Object.keys(TYPES)) {
  try {
    files[name] = readFileSync(join(dir, name));
  } catch {
    usage(`no ${name} in ${dir}: run pnpm playground:build first`);
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  const name = path === "/" ? "index.html" : path.slice(1);
  const body = Object.hasOwn(files, name) ? files[name] : undefined;
  if ((req.method !== "GET" && req.method !== "HEAD") || body === undefined) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[name], "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : body);
});
server.on("error", (error) => {
  process.stderr.write(`playground serve: ${error.message}\n`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`serving the playground at http://127.0.0.1:${String(port)}/ (files read once at start; ctrl-c stops)\n`);
});
