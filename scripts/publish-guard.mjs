#!/usr/bin/env node
/**
 * The `prepublishOnly` guard: `npm publish` stops here unless it runs in the release workflow,
 * for a `v<version>` tag that matches package.json. It makes a publish from a laptop, from
 * another workflow or from a branch fail before anything is uploaded.
 *
 *   node scripts/publish-guard.mjs     (npm runs it before `npm publish`)
 *
 * It is one of two locks. `publishConfig.provenance` is the other: npm can only make a provenance
 * statement inside a supported CI with an OIDC token, so a publish outside one fails there too.
 * Neither stops someone who means to get past them (`--ignore-scripts --provenance=false`); they
 * stop accidents.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The only workflow that may publish, as GITHUB_WORKFLOW_REF names it after the repository. */
export const RELEASE_WORKFLOW = ".github/workflows/release.yml";

/** `owner/name` of a `git+https://github.com/owner/name.git` repository URL, or undefined. */
export function githubRepository(url) {
  const m = /^git\+https:\/\/github\.com\/([^/]+\/[^/]+?)\.git$/.exec(url ?? "");
  return m?.[1];
}

/** Why publishing `pkg` with the environment `env` must stop: one line each, empty when it may go. */
export function publishProblems(env, pkg) {
  const problems = [];
  const tag = `refs/tags/v${String(pkg.version)}`;
  const repository = githubRepository(pkg.repository?.url);
  if (env.CI !== "true" || env.GITHUB_ACTIONS !== "true") {
    problems.push("npm publish only runs in GitHub Actions; push a v* tag to release");
  }
  if (env.GITHUB_REF !== tag) {
    problems.push(`GITHUB_REF is ${JSON.stringify(env.GITHUB_REF ?? "")}, not ${tag}, the tag of package.json's version`);
  }
  if (repository === undefined) {
    problems.push("package.json repository.url is not a GitHub repository");
  } else {
    if (env.GITHUB_REPOSITORY !== repository) {
      problems.push(`GITHUB_REPOSITORY is ${JSON.stringify(env.GITHUB_REPOSITORY ?? "")}, not ${repository}`);
    }
    const workflow = `${repository}/${RELEASE_WORKFLOW}@${tag}`;
    if (env.GITHUB_WORKFLOW_REF !== workflow) {
      problems.push(`GITHUB_WORKFLOW_REF is ${JSON.stringify(env.GITHUB_WORKFLOW_REF ?? "")}, not ${workflow}`);
    }
  }
  if (pkg.private === true) problems.push("package.json is private");
  if (pkg.publishConfig?.provenance !== true) problems.push("package.json publishConfig.provenance must be true");
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const problems = publishProblems(process.env, pkg);
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`publish-guard: ${p}\n`);
    process.stderr.write("publish-guard: not publishing. Releases are made by the release workflow from a v* tag.\n");
    process.exit(1);
  }
}
