import { describe, expect, it } from "vitest";

import type { State } from "./state.js";
import { checkState, decodeState, encodeState, FRAGMENT_PREFIX, MAX_FRAGMENT, MAX_STATE_BYTES, StateError } from "./state.js";

const STATE: State = {
  schemas: [
    { name: "order.json", text: '{"title": "Order"}\n' },
    { name: "common.json", text: "{}" },
  ],
  read: "report",
  profiles: ["anthropic", "openai"],
  cleanup: true,
  serdeBridge: true,
  ids: { file: "common", suffix: "Id" },
  type: "Order",
  decoder: "llm",
  payload: `{"note": "caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0x2028)} ${String.fromCodePoint(0xfeff)}"}`,
};

/** A fragment of any bytes, compressed as encodeState compresses. */
async function fragmentOf(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const b of out) binary += String.fromCharCode(b);
  return FRAGMENT_PREFIX + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function failure(fragment: string): Promise<string> {
  try {
    await decodeState(fragment);
  } catch (error) {
    expect(error).toBeInstanceOf(StateError);
    return (error as Error).message;
  }
  throw new Error("no error");
}

describe("the URL fragment", () => {
  it("round-trips a state, odd characters included", async () => {
    const fragment = await encodeState(STATE);
    expect(fragment.startsWith(FRAGMENT_PREFIX)).toBe(true);
    expect(fragment).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(await decodeState(fragment)).toEqual(STATE);
    expect(await encodeState(await decodeState(fragment))).toBe(fragment);
  });

  it("round-trips a large state, in fewer characters than its JSON", async () => {
    const text = JSON.stringify({ title: "Order", properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`f${String(i)}`, { type: "string" }])) });
    const state = { ...STATE, schemas: [{ name: "order.json", text }] };
    const fragment = await encodeState(state);
    expect(fragment.length).toBeLessThan(text.length / 4);
    expect(await decodeState(fragment)).toEqual(state);
  });

  it("refuses to encode a state it couldn't read back", async () => {
    await expect(encodeState({ ...STATE, read: "loose" as State["read"] })).rejects.toThrow(StateError);
  });

  it("fails cleanly on a broken fragment", async () => {
    expect(await failure("")).toBe("the link's state is not in a format this page reads");
    expect(await failure("v2.abc")).toBe("the link's state is not in a format this page reads");
    expect(await failure("v1.a+b")).toBe("the link's state is not base64url");
    expect(await failure("v1.a")).toBe("the link's state is not base64url");
    expect(await failure("v1.AAAA")).toBe("the link's state is not compressed data");
    expect(await failure(`v1.${"A".repeat(MAX_FRAGMENT)}`)).toBe(`the link is longer than ${String(MAX_FRAGMENT)} characters`);
    expect(await failure(await fragmentOf(new Uint8Array([0xff, 0xfe])))).toBe("the link's state is not UTF-8 text");
    expect(await failure(await fragmentOf(new TextEncoder().encode("{")))).toBe("the link's state is not JSON");
    expect(await failure(await fragmentOf(new TextEncoder().encode("[]")))).toBe("the link's state is broken: not an object");
  });

  it("stops decompressing past the size limit", async () => {
    // A few hundred bytes that would inflate to more than the limit.
    const bomb = await fragmentOf(new Uint8Array(MAX_STATE_BYTES + 1));
    expect(bomb.length).toBeLessThan(MAX_FRAGMENT);
    expect(await failure(bomb)).toBe(`the link's state is larger than ${String(MAX_STATE_BYTES)} bytes`);
  });
});

describe("checkState", () => {
  const broken = (patch: Record<string, unknown>): string => {
    try {
      checkState({ ...STATE, ...patch });
    } catch (error) {
      return (error as Error).message.replace("the link's state is broken: ", "");
    }
    return "accepted";
  };

  it("accepts a valid state and no ID rule", () => {
    expect(broken({})).toBe("accepted");
    expect(broken({ ids: null, profiles: [], type: "" })).toBe("accepted");
  });

  it("checks every field", () => {
    expect(broken({ extra: 1 })).toBe('unknown field "extra"');
    expect(broken({ schemas: [] })).toBe("schemas must list 1 to 64 files");
    expect(broken({ schemas: [{ name: "a.json" }] })).toBe('schemas[0] must be {"name", "text"}');
    expect(broken({ schemas: [{ name: "../a.json", text: "" }] })).toBe("schemas[0] has a bad file name");
    expect(broken({ schemas: [{ name: "Order.json", text: "" }] })).toBe("schemas[0] has a bad file name");
    expect(broken({ schemas: [{ name: "a.json", text: "" }, { name: "a.json", text: "" }] })).toBe("two schema files have the same name");
    expect(broken({ read: "loose" })).toBe('read must be "strict" or "report"');
    expect(broken({ profiles: "openai" })).toBe("profiles must be a list of names");
    expect(broken({ profiles: ["openai", "anthropic"] })).toBe("profiles must be some of anthropic, gemini, openai, in that order, each once");
    expect(broken({ profiles: ["openai", "openai"] })).toBe("profiles must be some of anthropic, gemini, openai, in that order, each once");
    expect(broken({ profiles: ["other"] })).toBe("profiles must be some of anthropic, gemini, openai, in that order, each once");
    expect(broken({ cleanup: "yes" })).toBe("cleanup must be true or false");
    expect(broken({ serdeBridge: 1 })).toBe("serdeBridge must be true or false");
    expect(broken({ ids: { file: "common" } })).toBe('ids must be null or {"file", "suffix"}');
    expect(broken({ ids: { file: "", suffix: "Id" } })).toBe("ids has an empty or long field");
    expect(broken({ type: "<b>" })).toBe("type must be a type name");
    expect(broken({ decoder: "other" })).toBe('decoder must be "normal" or "llm"');
    expect(broken({ payload: 1 })).toBe("payload must be a string");
  });
});
