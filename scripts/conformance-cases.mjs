#!/usr/bin/env node
// Writes the conformance cases whose text is easier to build than to type: nesting at and past
// the depth limit, consts, recursive parts, values of any JSON type, maps keyed by an enum and the
// edges of the LLM projection (conformance/schemas/bundle.json and refund.json, and a few cases of
// other types). Every expectation is written out here by hand, from docs/error-codes.md, never
// recorded from a decoder. Characters past ASCII are built with String.fromCodePoint and the
// files hold them as \u escapes only, so none is hard to see. Run with --check to fail when a
// committed case is out of date.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ROOT = new URL("../conformance/cases/", import.meta.url);

const EMOJI = String.fromCodePoint(0x1f600);
const E_ACUTE = String.fromCodePoint(0xe9);
const CHECK = String.fromCodePoint(0x2713);

/**
 * The nesting the readers refuse: this many arrays and objects inside each other, the root
 * included, fail with too_deep at the innermost one ("at most 127 nested arrays and objects").
 */
const MAX_DEPTH = 128;

/** JSON text in ASCII only, every other UTF-16 unit as a \u escape. */
function ascii(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out += unit < 0x7f ? text.charAt(i) : `\\u${unit.toString(16).padStart(4, "0")}`;
  }
  return out;
}

/** A value as the case files write it: two space indent, a final newline. */
const pretty = (value) => `${ascii(JSON.stringify(value, null, 2))}\n`;

/** `inner` inside `n` arrays, as text. */
const arrays = (n, inner) => `${"[".repeat(n)}${inner}${"]".repeat(n)}`;
/** `inner` inside `n` objects, each with the one key `a`, as text. */
const objects = (n, inner) => `${'{"a":'.repeat(n)}${inner}${"}".repeat(n)}`;
/** The pointer of the value inside `n` arrays. */
const arrayPath = (n) => "/0".repeat(n);

const bundle = { sku: "B-1", version: 2 };
const refund = { order: "ord_5h1c", reason: "late", amounts: { EUR: 500 }, to: { last4: "4242" } };

// The most arrays `meta` may hold inside each other: with the root object and `meta`'s own array,
// 127 arrays and objects are nested.
const META_AT_LIMIT = MAX_DEPTH - 2;

/** [path under cases/, text, expectation or undefined for a valid case]. */
const CASES = [
  // Bundle: consts, a recursive part, any JSON values and nesting at the depth limit.
  ["Bundle/valid/minimal.json", pretty(bundle)],
  [
    "Bundle/valid/every-field.json",
    pretty({
      ...bundle,
      sealed: true,
      parts: [{ sku: "P-1", inner: { sku: "P-2", inner: { sku: "P-3" } } }, { sku: "P-4" }],
      label: { text: `Fragile ${E_ACUTE}${EMOJI}` },
      meta: null,
    }),
  ],
  ["Bundle/valid/empty-parts-and-meta.json", pretty({ ...bundle, parts: [], label: [], meta: {} })],
  ["Bundle/valid/label-false.json", pretty({ ...bundle, label: false })],
  ["Bundle/valid/label-zero.json", pretty({ ...bundle, label: 0 })],
  // 127 arrays and objects nested, the root object included, is the deepest that reads, so a
  // scalar may sit inside the innermost one, and an empty array may be the innermost one.
  ["Bundle/valid/meta-arrays-at-depth-limit.json", `{"sku":"B-1","version":2,"meta":${arrays(META_AT_LIMIT, "0")}}\n`],
  ["Bundle/valid/meta-objects-at-depth-limit.json", `{"sku":"B-1","version":2,"meta":${objects(META_AT_LIMIT, "0")}}\n`],
  ["Bundle/valid/meta-empty-array-at-depth-limit.json", `{"sku":"B-1","version":2,"meta":${arrays(META_AT_LIMIT - 1, "[]")}}\n`],
  ["Bundle/invalid/version-other.json", pretty({ ...bundle, version: 3 }), { path: "/version", code: "not_const" }],
  ["Bundle/invalid/version-as-string.json", pretty({ ...bundle, version: "2" }), { path: "/version", code: "wrong_type" }],
  ["Bundle/invalid/sealed-false.json", pretty({ ...bundle, sealed: false }), { path: "/sealed", code: "not_const" }],
  ["Bundle/invalid/sealed-null.json", pretty({ ...bundle, sealed: null }), { path: "/sealed", code: "null_not_allowed" }],
  ["Bundle/invalid/label-null.json", pretty({ ...bundle, label: null }), { path: "/label", code: "null_not_allowed" }],
  [
    "Bundle/invalid/inner-part-without-sku.json",
    pretty({ ...bundle, parts: [{ sku: "P-1", inner: { sku: "P-2", inner: {} } }] }),
    { path: "/parts/0/inner/inner/sku", code: "missing_key" },
  ],
  [
    "Bundle/invalid/inner-part-a-string.json",
    pretty({ ...bundle, parts: [{ sku: "P-1", inner: "P-2" }] }),
    { path: "/parts/0/inner", code: "wrong_type" },
  ],
  // One more: the 128th array or object fails, at its own path.
  [
    "Bundle/invalid/meta-arrays-past-depth-limit.json",
    `{"sku":"B-1","version":2,"meta":${arrays(META_AT_LIMIT + 1, "0")}}\n`,
    { path: `/meta${arrayPath(META_AT_LIMIT)}`, code: "too_deep" },
  ],
  [
    "Bundle/invalid/meta-objects-past-depth-limit.json",
    `{"sku":"B-1","version":2,"meta":${objects(META_AT_LIMIT + 1, "0")}}\n`,
    { path: `/meta${"/a".repeat(META_AT_LIMIT)}`, code: "too_deep" },
  ],
  [
    "Bundle/invalid/meta-empty-array-past-depth-limit.json",
    `{"sku":"B-1","version":2,"meta":${arrays(META_AT_LIMIT, "[]")}}\n`,
    { path: `/meta${arrayPath(META_AT_LIMIT)}`, code: "too_deep" },
  ],
  // The text is read before the type, so nesting past the limit fails as too_deep even where
  // the type takes a string.
  [
    "Bundle/invalid/sku-far-past-depth-limit.json",
    `{"sku":${arrays(200, '"B-1"')},"version":2}\n`,
    { path: `/sku${arrayPath(META_AT_LIMIT)}`, code: "too_deep" },
  ],
  ["Bundle/invalid/meta-key-twice.json", '{"sku":"B-1","version":2,"meta":{"a":1,"a":2}}\n', { path: "/meta/a", code: "duplicate_key" }],
  ["Bundle/invalid/unknown-key.json", pretty({ ...bundle, extra: 1 }), { path: "/extra", code: "unknown_key", report: { unknown: ["/extra"] } }],

  // Refund: every type has a provider-ready schema, so the LLM decoders read all of it, with an
  // enum-keyed map and an untagged union whose branches share an optional key.
  ["Refund/valid/card.json", pretty(refund)],
  [
    "Refund/valid/bank-with-every-field.json",
    pretty({
      order: "ord_5h1c",
      reason: "damaged",
      amounts: { USD: 1, EUR: 250, GBP: 9007199254740991 },
      to: { iban: "DE89370400440532013000", note: `Thanks ${CHECK}` },
      issuedAt: "2026-02-28T23:59:59.5+01:00",
      codes: ["ABC", "XYZ"],
      memo: `Sorry ${E_ACUTE}${EMOJI}`,
      version: 1,
      final: true,
    }),
  ],
  ["Refund/valid/card-with-note-and-no-codes.json", pretty({ ...refund, to: { last4: "0000", note: "x".repeat(20) }, codes: [] })],
  ["Refund/valid/memo-astral-at-maximum.json", pretty({ ...refund, memo: EMOJI.repeat(40) })],
  ["Refund/invalid/amounts-empty.json", pretty({ ...refund, amounts: {} }), { path: "/amounts", code: "too_short" }],
  ["Refund/invalid/amounts-unknown-currency.json", pretty({ ...refund, amounts: { EUR: 1, JPY: 1 } }), { path: "/amounts/JPY", code: "not_in_enum" }],
  ["Refund/invalid/amounts-zero.json", pretty({ ...refund, amounts: { GBP: 5, EUR: 0 } }), { path: "/amounts/EUR", code: "too_small" }],
  ["Refund/invalid/amounts-key-before-value.json", pretty({ ...refund, amounts: { EUR: 0, JPY: 1 } }), { path: "/amounts/JPY", code: "not_in_enum" }],
  ["Refund/invalid/to-neither-branch.json", pretty({ ...refund, to: { note: "x" } }), { path: "/to", code: "wrong_type" }],
  ["Refund/invalid/to-card-note-too-long.json", pretty({ ...refund, to: { last4: "4242", note: "x".repeat(21) } }), { path: "/to/note", code: "too_long" }],
  ["Refund/invalid/to-bank-iban-too-short.json", pretty({ ...refund, to: { iban: "DE893704004405" } }), { path: "/to/iban", code: "too_short" }],
  ["Refund/invalid/to-card-last4-not-digits.json", pretty({ ...refund, to: { last4: "42a2" } }), { path: "/to/last4", code: "pattern_mismatch" }],
  ["Refund/invalid/codes-repeat.json", pretty({ ...refund, codes: ["ABC", "ABC"] }), { path: "/codes/1", code: "not_unique" }],
  ["Refund/invalid/codes-too-many.json", pretty({ ...refund, codes: ["ABC", "DEF", "GHI", "JKL"] }), { path: "/codes", code: "too_long" }],
  ["Refund/invalid/issued-at-month-13.json", pretty({ ...refund, issuedAt: "2026-13-01T00:00:00Z" }), { path: "/issuedAt", code: "bad_format" }],
  ["Refund/invalid/memo-empty.json", pretty({ ...refund, memo: "" }), { path: "/memo", code: "too_short" }],
  ["Refund/invalid/memo-astral-above-maximum.json", pretty({ ...refund, memo: EMOJI.repeat(41) }), { path: "/memo", code: "too_long" }],
  ["Refund/invalid/memo-null.json", pretty({ ...refund, memo: null }), { path: "/memo", code: "null_not_allowed" }],
  ["Refund/invalid/version-other.json", pretty({ ...refund, version: 2 }), { path: "/version", code: "not_const" }],
  ["Refund/invalid/final-false.json", pretty({ ...refund, final: false }), { path: "/final", code: "not_const" }],
  ["Refund/invalid/order-too-short.json", pretty({ ...refund, order: "ord" }), { path: "/order", code: "too_short" }],
  ["Refund/invalid/reason-not-listed.json", pretty({ ...refund, reason: "changed-mind" }), { path: "/reason", code: "not_in_enum" }],
  ["Refund/invalid/unknown-key.json", pretty({ ...refund, extra: 1 }), { path: "/extra", code: "unknown_key", report: { unknown: ["/extra"] } }],
  ["Destination/valid/bank.json", pretty({ iban: "DE89370400440532013000" })],
  ["Destination/valid/card-with-note.json", pretty({ last4: "4242", note: "x" })],
  ["Destination/invalid/both-branches.json", pretty({ last4: "4242", iban: "DE89370400440532013000" }), { path: "", code: "wrong_type", report: { unknown: ["/iban"] } }],
  ["Destination/invalid/a-string.json", pretty("4242"), { path: "", code: "wrong_type" }],
  ["CardRefund/valid/with-note.json", pretty({ last4: "4242", note: "x" })],
  ["CardRefund/invalid/iban-of-the-other-branch.json", pretty({ last4: "4242", iban: "DE89370400440532013000" }), { path: "/iban", code: "unknown_key", report: { unknown: ["/iban"] } }],
  ["BankRefund/valid/minimal.json", pretty({ iban: "DE89370400440532013000" })],
  ["BankRefund/invalid/note-null.json", pretty({ iban: "DE89370400440532013000", note: null }), { path: "/note", code: "null_not_allowed" }],
  ["Reason/valid/other.json", pretty("other")],
  ["Part/valid/three-deep.json", pretty({ sku: "P-1", inner: { sku: "P-2", inner: { sku: "P-3" } } })],
  ["Part/invalid/inner-null.json", pretty({ sku: "P-1", inner: null }), { path: "/inner", code: "null_not_allowed" }],
  ["Currency/valid/gbp.json", pretty("GBP")],
  ["Currency/invalid/lower-case.json", pretty("gbp"), { path: "", code: "not_in_enum" }],

  // A wrong type for a number, a boolean and a map, and an empty map.
  [
    "Order/invalid/price-as-string.json",
    pretty({ id: "ord_5h1c", note: "ab", quantity: 1, price: "0.5", tags: ["a"] }),
    { path: "/price", code: "wrong_type" },
  ],
  ["Subscription/invalid/default-as-string.json", pretty({ url: "https://hooks.example.com/all", match: [], default: "true" }), { path: "/default", code: "wrong_type" }],
  [
    "Event/invalid/metadata-an-array.json",
    pretty({ ...event(), metadata: [] }),
    { path: "/metadata", code: "wrong_type" },
  ],
  ["Event/valid/metadata-empty.json", pretty({ ...event(), metadata: {} })],
];

function event() {
  return {
    id: "evt_31xq",
    type: "user.created",
    occurredAt: "2026-01-15T09:30:01Z",
    attempt: 1,
    user: {
      id: "usr_8f2k",
      email: "ada@example.com",
      role: "member",
      labels: {},
      createdAt: "2026-01-15T09:30:00Z",
      quota: {},
    },
  };
}

/** Every file to write, with its text: each case, and the expectation beside an invalid one. */
function files() {
  const out = [];
  for (const [path, text, expect] of CASES) {
    out.push([path, text]);
    if (expect !== undefined) out.push([path.replace(/\.json$/, ".expect.json"), `${ascii(JSON.stringify(expect))}\n`]);
  }
  return out;
}

const check = process.argv.includes("--check");
const stale = [];
for (const [path, text] of files()) {
  const url = new URL(path, ROOT);
  if (check) {
    if (!existsSync(url) || readFileSync(url, "utf8") !== text) stale.push(path);
    continue;
  }
  mkdirSync(dirname(url.pathname), { recursive: true });
  writeFileSync(url, text);
}
if (stale.length > 0) {
  process.stderr.write(`conformance-cases: out of date, run node scripts/conformance-cases.mjs: ${stale.join(", ")}\n`);
  process.exit(1);
}
