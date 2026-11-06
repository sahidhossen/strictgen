# Fix example

A schema written for a looser tool, with open objects, `definitions` and a union without a required tag. `strictgen generate` rejects it, and `strictgen fix` rewrites it into the supported subset. [docs/schemas.md](../../docs/schemas.md#moving-an-existing-schema-in) shows both outputs, which `pnpm docs` makes by running the commands here.

```bash
node dist/cli.js fix --config examples/fix/strictgen.json   # print the rewrite as a diff
```

The schema is kept as it is on purpose, so nothing in this folder is generated.
