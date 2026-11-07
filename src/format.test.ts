import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { FormatConfig } from "./config.js";
import { formatterArgs, formatterFor } from "./format.js";

const FORMAT: FormatConfig = { rust: "rustfmt", go: "gofmt", typescript: "none" };

describe("formatter arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "strictgen-format-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("gives rustfmt an empty rustfmt.toml in the scratch folder, never the null device", () => {
    const rustfmt = formatterFor("x.rs", FORMAT);
    if (rustfmt === undefined) throw new Error("no rustfmt");
    let made = 0;
    const scratch = (): string => {
      made += 1;
      return dir;
    };
    const args = formatterArgs(rustfmt, scratch);
    const config = join(dir, "rustfmt.toml");
    expect(args).toEqual(["--edition", "2024", "--config-path", config]);
    expect(args).not.toContain(devNull);
    expect(args.some((a) => a.toLowerCase().includes("nul") || a === "/dev/null")).toBe(false);
    expect(statSync(config).isFile()).toBe(true);
    expect(readFileSync(config, "utf8")).toBe("");
    // The second run reuses the file.
    expect(formatterArgs(rustfmt, scratch)).toEqual(args);
    expect(made).toBe(2);
  });

  it("gives gofmt no arguments and no config", () => {
    const gofmt = formatterFor("x.go", FORMAT);
    if (gofmt === undefined) throw new Error("no gofmt");
    expect(formatterArgs(gofmt, () => {
      throw new Error("gofmt needs no scratch folder");
    })).toEqual([]);
  });
});
