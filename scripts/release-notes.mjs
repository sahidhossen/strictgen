#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section of one version, without its heading, for the GitHub release:
 *
 *   node scripts/release-notes.mjs <version> [--dry-run]
 *
 * The section is the one headed `## [<version>] - YYYY-MM-DD`, up to the next `## ` heading. It
 * fails (exit 1, one line) when there is no such heading, when there are two, or when the section
 * is empty, so a release can't go out without its notes. `--dry-run` falls back to the
 * `## [Unreleased]` section, with a notice on stderr, so the release workflow's dry run works
 * before a version has been written into the changelog.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The body of the section headed `## [<name>]`, `## [<name>] - <date>` for a version. */
export function section(changelog, name) {
  const lines = changelog.split("\n");
  const heading = name === "Unreleased" ? /^## \[Unreleased\]\s*$/ : new RegExp(`^## \\[${name.replace(/[.+]/g, "\\$&")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`);
  const starts = lines.flatMap((l, i) => (heading.test(l) ? [i] : []));
  if (starts.length === 0) throw new Error(`CHANGELOG.md has no "## [${name}]${name === "Unreleased" ? "" : " - YYYY-MM-DD"}" heading`);
  if (starts.length > 1) throw new Error(`CHANGELOG.md has ${String(starts.length)} "## [${name}]" headings`);
  const start = starts[0] + 1;
  const next = lines.findIndex((l, i) => i >= start && /^## /.test(l));
  const body = lines.slice(start, next < 0 ? undefined : next).join("\n").trim();
  if (body === "") throw new Error(`the CHANGELOG.md section of ${name} is empty`);
  return `${body}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  // --changelog <file> reads another file, for the tests.
  const at = args.indexOf("--changelog");
  const file = at >= 0 ? args[at + 1] : join(ROOT, "CHANGELOG.md");
  const rest = args.filter((a, i) => a !== "--dry-run" && (at < 0 || (i !== at && i !== at + 1)));
  if (rest.length !== 1 || file === undefined || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(rest[0])) {
    process.stderr.write("usage: node scripts/release-notes.mjs <version> [--dry-run] [--changelog <file>]\n");
    process.exit(2);
  }
  const changelog = readFileSync(file, "utf8");
  try {
    process.stdout.write(section(changelog, rest[0]));
  } catch (error) {
    if (!dryRun) {
      process.stderr.write(`release-notes: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`release-notes: ${error.message}; the dry run uses [Unreleased]\n`);
    try {
      process.stdout.write(section(changelog, "Unreleased"));
    } catch (inner) {
      process.stderr.write(`release-notes: ${inner.message}\n`);
      process.exit(1);
    }
  }
}

main();
