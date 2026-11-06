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

## Reporting bugs

Use the bug report template. The most useful report is a small schema plus a payload that one language accepts and another rejects, or that gives different errors.

For security issues, see [SECURITY.md](SECURITY.md) instead.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part you agree to it.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
