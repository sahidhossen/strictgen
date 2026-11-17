import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BUILTIN_PROFILES } from "./llm-profile.js";
import { inBinary, PACKAGE_FILES, packageFileText } from "./package-files.js";
import { builtinProfile } from "./profile-files.js";
import { version } from "./run.js";

const ROOT = join(import.meta.dirname, "..");
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  exports: Record<string, unknown>;
  engines: Record<string, string>;
  publishConfig: Record<string, unknown>;
  scripts: Record<string, string>;
};
/** Starting node runs a few times per test. */
const SPAWNS = 20_000;

function script(name: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  // Only PATH from this process, so a CI=true or GITHUB_REF of the test run never leaks in.
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", name), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The scripts of a workflow's `run: |` blocks, without their indentation. */
function runBlocks(workflow: string): string[] {
  const lines = workflow.split("\n");
  const blocks: string[] = [];
  for (const [i, line] of lines.entries()) {
    const m = /^(\s*)(?:- )?run: \|\s*$/.exec(line);
    if (m === null) continue;
    const body: string[] = [];
    let indent: number | undefined;
    for (const next of lines.slice(i + 1)) {
      const width = next.length - next.trimStart().length;
      if (next.trim() !== "" && width <= (m[1] ?? "").length) break;
      indent ??= next.trim() === "" ? undefined : width;
      body.push(next.slice(indent ?? 0));
    }
    blocks.push(body.join("\n").trimEnd());
  }
  return blocks;
}

describe("package files", () => {
  it("lists package.json and every built in profile, and each exists", () => {
    expect([...PACKAGE_FILES]).toEqual(["package.json", ...BUILTIN_PROFILES.map((n) => `profiles/${n}.json`)]);
    for (const f of PACKAGE_FILES) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });

  it("reads them from disk outside a binary", () => {
    expect(inBinary()).toBe(false);
    expect(packageFileText("package.json")).toBe(read("package.json"));
    expect(version()).toBe(pkg.version);
    for (const name of BUILTIN_PROFILES) expect(builtinProfile(name).name).toBe(name);
  });
});

describe("npm package", () => {
  it("is ready to publish, with provenance and the publish guard", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ strictgen: "dist/cli.js" });
    expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.scripts.prepublishOnly).toBe("node scripts/publish-guard.mjs");
    expect(pkg.files).toEqual(expect.arrayContaining(["!dist/conformance/", "!dist/snippets*", "profiles/", "CHANGELOG.md"]));
    // 0.x until 1.0 is decided; the release sets the version, never a test.
    expect(pkg.version).toMatch(/^0\./);
  });
});

describe("publish guard", () => {
  const repository = "sahidhossen/strictgen";
  const release = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_REF: `refs/tags/v${pkg.version}`,
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/tags/v${pkg.version}`,
  };

  it("lets the release workflow's tag run publish", () => {
    expect(script("publish-guard.mjs", [], release).status).toBe(0);
  }, SPAWNS);

  it("stops a publish from a laptop", () => {
    const r = script("publish-guard.mjs", []);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("npm publish only runs in GitHub Actions");
  }, SPAWNS);

  it("stops a run with any one of the release values wrong or missing", () => {
    const wrong: Record<keyof typeof release, string> = {
      CI: "1",
      GITHUB_ACTIONS: "false",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "someone/strictgen",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/tags/v${pkg.version}`,
    };
    for (const key of Object.keys(release) as (keyof typeof release)[]) {
      const { [key]: _, ...without } = release;
      expect(script("publish-guard.mjs", [], without).status, `${key} missing`).toBe(1);
      expect(script("publish-guard.mjs", [], { ...release, [key]: wrong[key] }).status, `${key} wrong`).toBe(1);
    }
  }, SPAWNS);

  it("lets every CI step that runs it pass in an ordinary run and inside the release's tag run", () => {
    const steps = runBlocks(read(".github/workflows/ci.yml")).filter((s) => s.includes("publish-guard.mjs"));
    expect(steps.length).toBeGreaterThan(0);
    for (const env of [{ CI: "true", GITHUB_ACTIONS: "true", GITHUB_REF: "refs/pull/1/merge", GITHUB_REPOSITORY: repository }, release]) {
      for (const step of steps) {
        const r = spawnSync("bash", ["-e", "-c", step], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
        expect([r.status, r.stdout, env.GITHUB_REF], step).toEqual([0, "", env.GITHUB_REF]);
      }
    }
  }, SPAWNS);

  it("stops a tag that doesn't match package.json's version", () => {
    const r = script("publish-guard.mjs", [], {
      ...release,
      GITHUB_REF: "refs/tags/v9.9.9",
      GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release.yml@refs/tags/v9.9.9`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`not refs/tags/v${pkg.version}`);
  }, SPAWNS);
});

describe("release notes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "strictgen-notes-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const changelog = (text: string): string => {
    const file = join(scratch, `${String(Math.random()).slice(2)}.md`);
    writeFileSync(file, text);
    return file;
  };
  const released = changelog(
    "# Changelog\n\n## [Unreleased]\n\n- next\n\n## [1.2.0] - 2026-11-01\n\n### Added\n\n- a\n\n## [1.1.0] - 2026-10-01\n\n- b\n\n[1.2.0]: https://example.com\n",
  );

  it("prints the section of the version, without its heading", () => {
    const r = script("release-notes.mjs", ["1.2.0", "--changelog", released]);
    expect(r).toEqual({ status: 0, stdout: "### Added\n\n- a\n", stderr: "" });
    expect(script("release-notes.mjs", ["1.1.0", "--changelog", released]).stdout).toBe("- b\n\n[1.2.0]: https://example.com\n");
  }, SPAWNS);

  it("fails for a version without a dated section, a section given twice and an empty one", () => {
    expect(script("release-notes.mjs", ["1.3.0", "--changelog", released]).status).toBe(1);
    expect(script("release-notes.mjs", ["1.2.0", "--changelog", changelog("## [1.2.0]\n\n- undated\n")]).status).toBe(1);
    expect(script("release-notes.mjs", ["1.2.0", "--changelog", changelog("## [1.2.0] - 2026-11-01\n- a\n## [1.2.0] - 2026-11-02\n- b\n")]).status).toBe(1);
    expect(script("release-notes.mjs", ["1.2.0", "--changelog", changelog("## [1.2.0] - 2026-11-01\n\n## [1.1.0] - 2026-10-01\n- b\n")]).status).toBe(1);
    expect(script("release-notes.mjs", ["latest"]).status).toBe(2);
  }, SPAWNS);

  it("falls back to [Unreleased] only in a dry run", () => {
    const r = script("release-notes.mjs", ["1.3.0", "--dry-run", "--changelog", released]);
    expect([r.status, r.stdout]).toEqual([0, "- next\n"]);
    expect(r.stderr).toContain("the dry run uses [Unreleased]");
  }, SPAWNS);
});

describe("release workflow", () => {
  const workflow = read(".github/workflows/release.yml");
  /** The text of one job, from its key to the next job's key. */
  const job = (name: string): string => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    expect(start, name).toBeGreaterThan(0);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  };
  const gate =
    "if: needs.guard.outputs.publish == 'true' && github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') && github.event.repository.visibility == 'public'";

  it("runs on v* tags and by hand for dry runs only", () => {
    expect(workflow).toContain('tags: ["v*"]');
    expect(workflow).toContain("dry_run:");
    expect(workflow).toContain("permissions: {}");
  });

  it("publishes only from jobs gated on the guard, a tag push and a public repository", () => {
    for (const [name, step] of [["npm", "npm publish \"release/strictgen-$VERSION.tgz\" --provenance"], ["github-release", "gh release create"]] as const) {
      const text = job(name);
      expect(text).toContain(gate);
      expect(text).toContain(step);
    }
    for (const name of ["guard", "ci", "assemble"]) {
      expect(job(name)).not.toContain("npm publish");
      expect(job(name)).not.toContain("gh release");
      expect(job(name)).not.toContain("contents: write");
      expect(job(name)).not.toContain("id-token");
    }
  });

  it("checks the visibility, the tag, main and the changelog before CI", () => {
    const guard = job("guard");
    for (const check of ['"$VISIBILITY" != "public"', 'gh api "repos/$GITHUB_REPOSITORY" --jq .visibility', '"refs/tags/v$version"', "merge-base --is-ancestor", 'release-notes.mjs "$version"']) {
      expect(guard, check).toContain(check);
    }
    expect(job("ci")).toContain("uses: ./.github/workflows/ci.yml");
  });

  describe("archives", () => {
    const unix = ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"];
    const archives = [...unix.map((t) => `strictgen-${t}.tar.gz`), "strictgen-windows-x64.zip"];

    it("packs every binary CI builds, and nothing else, into an archive named after its platform", () => {
      const built = [...read(".github/workflows/binaries.yml").matchAll(/"file":"(strictgen-[a-z0-9-]+)(\.exe)?"/g)].map((m) => m[1]);
      expect(built).toEqual(archives.map((a) => a.replace(/\.(tar\.gz|zip)$/, "")));
      const assemble = job("assemble");
      expect(assemble).toContain("path: binaries\n");
      expect(assemble).toContain('test "$(ls binaries | wc -l)" -eq 5');
      expect(assemble).toContain(`for target in ${unix.join(" ")}; do`);
      expect(assemble).toContain('cp "binaries/strictgen-$target" "$stage/strictgen"');
      expect(assemble).toContain('cp binaries/strictgen-windows-x64.exe "$stage/strictgen.exe"');
    });

    it("builds them reproducibly with relative member names", () => {
      const assemble = job("assemble");
      for (const flag of ["--sort=name", '--mtime="@$epoch"', "--owner=0 --group=0 --numeric-owner", "--format=ustar", '--directory="$stage"', "gzip -n", "zip -X", "TZ: UTC", 'touch --date="@$epoch"', "chmod 0755"]) {
        expect(assemble, flag).toContain(flag);
      }
      // The archive member is the bare name, never a path of the runner.
      expect(assemble).toContain("--numeric-owner strictgen | gzip");
      expect(assemble).toContain('zip -X -9 -q "$GITHUB_WORKSPACE/release/strictgen-windows-x64.zip" strictgen.exe)');
    });

    it("checks each archive's contents and runs the linux-x64 binary from its archive", () => {
      const assemble = job("assemble");
      expect(assemble).toContain('test "$(tar --list --gzip --file="$archive")" = "strictgen"');
      expect(assemble).toContain('cmp "$out/strictgen" "binaries/strictgen-$target"');
      expect(assemble).toContain('test "$(unzip -Z1 release/strictgen-windows-x64.zip)" = "strictgen.exe"');
      expect(assemble).toContain('cmp "$out/strictgen.exe" binaries/strictgen-windows-x64.exe');
      expect(assemble).toContain("--file=release/strictgen-linux-x64.tar.gz");
      expect(assemble).toContain('printed="$("$out/strictgen" --version)"');
      expect(assemble).toContain('"$printed" != "$VERSION"');
      expect(assemble.indexOf("name: Check the archives")).toBeLessThan(assemble.indexOf("SHA256SUMS"));
    });

    it("sums the archives, keeps the Node version line in the notes and attaches only the archives", () => {
      const assemble = job("assemble");
      expect(assemble).toContain("sha256sum strictgen-*.tar.gz strictgen-*.zip > SHA256SUMS");
      expect(assemble).toContain('test "$(wc -l < release/SHA256SUMS)" -eq 5');
      expect(assemble).toContain("The binaries are Node single executable applications built with Node %s.");
      const attached = [...job("github-release").matchAll(/release\/(strictgen-[^\s\\]+|SHA256SUMS)/g)].map((m) => m[1]);
      expect(attached).toEqual([...archives, "SHA256SUMS"]);
    });

    it("are the downloads the README names", () => {
      const readme = read("README.md");
      for (const archive of archives) expect(readme, archive).toContain(`\`${archive}\``);
      expect(readme).not.toMatch(/strictgen-(macos|linux)-(arm64|x64)(?!\.tar\.gz)\b/);
      expect(readme).not.toContain("strictgen-windows-x64.exe");
    });
  });

  it("keeps the npm token in the release environment, seen only by the npm job, which checks it", () => {
    const npm = job("npm");
    expect(npm).toContain("environment: release");
    expect(npm).toContain('"$TOKEN_SET" != "true"');
    expect(npm.indexOf('"$TOKEN_SET" != "true"')).toBeLessThan(npm.indexOf("npm publish"));
    for (const name of ["guard", "ci", "assemble", "github-release"]) {
      expect(job(name), name).not.toContain("environment:");
      expect(job(name), name).not.toContain("NPM_TOKEN");
    }
  });
});
