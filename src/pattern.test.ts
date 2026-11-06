import { describe, expect, it } from "vitest";

import { MAX_REPEAT, PatternError, portablePattern } from "./pattern.js";

/** The reason portablePattern gives for a pattern outside the subset. */
function reason(pattern: string): string {
  try {
    portablePattern(pattern);
  } catch (error) {
    if (error instanceof PatternError) return error.message;
    throw error;
  }
  throw new Error(`accepted ${pattern}`);
}

describe("pattern portable form", () => {
  it("keeps literals, anchors, repeats and alternatives, with every group non-capturing", () => {
    expect(portablePattern("^[A-Z]{3}$")).toBe("^[A-Z]{3}$");
    expect(portablePattern("^(?:cat|dog)s?$")).toBe("^(?:cat|dog)s?$");
    expect(portablePattern("(a)(b)")).toBe("(?:a)(?:b)");
    expect(portablePattern("a|b|")).toBe("a|b|");
    expect(portablePattern("x{2,}y{0,3}z{4}")).toBe("x{2,}y{0,3}z{4}");
    expect(portablePattern("")).toBe("");
  });

  it("makes lazy repeats greedy, which matches the same strings", () => {
    expect(portablePattern("a*?b+?c??d{1,2}?")).toBe("a*b+c?d{1,2}");
  });

  it("writes \\d and \\w as ASCII classes, as ECMAScript reads them", () => {
    expect(portablePattern("\\d+")).toBe("[0-9]+");
    expect(portablePattern("\\w")).toBe("[0-9A-Z_a-z]");
    expect(portablePattern("\\D")).toBe("[^0-9]");
    expect(portablePattern("\\W")).toBe("[^0-9A-Z_a-z]");
  });

  it("writes \\s as ECMAScript's white space and line terminators", () => {
    expect(portablePattern("\\s")).toBe(
      "[\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]",
    );
    expect(portablePattern("\\S")).toBe(
      "[^\t-\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]",
    );
  });

  it("writes . as any character but the ECMAScript line terminators", () => {
    expect(portablePattern("^a.c$")).toBe("^a[^\n\r\u2028\u2029]c$");
  });

  it("writes classes as sorted ranges, with the characters Rust's classes treat as syntax escaped", () => {
    expect(portablePattern("[c-ea-b]")).toBe("[a-e]");
    expect(portablePattern("[\\w-]")).toBe("[\\-0-9A-Z_a-z]");
    expect(portablePattern("[\\^\\]\\[\\\\]")).toBe("[\\[-\\^]");
    expect(portablePattern("[&&~~]")).toBe("[&~]");
    expect(portablePattern("[\\s\\S]")).toBe("[\u0000-퟿-\u{10ffff}]");
    expect(portablePattern("[^]")).toBe("[\u0000-퟿-\u{10ffff}]");
    expect(portablePattern("[a]")).toBe("a");
  });

  it("reads escapes as the characters they stand for", () => {
    expect(portablePattern("\\u{1F600}\\uD83D\\uDE00\\x41\\u0042\\t\\0\\cJ")).toBe(
      "\u{1f600}\u{1f600}AB\t\u0000\n",
    );
    expect(portablePattern("\\.\\*\\/\\$")).toBe("\\.\\*/\\$");
  });

  it("rejects syntax the engines read differently or not at all, with the reason", () => {
    expect(reason("(?=a)")).toBe("lookarounds are not supported by Rust's regex and Go's RE2 at character 1");
    expect(reason("a(?!b)")).toContain("lookarounds");
    expect(reason("(?<=a)b")).toContain("lookarounds");
    expect(reason("(?<!a)b")).toContain("lookarounds");
    expect(reason("(a)\\1")).toBe("backreferences are not supported by Rust's regex and Go's RE2 at character 4");
    expect(reason("(?<n>a)\\k<n>")).toBe("named groups are not supported at character 1");
    expect(reason("\\bx")).toBe("the word boundary \\b at character 1");
    expect(reason("x\\B")).toBe("the word boundary \\B at character 2");
    expect(reason("\\p{L}")).toBe("Unicode property escapes are not supported at character 1");
    expect(reason(`a{${String(MAX_REPEAT + 1)}}`)).toContain("a repeat count above 1000");
    expect(reason("(?:a{10}){101}")).toContain("nested repeats that multiply to more than 1000");
    expect(reason("[]")).toBe("a class that matches nothing");
    expect(reason("\\ud800")).toBe("a lone surrogate, which no string holds at character 1");
    expect(reason("\ud800")).toBe("the pattern holds a lone surrogate");
  });

  it("rejects what isn't ECMAScript with the u flag", () => {
    for (const bad of ["a**", "(", "[b-a]", "\\-", "a{2,1}", "\\c", "]", "{", "\\q"]) {
      expect(reason(bad)).toMatch(/^not a valid ECMAScript pattern with the u flag/);
    }
  });

  it("accepts nested repeats up to 1000", () => {
    expect(portablePattern("(?:a{10}){100}")).toBe("(?:a{10}){100}");
  });
});
