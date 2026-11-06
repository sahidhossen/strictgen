import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { Fn, TsModule } from "./drivers.js";
import { binaryDriver, runTs } from "./drivers.js";
import type { Request } from "./protocol.js";
import { removeScratch, withScratch } from "./suite.js";

class FakeDecodeError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
    readonly expected?: string,
    readonly found?: string,
  ) {
    super(`${path}: ${code}`);
  }
}

/** A stand-in for the generated module, with decoders and an encoder for `Order`. */
function fake(functions: Record<string, Fn>): TsModule {
  return {
    fn: (name) => functions[name] ?? ((): never => { throw new Error(`no ${name}`); }),
    DecodeError: FakeDecodeError,
  };
}

const request = (text: string, mode: Request["mode"] = "strict"): Request => ({
  id: 7,
  type: "Order",
  mode,
  decoder: "normal",
  entry: "public",
  hex: Buffer.from(text).toString("hex"),
});

describe("the TypeScript driver", () => {
  const module = fake({
    decodeOrderFromJson: (text) => {
      if (text === "bad") throw new FakeDecodeError("/id", "missing_key");
      if (text === "short") throw new FakeDecodeError("/id", "too_short", "at least 2", "1");
      if (text === "boom") throw new RangeError("Maximum call stack size exceeded");
      return { text };
    },
    reportOrderFromJson: (text) => ({ value: { text }, unknown: ["/x"] }),
    encodeOrderToJson: (value) => {
      if ((value as { text: string }).text === "unencodable") throw new Error("no way");
      return JSON.stringify(value);
    },
  });
  const modules = { strict: module, report: module };

  it("returns the value encoded again, with no unknown paths in strict mode", () => {
    expect(runTs(modules, request("ok"))).toEqual({
      id: 7,
      accepted: true,
      error: null,
      unknown: [],
      encoded: '{"text":"ok"}',
      encodeError: null,
    });
  });

  it("returns the unknown paths in report mode", () => {
    expect(runTs(modules, request("ok", "report"))).toMatchObject({ accepted: true, unknown: ["/x"], encoded: '{"text":"ok"}' });
  });

  it("returns a DecodeError's five fields, with absent ones as null", () => {
    expect(runTs(modules, request("bad")).error).toEqual({ path: "/id", code: "missing_key", expected: null, found: null, message: "/id: missing_key" });
    expect(runTs(modules, request("short")).error).toMatchObject({ expected: "at least 2", found: "1" });
  });

  it("reports any other throw as a crash, not a decode error", () => {
    expect(runTs(modules, request("boom")).error).toEqual({
      path: "",
      code: "crash",
      expected: null,
      found: null,
      message: "RangeError: Maximum call stack size exceeded",
    });
  });

  it("reports an encoder that throws", () => {
    expect(runTs(modules, request("unencodable"))).toMatchObject({ accepted: true, encoded: null, encodeError: "no way" });
  });

  it("rejects bytes that aren't UTF-8 at the root, since the decoders take text", () => {
    expect(runTs(modules, { ...request(""), hex: "ff" }).error).toMatchObject({ path: "", code: "invalid_json" });
    // A byte order mark is kept, for the decoder to reject.
    expect(runTs(modules, { ...request(""), hex: "efbbbf7b7d" })).toMatchObject({ accepted: true, encoded: `{"text":"${String.fromCharCode(0xfeff)}{}"}` });
  });

  it("refuses a decoder it doesn't have yet", () => {
    expect(() => runTs(modules, { ...request("ok"), decoder: "llm" })).toThrow("decoder llm is not supported");
  });
});

describe("a binary driver", () => {
  const scratch = mkdtempSync(join(tmpdir(), "strictgen-driver-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** A shell script standing in for a driver binary. */
  function script(name: string, body: string): string {
    const path = join(scratch, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  const result = (id: number): string =>
    JSON.stringify({ id, accepted: true, error: null, unknown: [], encoded: "{}", encodeError: null });
  const two = [0, 1].map((id) => ({ ...request("{}"), id }));

  it("sends the requests on stdin and reads one result per line", () => {
    // Counts the request lines it reads, then answers each.
    const answer = script("answer", `n=$(wc -l | tr -d ' '); [ "$n" = 2 ] || exit 3; echo '${result(0)}'; echo '${result(1)}'`);
    expect(binaryDriver("go", answer, scratch).run(two).map((r) => r.id)).toEqual([0, 1]);
  });

  it.each([
    ["exits non-zero", "echo 'bad request' >&2; exit 2", "the go driver failed (exit 2): bad request"],
    ["writes fewer results", `cat > /dev/null; echo '${result(0)}'`, "the go driver wrote 1 results for 2 requests"],
    ["writes nothing", "cat > /dev/null", "the go driver wrote 0 results for 2 requests"],
    ["writes garbage", "cat > /dev/null; echo junk; echo junk", "the go driver wrote a bad result for request 0: not JSON"],
    ["answers out of order", `cat > /dev/null; echo '${result(1)}'; echo '${result(0)}'`, "for request 0: it has id 1"],
  ])("fails cleanly when it %s", (what, body, why) => {
    expect(() => binaryDriver("go", script(what.replace(/ /g, "-"), body), scratch).run(two)).toThrow(why);
  });

  it("stops one that hangs", () => {
    const hang = script("hang", "exec sleep 30");
    expect(() => binaryDriver("rust", hang, scratch, 300).run(two)).toThrow(
      "the rust driver took longer than 0.3s and was stopped",
    );
  });

  it("fails cleanly when the binary is missing", () => {
    expect(() => binaryDriver("rust", join(scratch, "missing"), scratch).run(two)).toThrow("the rust driver could not run");
  });
});

describe("removing the scratch folder", () => {
  it("removes only a folder the run made in the temp folder", () => {
    const other = mkdtempSync(join(tmpdir(), "strictgen-other-"));
    try {
      expect(() => removeScratch(other)).toThrow("not a conformance scratch folder");
      expect(existsSync(other)).toBe(true);
      const nested = mkdtempSync(join(other, "strictgen-conformance-"));
      expect(() => removeScratch(nested)).toThrow("not a conformance scratch folder");
      expect(existsSync(nested)).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const own = mkdtempSync(join(tmpdir(), "strictgen-conformance-"));
    removeScratch(own);
    expect(existsSync(own)).toBe(false);
  });
});

describe("the scratch folder of a run", () => {
  it("is removed when the run returns or throws", async () => {
    let seen = "";
    expect(
      await withScratch(false, async (dir) => {
        seen = dir;
        return Promise.resolve(1);
      }),
    ).toBe(1);
    expect(existsSync(seen)).toBe(false);
    await expect(
      withScratch(false, async (dir) => {
        seen = dir;
        return Promise.reject(new Error("build failed"));
      }),
    ).rejects.toThrow("build failed");
    expect(existsSync(seen)).toBe(false);
  });

  it("is kept when asked", async () => {
    const dir = await withScratch(true, async (d) => Promise.resolve(d));
    expect(existsSync(dir)).toBe(true);
    removeScratch(dir);
  });

  it("never hides the error that stopped the run behind one removing the folder", async () => {
    // The body removes the folder itself, so removing it again fails.
    await expect(
      withScratch(false, async (dir) => {
        rmSync(dir, { recursive: true });
        return Promise.reject(new Error("the real failure"));
      }),
    ).rejects.toThrow("the real failure");
    await expect(
      withScratch(false, async (dir) => {
        rmSync(dir, { recursive: true });
        return Promise.resolve();
      }),
    ).rejects.toThrow("ENOENT");
  });

  it("is removed on SIGINT and SIGTERM, which then exit as the signal would", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = process.listenerCount("SIGINT");
    try {
      for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ] as const) {
        let seen = "";
        await expect(
          withScratch(false, async (dir) => {
            seen = dir;
            process.emit(signal);
            return Promise.reject(new Error("stopped"));
          }),
        ).rejects.toThrow("stopped");
        expect(existsSync(seen)).toBe(false);
        expect(exit).toHaveBeenLastCalledWith(code);
      }
      // The handlers are gone once the run is over.
      expect(process.listenerCount("SIGINT")).toBe(before);
    } finally {
      exit.mockRestore();
    }
  });
});
