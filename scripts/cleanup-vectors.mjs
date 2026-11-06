#!/usr/bin/env node
// Writes examples/llm/cleanup-vectors.json: the input and expected output of the LLM cleanup
// step, which the Rust, Go and TypeScript tests all run. Every expected output is written out
// here by hand, from the algorithm in docs/llm.md, never computed by one of the implementations.
// Characters that are hard to see are built with String.fromCodePoint, and the file holds them
// as \u escapes only. Run with --check to fail when the committed file is out of date.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../examples/llm/cleanup-vectors.json", import.meta.url);

const BOM = String.fromCodePoint(0xfeff);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const NBSP = String.fromCodePoint(0xa0);
const VT = String.fromCodePoint(0x0b);
const NUL = String.fromCodePoint(0);
const EMOJI = String.fromCodePoint(0x1f600);
const FENCE = "```";

/** [name, input, expected output]. */
const VECTORS = [
  ["a plain object stays as it is", '{"a":1}', '{"a":1}'],
  ["white space at both ends goes", ' \n\t{"a":1}\r\n ', '{"a":1}'],
  ["white space inside stays", '{ "a" : [ 1 , 2 ] }', '{ "a" : [ 1 , 2 ] }'],
  ["only white space becomes empty", "  \n\t\r ", ""],
  ["empty stays empty", "", ""],
  ["a byte order mark at the start goes", `${BOM}{"a":1}`, '{"a":1}'],
  ["only the first byte order mark goes", `${BOM}${BOM}{}`, `${BOM}{}`],
  ["a byte order mark after white space stays", ` ${BOM}{}`, `${BOM}{}`],
  ["a byte order mark inside a string stays", `{"a":"${BOM}"}`, `{"a":"${BOM}"}`],
  ["a fence without an info string goes", `${FENCE}\n[1,2]\n${FENCE}`, "[1,2]"],
  ["a json fence goes", `${FENCE}json\n{"a":1}\n${FENCE}`, '{"a":1}'],
  ["an upper case info string is allowed", `${FENCE}JSON\n{}\n${FENCE}`, "{}"],
  ["an info string of letters, digits and _+.- is allowed", `${FENCE}json5_x+y.z-1\n{}\n${FENCE}`, "{}"],
  ["an info string with a slash keeps the fence", `${FENCE}application/json\n{}\n${FENCE}`, `${FENCE}application/json\n{}\n${FENCE}`],
  ["an info string with a space inside keeps the fence", `${FENCE}json x\n{}\n${FENCE}`, `${FENCE}json x\n{}\n${FENCE}`],
  ["a space before the info string keeps the fence", `${FENCE} json\n{}\n${FENCE}`, `${FENCE} json\n{}\n${FENCE}`],
  ["spaces and tabs after the info string are allowed", `${FENCE}json \t\n{}\n${FENCE}`, "{}"],
  ["a fence with CRLF line ends goes", `${FENCE}json\r\n{"a":1}\r\n${FENCE}`, '{"a":1}'],
  ["an indented closing fence goes", `${FENCE}json\n{}\n \t${FENCE}`, "{}"],
  ["white space inside the fence goes too", `${FENCE}json\n\n  {"a": 1}  \n\n${FENCE}`, '{"a": 1}'],
  ["white space around the fence goes", `\n  ${FENCE}json\n{}\n${FENCE}\n\n`, "{}"],
  ["a byte order mark before the fence goes", `${BOM}\n${FENCE}json\n{"a":1}\n${FENCE}\n`, '{"a":1}'],
  ["a byte order mark inside the fence stays", `${FENCE}json\n${BOM}{}\n${FENCE}`, `${BOM}{}`],
  ["an empty fence becomes empty", `${FENCE}json\n${FENCE}`, ""],
  ["a fence holding only white space becomes empty", `${FENCE}json\n  \n${FENCE}`, ""],
  ["no closing fence keeps the text", `${FENCE}json\n{}`, `${FENCE}json\n{}`],
  ["no opening fence keeps the text", `{}\n${FENCE}`, `{}\n${FENCE}`],
  ["a closing fence on the last line of content keeps the text", `${FENCE}json\n{}${FENCE}`, `${FENCE}json\n{}${FENCE}`],
  ["a fence on one line stays", `${FENCE}{"a":1}${FENCE}`, `${FENCE}{"a":1}${FENCE}`],
  ["only three backticks stay", FENCE, FENCE],
  ["four backticks keep the fence", `${FENCE}\`json\n{}\n${FENCE}\``, `${FENCE}\`json\n{}\n${FENCE}\``],
  ["text before the fence keeps it", `Here it is:\n${FENCE}json\n{}\n${FENCE}`, `Here it is:\n${FENCE}json\n{}\n${FENCE}`],
  ["text after the fence keeps it", `${FENCE}json\n{}\n${FENCE}\nThanks`, `${FENCE}json\n{}\n${FENCE}\nThanks`],
  ["a fence inside a fence keeps the inner one", `${FENCE}\n${FENCE}json\n{}\n${FENCE}\n${FENCE}`, `${FENCE}json\n{}\n${FENCE}`],
  ["a trailing comma in an object goes", '{"a":1,}', '{"a":1}'],
  ["a trailing comma in an array goes", "[1,2,]", "[1,2]"],
  ["white space after a trailing comma stays", "[1,2 ,\n ]", "[1,2 \n ]"],
  ["a trailing comma before CRLF goes", "[1,\r\n]", "[1\r\n]"],
  ["nested trailing commas all go", '{"a":[1,],"b":{"c":2,},}', '{"a":[1],"b":{"c":2}}'],
  ["a trailing comma inside a fence goes", `${FENCE}json\n{"a":[1,2,],}\n${FENCE}`, '{"a":[1,2]}'],
  ["a comma between values stays", '{"a":1,"b":[1,2]}', '{"a":1,"b":[1,2]}'],
  ["a comma and brace inside a string stay", '{"a":"x,}"}', '{"a":"x,}"}'],
  ["a comma and bracket inside a string stay", '["a,]",]', '["a,]"]'],
  ["an escaped quote doesn't end a string", '{"a":"say \\"hi,\\" ]",}', '{"a":"say \\"hi,\\" ]"}'],
  ["an escaped backslash ends before the quote", '["c:\\\\",]', '["c:\\\\"]'],
  ["of two commas only the last goes", "[1,,]", "[1,]"],
  ["a leading comma stays", "[,1]", "[,1]"],
  ["a comma at the end of the text stays", "[1],", "[1],"],
  ["a comma before a comment stays", '{"a":1, // note\n}', '{"a":1, // note\n}'],
  ["single quotes don't start a string", "{'a':1,}", "{'a':1}"],
  ["an unterminated string keeps the rest", '{"a":"x,}', '{"a":"x,}'],
  [
    "other characters stay as they are",
    `{"emoji":"${EMOJI}","separator":"${LINE_SEPARATOR}","nul":"${NUL}",}`,
    `{"emoji":"${EMOJI}","separator":"${LINE_SEPARATOR}","nul":"${NUL}"}`,
  ],
  ["a no-break space is not JSON white space", `${NBSP}{}${NBSP}`, `${NBSP}{}${NBSP}`],
  ["a vertical tab is not JSON white space", `${VT}[1,${VT}]`, `${VT}[1,${VT}]`],
  ["a no-break space before a bracket keeps the comma", `[1,${NBSP}]`, `[1,${NBSP}]`],
  ["an odd backslash run before a quote escapes it", '["a\\\\\\",]",]', '["a\\\\\\",]"]'],
  ["an even backslash run before a quote ends the string", '["a\\\\\\\\",]', '["a\\\\\\\\"]'],
  ["a string ending in a backslash without a closing quote stays", '["x\\', '["x\\'],
  ["a backslash before a comma in an unterminated string keeps it", '["x\\,]', '["x\\,]'],
  ["a backslash before an astral character, then a trailing comma", `{"a":"\\${EMOJI}",}`, `{"a":"\\${EMOJI}"}`],
  ["backticks inside a string inside a fence stay", `${FENCE}json\n{"a":"${FENCE}",}\n${FENCE}`, `{"a":"${FENCE}"}`],
  ["a line of backticks inside a string ends the fence", `${FENCE}json\n{"a":"\n${FENCE}"}\n${FENCE}`, `{"a":"\n${FENCE}"}`],
  ["a bare CR before the closing fence keeps the fence", `${FENCE}json\n{}\r${FENCE}`, `${FENCE}json\n{}\r${FENCE}`],
  ["a lone CR as the line break keeps the fence", `${FENCE}json\r{}\r${FENCE}`, `${FENCE}json\r{}\r${FENCE}`],
  ["a tab and spaces after the closing fence go", `${FENCE}json\n{}\n${FENCE}\t  `, "{}"],
  ["an unclosed fence keeps the fence, but not the trailing comma", `${FENCE}json\n[1,]`, `${FENCE}json\n[1]`],
  ["a byte order mark, a fence and a trailing comma all go", `${BOM}${FENCE}json\n{"a":1,}\n${FENCE}`, '{"a":1}'],
  ["astral characters inside a fence stay", `${FENCE}json\n["${EMOJI}","a${EMOJI}b",]\n${FENCE}`, `["${EMOJI}","a${EMOJI}b"]`],
  ["an astral character in the info string keeps the fence", `${FENCE}${EMOJI}\n{}\n${FENCE}`, `${FENCE}${EMOJI}\n{}\n${FENCE}`],
  ["keys and values are never changed", '{"Name":"  x  ","n":01,"t":tru,}', '{"Name":"  x  ","n":01,"t":tru}'],
];

/** JSON with every character past ASCII as a \u escape, two space indent and a final newline. */
function text(value) {
  const json = JSON.stringify(value, null, 2);
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const unit = json.charCodeAt(i);
    out += unit < 0x7f ? json.charAt(i) : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return `${out}\n`;
}

const names = new Set();
for (const [name] of VECTORS) {
  if (names.has(name)) throw new Error(`vector ${name} is listed twice`);
  names.add(name);
}
const contents = text(VECTORS.map(([name, input, output]) => ({ name, input, output })));
if (process.argv.includes("--check")) {
  if (readFileSync(FILE, "utf8") !== contents) {
    console.error("examples/llm/cleanup-vectors.json is out of date. Run node scripts/cleanup-vectors.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(FILE, contents);
}
