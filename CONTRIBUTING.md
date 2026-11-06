# Contributing to strictgen

Thanks for your interest. strictgen is early, so please open an issue before starting on anything larger than a small fix, so we can agree on the approach.

## Setup

You need Node.js 22 or later and pnpm 10. The cross-language checks also need a stable Rust toolchain and Go.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm conformance   # every conformance case in Rust, Go and TypeScript, see conformance/README.md
```

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
