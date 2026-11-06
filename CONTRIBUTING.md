# Contributing to strictgen

Thanks for your interest. strictgen is early, so please open an issue before starting on anything larger than a small fix, so we can agree on the approach.

## Setup

You need Node.js 22 or later and pnpm 10. The cross-language checks also need a stable Rust toolchain and Go.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm conformance   # every conformance case in Rust, Go and TypeScript, see conformance/README.md
pnpm fuzz --seed 1 --runs 3000   # random payloads through every decoder, as CI runs it
pnpm docs:check   # the README and docs snippets match real output
```

With rustup, `RUSTUP_TOOLCHAIN=1.97.0` in front of a command picks the Rust toolchain CI uses.

## The proof suite

Every change to what a decoder accepts, rejects or reports goes through the [conformance suite](conformance/README.md), which runs each case through Rust, Go and TypeScript and fails on any difference, and the differential fuzzer, which does the same with random payloads.

- **A new construct or keyword** needs cases in `conformance/cases`: a valid one and an invalid one per mapping rule, and an invalid one per new error code. The suite fails on a rule or code without a case, and `pnpm conformance --coverage` shows what each rule has. [Adding a case](conformance/README.md#adding-a-case) walks through it
- **A fuzzer failure** prints the seed and the run. `pnpm fuzz --seed <seed> --start <run> --runs 1` runs it alone, and `--save <language>` keeps the shrunk payload as a case, with the language the spec says is right as the expectation. Fix the generator in the same pull request ([Fuzzing](conformance/README.md#fuzzing))
- **A known difference**, like TypeScript integers past 2^53 - 1, gets a mark in `conformance/marks.json` with its reason, never a skip. A mark no case needs fails the run

The nightly workflow runs the fuzzer with random seeds and opens an issue when it finds a disagreement, or comments on the one already open.

## Docs

The snippets in `README.md` and `docs/` are real output: files, generated code, command output, and what the Rust, Go and TypeScript programs of `examples/quickstart` print. Each sits between `<!-- snippet: ... -->` and `<!-- /snippet -->` markers, and `src/snippets.ts` lists the kinds. After a change, `pnpm docs` writes them again. `pnpm docs:check` fails in CI when one is out of date, and `pnpm test` checks the ones that need no Rust or Go. Don't edit inside the markers by hand.

## Ground rules

- **Languages never drift.** A schema construct, validation keyword or error code changes in the model, every emitter, the unit tests and the conformance fixtures in the same pull request. A difference between languages is a bug, never a skip
- **Output is deterministic.** The same input always gives byte-identical output. No clocks, locales or unordered iteration
- **Unsupported means an error.** Anything outside the supported subset fails generation with the schema file and JSON pointer. Nothing is silently ignored
- **Tests first.** Add a failing unit test with a small inline schema, then make it pass. One `describe` per mapping rule

## Pull requests

- One issue per pull request. Reference it with `Closes #123`
- Use [Conventional Commits](https://www.conventionalcommits.org/) for titles: `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`, `refactor:`
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-facing changes
- Call out any change to generated output. It's a breaking change unless it fixes a bug the conformance suite caught
- CI must be green before merge

## Versioning

strictgen follows [semantic versioning](https://semver.org/). What counts as breaking is stricter than usual, because generated code is checked in and compared in CI:

- **Major:** any change to generated output or to the error codes, unless it only fixes a bug the conformance suite or the fuzzer caught
- **Minor:** new commands, new options, newly supported constructs that leave existing output as it is, and LLM profile updates
- **Patch:** bug fixes, including output changes for bugs the conformance suite or the fuzzer caught

Before 1.0.0 the version is 0.x, and a minor version counts as breaking.

## Releases

Only maintainers release, and only by pushing a tag. The steps:

1. A pull request sets `version` in `package.json` and renames `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] - YYYY-MM-DD`, with a new empty `[Unreleased]` above it. Merge it when CI is green
2. Tag the merge commit on `main` and push the tag: `git tag vx.y.z && git push origin vx.y.z`
3. The [release workflow](.github/workflows/release.yml) runs

The release workflow publishes nothing until all of these hold: the repository is public, the `NPM_TOKEN` secret is set, the tag equals `v` plus the `package.json` version, the tagged commit is on `main`, `CHANGELOG.md` has a dated section for the version, and all of CI passes on the tagged commit (tests, the conformance suite, the fixed-seed fuzz run, the docs and examples checks, hygiene, the npm package check and every binary). Then it publishes to npm with provenance and creates the GitHub release with the binaries, `SHA256SUMS` and the changelog section as notes. A version with a prerelease part, like `1.0.0-rc.1`, goes to npm's `next` tag and is marked a prerelease.

**Dry run.** Run the workflow by hand (Actions, Release, Run workflow) with `dry_run` checked. It runs every check and all of CI, builds the binaries, the sums, the notes (from `[Unreleased]` when the version has no section yet) and the npm tarball, and keeps them as the `release` artifact for seven days. The publish jobs are skipped. It works in a private repository and without `NPM_TOKEN`.

**The publish guard.** `npm publish` runs `scripts/publish-guard.mjs` first (`prepublishOnly`). It stops unless it runs in GitHub Actions, in this repository, in the release workflow, for the tag of the `package.json` version. `publishConfig.provenance` is a second lock: npm can only sign provenance in a CI with an OIDC token, so a publish from a laptop fails there too. Both stop accidents, not someone determined (`--ignore-scripts --provenance=false` gets past them).

**Checking the package.** `pnpm package:check` checks the exact file list of `npm pack` (`dist/` without the conformance runner, the docs tools or source maps, plus `profiles/`, `README.md`, `LICENSE`, `CHANGELOG.md` and `package.json`), then installs the tarball offline into an empty project and runs `npx strictgen --version`, a built in profile and `import("strictgen")` there.

### Single binaries

The binaries are [Node single executable applications](https://nodejs.org/api/single-executable-applications.html). `scripts/binary-build.mjs` bundles the CLI into one CommonJS file with esbuild, embeds `package.json` and the built in profiles as assets, and injects the result into a copy of the `node` binary that runs the build (with `postject`; on macOS the copy is signed again ad hoc). Each platform builds on its own runner: macOS arm64 and x64, Linux x64 and arm64, Windows x64. `rustfmt` and `gofmt` stay external.

```bash
pnpm binary                                        # dist-bin/strictgen-<os>-<arch>
node scripts/binary-smoke.mjs dist-bin/strictgen-macos-arm64
```

`scripts/binary-smoke.mjs` checks a binary against `node dist/cli.js`: `--version`, `--help` and `llm --profile openai` print the same, `check` passes on `examples/basic` and `examples/quickstart`, and `generate` writes byte-identical files for every example. CI runs it for every platform on every pull request.

Why Node's single executables:

- **Node SEA** runs the same Node and the same code as the npm package, so a binary can't behave differently from `npx strictgen`, and the smoke test holds it to that. It needs one build per platform, and a binary is about 100 MB
- **`bun build --compile`** gives smaller binaries and cross-compiles from one machine, but runs on Bun's runtime, whose `node:fs`, `node:child_process` and JSON details would need their own proof that the output is the same
- **pkg** is no longer maintained and stops at older Node versions

## Reporting bugs

Use the bug report template. The most useful report is a small schema plus a payload that one language accepts and another rejects, or that gives different errors.

For security issues, see [SECURITY.md](SECURITY.md) instead.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part you agree to it.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
