import { describe, expect, it } from "vitest";

import {
  CanonicalError,
  canonicalize,
  canonicalNumber,
  canonicalString,
  compareUtf16,
  parseJson,
  serialize,
  respell,
  withoutMembers,
} from "./canonical.js";

/** A JSON \u escape, built so no escape is typed into this file. */
const esc = (hex: string): string => `${String.fromCharCode(92)}u${hex}`;
const ch = (...points: number[]): string => String.fromCodePoint(...points);

/** The double whose IEEE 754 bits are `hex`. */
function double(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("RFC 8785 number serialisation", () => {
  // The examples of RFC 8785 Appendix B: IEEE 754 bits and the text each must become.
  const vectors: [string, string][] = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];

  it.each(vectors)("writes %s as %s", (bits, text) => {
    expect(canonicalNumber(double(bits))).toBe(text);
  });

  it("refuses NaN and the infinities, which have no JSON form", () => {
    for (const bits of ["7fffffffffffffff", "7ff0000000000000", "fff0000000000000"]) {
      expect(() => canonicalNumber(double(bits))).toThrow(CanonicalError);
    }
  });

  it("rewrites every spelling of a number to the one form", () => {
    expect(canonicalize("[1.0,1e2,1E+2,100.00,-0,-0.0,0e10,4.50,2e-3,1e-7,1e21,123456789012345680000]")).toBe(
      "[1,100,100,100,0,0,0,4.5,0.002,1e-7,1e+21,123456789012345680000]",
    );
  });

  it("refuses a number a double can't hold", () => {
    expect(() => canonicalize("1e400")).toThrow("out of range");
    expect(() => canonicalize("-1e400")).toThrow("out of range");
  });

  it("rounds an integer past 2^53 to a double, unless asked to keep its digits", () => {
    const text = "[9007199254740993,-9223372036854775808,9223372036854775807,9007199254740992]";
    expect(canonicalize(text)).toBe("[9007199254740992,-9223372036854776000,9223372036854776000,9007199254740992]");
    expect(canonicalize(text, { exactIntegers: true })).toBe(
      "[9007199254740993,-9223372036854775808,9223372036854775807,9007199254740992]",
    );
    // Only integers spelled as integers keep their digits: 1.5e300 and 9.007199254740993e15 are doubles.
    expect(canonicalize("[1.5e300,9.007199254740993e15]", { exactIntegers: true })).toBe("[1.5e+300,9007199254740992]");
  });

  it("gives the same digits for a large double whichever way a language spells it", () => {
    // Go writes this double as digits, Rust in exponent form.
    expect(canonicalize("123456789012345680000", { exactIntegers: true })).toBe(
      canonicalize("1.2345678901234568e20", { exactIntegers: true }),
    );
  });
});

describe("RFC 8785 string serialisation", () => {
  it("escapes only the quote, the backslash and control characters, the short form where JSON has one", () => {
    const text = `"${["0000", "0008", "0009", "000a", "000c", "000d", "000f", "001f"].map(esc).join("")}"`;
    expect(canonicalize(text)).toBe(`"${esc("0000")}\\b\\t\\n\\f\\r${esc("000f")}${esc("001f")}"`);
    expect(canonicalString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("writes everything else as itself: the solidus, DEL, non-ASCII, U+2028, U+2029 and astral characters", () => {
    const text = `"${esc("002f")}\\/${["007f", "00e9", "2028", "2029", "feff", "d83d", "de00"].map(esc).join("")}"`;
    expect(canonicalize(text)).toBe(`"//${ch(0x7f, 0xe9, 0x2028, 0x2029, 0xfeff, 0x1f600)}"`);
    // Raw and escaped spellings of the same text agree.
    expect(canonicalize(`"${ch(0x2028)}"`)).toBe(canonicalize(`"${esc("2028")}"`));
  });

  it("keeps runs of backslashes and JSON delimiters inside strings and keys as text", () => {
    const text = '{"a\\\\\\\\\\"b":"\\\\\\\\","{,:}":"[1,2]","\\"":"\\\\\\""}';
    expect(canonicalize(text)).toBe('{"\\"":"\\\\\\"","a\\\\\\\\\\"b":"\\\\\\\\","{,:}":"[1,2]"}');
    // A multi-line value keeps its line feeds as escapes, on one line.
    expect(canonicalize('"a\\nb\\r\\nc"')).toBe('"a\\nb\\r\\nc"');
  });

  it("refuses a lone surrogate, raw or escaped", () => {
    for (const text of [`"${esc("d83d")}"`, `"${esc("de00")}"`, `"${esc("d83d")}x"`, `"${ch(0xd83d)}"`, `"${ch(0xde00)}"`]) {
      expect(() => canonicalize(text), text).toThrow("lone surrogate");
    }
    expect(() => canonicalString(ch(0xd800))).toThrow("lone surrogate");
  });

  it("follows the example of RFC 8785 section 3.2.2", () => {
    const input =
      `{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],` +
      `"string":"${esc("20ac")}$${esc("000F")}${esc("000a")}A'${esc("0042")}${esc("0022")}${esc("005c")}\\\\\\"\\/",` +
      `"literals":[null,true,false]}`;
    expect(canonicalize(input)).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],` +
        `"string":"${ch(0x20ac)}$${esc("000f")}\\nA'B\\"\\\\\\\\\\"/"}`,
    );
  });
});

describe("RFC 8785 key sorting", () => {
  it("sorts keys by UTF-16 code units, as the example of section 3.2.3 does", () => {
    // U+1F600 is the surrogate pair D83D DE00, so it sorts before U+FB33 although its code point is larger.
    const keys = [ch(0x20ac), "\r", ch(0xfb33), "1", ch(0x1f600), ch(0x80), ch(0xf6)];
    const object = new Map(keys.map((k, i) => [k, String(i)] as const));
    const sorted = [...serialize(object).matchAll(/"([^"]*)":/g)].map((m) => m[1]);
    expect(sorted).toEqual(["\\r", "1", ch(0x80), ch(0xf6), ch(0x20ac), ch(0x1f600), ch(0xfb33)]);
    expect(compareUtf16(ch(0x1f600), ch(0xfb33))).toBe(-1);
  });

  it("sorts nested objects and keeps array order", () => {
    expect(canonicalize('{"b":[{"z":1,"a":2},3],"a":{"y":null,"x":true}}')).toBe(
      '{"a":{"x":true,"y":null},"b":[{"a":2,"z":1},3]}',
    );
  });

  it("drops whitespace", () => {
    expect(canonicalize(' \t\n\r{ "a" : [ 1 , 2 ] }\n')).toBe('{"a":[1,2]}');
  });
});

describe("strict JSON reading", () => {
  it.each([
    ['{"a":1,"a":2}', "duplicate key"],
    ['{"a":1,"\\u0061":2}', "duplicate key"],
    ["[1,]", "invalid value"],
    ["01", "data after the value"],
    ["{'a':1}", "missing key"],
    ['"a\tb"', "control character"],
    ['"\\x"', "invalid escape"],
    ['"\\u12"', "invalid \\u escape"],
    ["[1", "missing comma or closing bracket"],
    ["", "invalid value"],
    ["NaN", "invalid value"],
    ["-", "invalid value"],
    ["1 2", "data after the value"],
    [`${ch(0xfeff)}{}`, "invalid value"],
  ])("refuses %j (%s)", (text, why) => {
    expect(() => parseJson(text)).toThrow(why);
  });

  it("refuses input nested past its depth limit instead of overflowing the stack", () => {
    expect(() => parseJson("[".repeat(100_000))).toThrow("nested too deep");
  });
});

describe("removing members", () => {
  it("removes the members the pointers name and leaves the input alone", () => {
    const value = parseJson('{"a":{"x":1,"y/z":2,"~":3},"b":[{"c":1,"d":2}]}');
    expect(serialize(withoutMembers(value, ["/a/y~1z", "/a/~0", "/b/0/d"]))).toBe('{"a":{"x":1},"b":[{"c":1}]}');
    expect(serialize(value)).toBe('{"a":{"x":1,"y/z":2,"~":3},"b":[{"c":1,"d":2}]}');
  });

  it("fails on a pointer that names nothing", () => {
    const value = parseJson('{"a":[1]}');
    for (const pointer of ["/b", "/a/0", "/a/x/y", "", "a"]) {
      expect(() => withoutMembers(value, [pointer]), pointer).toThrow(CanonicalError);
    }
  });
});

describe("respelling only what a mark allows", () => {
  const ls = esc("2028");
  it("leaves the text as written when nothing is allowed", () => {
    const text = `{"b":1.50E+2,"a":"x${ls}y"}`;
    expect(respell(text, {})).toBe(text);
  });

  it("writes numbers canonically, keeping 64-bit integers exact", () => {
    expect(respell('[1.50E+2,1e-07,5.0,9223372036854775807,"1e2"]', { numbers: true })).toBe(
      '[150,1e-7,5,9223372036854775807,"1e2"]',
    );
  });

  it("keeps every string and key as written, escapes included", () => {
    const text = `{"b":"${esc("d83d")}${esc("de00")}\\n${esc("000a")}","${ls}":"a${ls}${esc("0041")}"}`;
    expect(respell(text, { numbers: true, keyOrder: true })).toBe(text);
  });

  it("sorts keys by UTF-16 code units when key order is allowed", () => {
    expect(respell('{"b":{"d":1,"c":2},"a":[{"z":1,"y":2}]}', { keyOrder: true })).toBe('{"a":[{"y":2,"z":1}],"b":{"c":2,"d":1}}');
  });

  it("gives up on text that isn't compact JSON, so whitespace is never hidden", () => {
    for (const text of ['{"a": 1}', "[1,]", '"a', "01", "", '{"a":1}x']) {
      expect(respell(text, { numbers: true, keyOrder: true }), text).toBeUndefined();
    }
  });
});
