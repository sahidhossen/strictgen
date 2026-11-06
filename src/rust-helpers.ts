import { COUNT_UNITS, ERROR_CODES, FOUND_MAX, MAX_DEPTH } from "./errors.js";

/** The name of the built in type for any JSON value except `null`. */
export const RUST_NON_NULL = "NonNullJson";

/** A code as a Rust constant name, like `UNKNOWN_KEY`. */
export function rustCodeName(code: string): string {
  return code.toUpperCase();
}

/** The code constants on `DecodeError`, one per code, with their doc comments. */
const CODE_CONSTANTS = ERROR_CODES.map(
  (c) =>
    `    /// The code for ${c.doc}.\n    pub const ${rustCodeName(c.code)}: &'static str = "${c.code}";\n`,
).join("");

/** The match arms that give each code's title in messages. */
const CODE_TITLES = ERROR_CODES.map((c) => `        "${c.code}" => "${c.title}",\n`).join("");

/** The text-reading methods of the Decode trait in strict mode. */
const FROM_JSON_STRICT = String.raw`    /// Decodes JSON text, given as a str or as bytes, then checks its constraints.
    ///
    /// # Errors
    ///
    /// A [DecodeError] when the text isn't JSON, doesn't fit the type or breaks a constraint.
    fn from_json(json: impl AsRef<[u8]>) -> Result<Self, DecodeError> {
        let value = Self::decode_node(&parse(json.as_ref())?)?;
        value.check()?;
        Ok(value)
    }`;

/** The text-reading methods of the Decode trait in report mode. */
const FROM_JSON_REPORT = String.raw`    /// Decodes JSON text, given as a str or as bytes. Unknown keys are accepted, and their paths
    /// go to the hook set with [set_unknown_key_hook]. Then its constraints are checked.
    ///
    /// # Errors
    ///
    /// A [DecodeError] when the text isn't JSON, doesn't fit the type or breaks a constraint.
    fn from_json(json: impl AsRef<[u8]>) -> Result<Self, DecodeError> {
        reported(json.as_ref()).map(|decoded| decoded.value)
    }

    /// Decodes JSON text like [Decode::from_json], and returns the value with the paths of its
    /// unknown keys, in input order.
    ///
    /// # Errors
    ///
    /// A [DecodeError] when the text isn't JSON, doesn't fit the type or breaks a constraint.
    fn report_from_json(json: impl AsRef<[u8]>) -> Result<Reported<Self>, DecodeError> {
        reported(json.as_ref())
    }`;

/** What report mode adds to the core: Reported, the hook, the collector and input order. */
const REPORT_CORE = String.raw`
/// A decoded value and the paths of the unknown keys its input had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reported<T> {
    /// The decoded value, which leaves the unknown keys out.
    pub value: T,
    /// The JSON Pointer of each unknown key, like /customer/nickname, in the order the keys
    /// appear in the input. Empty when there are none.
    pub unknown: Vec<String>,
}

/// A hook set_unknown_key_hook sets.
type Hook = std::sync::Arc<dyn Fn(&[String]) + Send + Sync>;

/// The hook every decode calls with the paths of its unknown keys.
static HOOK: std::sync::RwLock<Option<Hook>> = std::sync::RwLock::new(None);

/// Sets the one hook every decode calls with the paths of the unknown keys it accepted, for
/// logging or counting them in one place. A decode calls it after the value decoded, only when
/// there is at least one unknown key, and before it returns. It replaces the hook set before.
pub fn set_unknown_key_hook(hook: impl Fn(&[String]) + Send + Sync + 'static) {
    *HOOK.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(std::sync::Arc::new(hook));
}

/// Removes the hook [set_unknown_key_hook] set.
pub fn clear_unknown_key_hook() {
    *HOOK.write().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
}

thread_local! {
    /// While a decode runs on this thread: the byte offsets of the values of the unknown keys it
    /// accepted so far, in decode order.
    static UNKNOWN: std::cell::RefCell<Option<Vec<usize>>> = const { std::cell::RefCell::new(None) };
}

/// The collector of one decode on this thread. Dropping it restores the collector of the decode
/// that was running before, even when decoding panics, so nothing notes into a stale one.
struct Collecting {
    saved: Option<Vec<usize>>,
}

impl Collecting {
    /// Starts an empty collector, keeping the one before.
    fn start() -> Self {
        Self { saved: UNKNOWN.with(|cell| cell.replace(Some(Vec::new()))) }
    }

    /// Ends the collector, restores the one before, and returns the offsets it noted.
    fn finish(self) -> Vec<usize> {
        let offsets = UNKNOWN.with(|cell| cell.borrow_mut().take()).unwrap_or_default();
        drop(self);
        offsets
    }
}

impl Drop for Collecting {
    fn drop(&mut self) {
        let saved = self.saved.take();
        // The thread's storage may be gone when the thread exits; then there is nothing to restore.
        let _ = UNKNOWN.try_with(|cell| cell.replace(saved));
    }
}

/// Parses data once, decodes it as T, calls the hook and returns the value with the paths of
/// its unknown keys.
fn reported<T: Decode>(data: &[u8]) -> Result<Reported<T>, DecodeError> {
    let root = parse(data)?;
    let collecting = Collecting::start();
    let result = T::decode_node(&root);
    let mut offsets = collecting.finish();
    let value = result?;
    value.check()?;
    // Offsets sort the keys into input order.
    offsets.sort_unstable();
    let unknown: Vec<String> = offsets.into_iter().map(|at| path_to(&root, at)).collect();
    if !unknown.is_empty() {
        let hook = HOOK.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        if let Some(hook) = hook {
            hook(&unknown);
        }
    }
    Ok(Reported { value, unknown })
}

/// The JSON Pointer, under node, of the value that starts at the byte offset at. The children of
/// a node are in input order, so the last one that starts at or before the offset holds it.
fn path_to(mut node: &Node<'_>, at: usize) -> String {
    let mut path = String::new();
    while node.at != at {
        match &node.kind {
            Kind::Array(items) => {
                let Some(i) = items.partition_point(|item| item.at <= at).checked_sub(1) else {
                    break;
                };
                let Some(item) = items.get(i) else {
                    break;
                };
                path.push_str(&pointer(&i.to_string()));
                node = item;
            }
            Kind::Object(members) => {
                let entries = &members.entries;
                let Some(i) = entries.partition_point(|(_, item)| item.at <= at).checked_sub(1) else {
                    break;
                };
                let Some((name, item)) = entries.get(i) else {
                    break;
                };
                path.push_str(&pointer(name));
                node = item;
            }
            _ => break,
        }
    }
    path
}
`;

/**
 * The part of the generated `helpers.rs` every output has: the error, the parser, the `Decode`
 * trait and its impls for the standard types. It is a raw template, so backslashes stand for
 * themselves. Go's helpers.go and TypeScript's helpers.ts follow the same rules, so the three
 * report the same errors. `report` adds what report mode needs.
 */
export function rustHelpersCore(report: boolean): string {
  return String.raw`use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::fmt;

use serde::Serialize;

/// serde_json's recursion limit: a value nested in ${String(MAX_DEPTH)} or more arrays and objects fails, so
/// Rust, Go and TypeScript accept the same documents and decoding stays bounded.
const MAX_DEPTH: usize = ${String(MAX_DEPTH)};

/// The number of code points of a string an error shows, before "...".
const FOUND_MAX: usize = ${String(FOUND_MAX)};

/// A value that doesn't fit its generated type, or input that isn't JSON. Go and TypeScript
/// report the same path, code, expected and found for the same input, and the same message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    /// A JSON Pointer to the value that failed, like /items/0/price, empty for the whole input.
    pub path: String,
    /// What failed, one of the code constants, like DecodeError::MISSING_KEY.
    pub code: &'static str,
    /// What the type takes there, like "a string", when the code has one.
    pub expected: Option<String>,
    /// What the input has there, like 12.5 or "x", when the code has one.
    pub found: Option<String>,
}

impl DecodeError {
${CODE_CONSTANTS}
    /// The one-line form, made for logs and for asking an LLM to retry, like
    /// /items/0 wrong_type, expected a string, found 1.
    #[must_use]
    pub fn compact(&self) -> String {
        describe(&self.path, self.code, " ", self.expected.as_deref(), self.found.as_deref())
    }

    /// An error at the current value.
    fn new(code: &'static str, expected: Option<String>, found: Option<String>) -> Self {
        Self { path: String::new(), code, expected, found }
    }

    /// Moves the error one level down, under an object key or array index.
    fn at(mut self, segment: &str) -> Self {
        self.path.insert_str(0, &pointer(segment));
        self
    }
}

impl fmt::Display for DecodeError {
    /// Writes the message, like /items/0: wrong type, expected a string, found 1.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let head = title(self.code);
        f.write_str(&describe(&self.path, head, ": ", self.expected.as_deref(), self.found.as_deref()))
    }
}

impl std::error::Error for DecodeError {}

/// The words for a code in a message.
fn title(code: &str) -> &'static str {
    match code {
${CODE_TITLES}        _ => "",
    }
}

/// Builds a message: the path, then head, then expected and found when they are set.
fn describe(path: &str, head: &str, gap: &str, expected: Option<&str>, found: Option<&str>) -> String {
    let mut text = String::new();
    if !path.is_empty() {
        text.push_str(path);
        text.push_str(gap);
    }
    text.push_str(head);
    if let Some(expected) = expected.filter(|e| !e.is_empty()) {
        text.push_str(", expected ");
        text.push_str(expected);
    }
    if let Some(found) = found.filter(|f| !f.is_empty()) {
        text.push_str(", found ");
        text.push_str(found);
    }
    text
}

/// A JSON Pointer segment, with its slash.
fn pointer(segment: &str) -> String {
    format!("/{}", segment.replace('~', "~0").replace('/', "~1"))
}

/// Shows a string as errors do in every language: in double quotes, with " and \ escaped by a
/// backslash and control characters (U+0000 to U+001F, U+007F to U+009F), U+2028 and U+2029 as
/// \u and four hex digits. A string of more than FOUND_MAX code points shows its first
/// FOUND_MAX, then ... after the quote.
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for (count, c) in text.chars().enumerate() {
        if count == FOUND_MAX {
            out.push_str("\"...");
            return out;
        }
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{2028}' | '\u{2029}' => {
                let code = u32::from(c);
                out.push_str("\\u");
                for shift in [12, 8, 4, 0] {
                    out.push(char::from_digit((code >> shift) & 0xf, 16).unwrap_or('0'));
                }
            }
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One parsed JSON value. Input is parsed once, then decoders walk the nodes, so decoding is
/// linear in the input size.
#[doc(hidden)]
pub struct Node<'a> {
    /// The value as spelled in the input.
    raw: &'a str,
    /// The byte offset of the value in the input.
    at: usize,
    kind: Kind<'a>,
}

enum Kind<'a> {
    Null,
    True,
    False,
    Number,
    String(Cow<'a, str>),
    Array(Vec<Node<'a>>),
    Object(Members<'a>),
}

/// The members of an object in input order, each key once.
#[derive(Default)]
struct Members<'a> {
    entries: Vec<(Cow<'a, str>, Node<'a>)>,
    /// The position of each key, once the object has more than a few.
    index: Option<HashMap<Cow<'a, str>, usize>>,
}

/// Objects with more keys than this look keys up through an index.
const INDEX_FROM: usize = 8;

impl<'a> Members<'a> {
    /// The position of key, if the object has it.
    fn find(&self, key: &str) -> Option<usize> {
        match &self.index {
            Some(index) => index.get(key).copied(),
            None => self.entries.iter().position(|(name, _)| name == key),
        }
    }

    /// Adds a member whose key the object doesn't have yet.
    fn push(&mut self, key: Cow<'a, str>, node: Node<'a>) {
        let at = self.entries.len();
        if let Some(index) = &mut self.index {
            index.insert(key.clone(), at);
        } else if at == INDEX_FROM {
            let mut index: HashMap<Cow<'a, str>, usize> =
                self.entries.iter().enumerate().map(|(i, (name, _))| (name.clone(), i)).collect();
            index.insert(key.clone(), at);
            self.index = Some(index);
        }
        self.entries.push((key, node));
    }
}

impl<'a> Node<'a> {
    /// A string node for an object key, so a map key decodes like a JSON string.
    fn key(name: &'a str) -> Self {
        Node { raw: "", at: 0, kind: Kind::String(Cow::Borrowed(name)) }
    }
}

/// Shows a value as errors do: null, true and false, a number as spelled, a string quoted,
/// "an array" and "an object".
fn found(node: &Node<'_>) -> String {
    match &node.kind {
        Kind::Object(_) => "an object".to_owned(),
        Kind::Array(_) => "an array".to_owned(),
        Kind::String(text) => quote(text),
        Kind::Null => "null".to_owned(),
        Kind::True => "true".to_owned(),
        Kind::False => "false".to_owned(),
        Kind::Number => node.raw.to_owned(),
    }
}

/// The error for a value that is not what expected names: null_not_allowed for null, else
/// wrong_type.
pub(super) fn mismatch(expected: &str, node: &Node<'_>) -> DecodeError {
    if matches!(node.kind, Kind::Null) {
        return DecodeError::new(DecodeError::NULL_NOT_ALLOWED, Some(expected.to_owned()), None);
    }
    DecodeError::new(DecodeError::WRONG_TYPE, Some(expected.to_owned()), Some(found(node)))
}

/// An invalid_json error, what was found at a byte offset.
fn invalid(offset: usize, what: &str) -> DecodeError {
    DecodeError::new(DecodeError::INVALID_JSON, None, Some(format!("{what} at offset {offset}")))
}

/// Reads JSON like serde_json: strict grammar, valid UTF-8, no lone surrogates, finite numbers
/// and at most MAX_DEPTH - 1 nested arrays and objects. Every failure carries its error code and
/// the JSON Pointer of the value being read, and found gives the byte offset.
struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

/// Parses a whole JSON document.
fn parse(data: &[u8]) -> Result<Node<'_>, DecodeError> {
    let text = std::str::from_utf8(data).map_err(|error| invalid(error.valid_up_to(), "invalid UTF-8"))?;
    let mut p = Parser { text, pos: 0 };
    let node = p.value(0)?;
    p.space();
    if p.pos != text.len() {
        return Err(p.fail("trailing characters"));
    }
    Ok(node)
}

impl<'a> Parser<'a> {
    fn fail(&self, what: &str) -> DecodeError {
        invalid(self.pos, what)
    }

    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    /// The input from start to the current position.
    fn since(&self, start: usize) -> &'a str {
        self.text.get(start..self.pos).unwrap_or_default()
    }

    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    /// Consumes c if it comes next.
    fn accept(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.pos += 1;
            return true;
        }
        false
    }

    /// Parses one value inside depth arrays and objects.
    fn value(&mut self, depth: usize) -> Result<Node<'a>, DecodeError> {
        self.space();
        let start = self.pos;
        let Some(c) = self.peek() else {
            return Err(self.fail("an unexpected end of input"));
        };
        let kind = match c {
            b'{' | b'[' => {
                if depth + 1 >= MAX_DEPTH {
                    return Err(DecodeError::new(
                        DecodeError::TOO_DEEP,
                        Some(format!("at most {} nested arrays and objects", MAX_DEPTH - 1)),
                        Some(format!("more at offset {}", self.pos)),
                    ));
                }
                if c == b'{' { self.object(depth + 1)? } else { self.array(depth + 1)? }
            }
            b'"' => Kind::String(self.string()?),
            b't' => self.literal("true", Kind::True)?,
            b'f' => self.literal("false", Kind::False)?,
            b'n' => self.literal("null", Kind::Null)?,
            _ => self.number()?,
        };
        Ok(Node { raw: self.since(start), at: start, kind })
    }

    /// Reads true, false or null, failing at the first byte that differs, like serde_json.
    fn literal(&mut self, word: &str, kind: Kind<'a>) -> Result<Kind<'a>, DecodeError> {
        for &b in word.as_bytes() {
            if self.peek() != Some(b) {
                return Err(self.fail("an invalid literal"));
            }
            self.pos += 1;
        }
        Ok(kind)
    }

    fn object(&mut self, depth: usize) -> Result<Kind<'a>, DecodeError> {
        let mut members = Members::default();
        self.pos += 1;
        self.space();
        if self.accept(b'}') {
            return Ok(Kind::Object(members));
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return Err(self.fail("a missing key"));
            }
            let key_at = self.pos;
            let key = self.string()?;
            if members.find(&key).is_some() {
                let found = format!("{} at offset {key_at}", quote(&key));
                return Err(DecodeError::new(DecodeError::DUPLICATE_KEY, None, Some(found)).at(&key));
            }
            self.space();
            if !self.accept(b':') {
                return Err(self.fail("a missing colon"));
            }
            let value = self.value(depth).map_err(|error| error.at(&key))?;
            members.push(key, value);
            self.space();
            if self.accept(b'}') {
                return Ok(Kind::Object(members));
            }
            if !self.accept(b',') {
                return Err(self.fail("a missing comma or closing brace"));
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Kind<'a>, DecodeError> {
        let mut items = Vec::new();
        self.pos += 1;
        self.space();
        if self.accept(b']') {
            return Ok(Kind::Array(items));
        }
        loop {
            let item = self.value(depth).map_err(|error| error.at(&items.len().to_string()))?;
            items.push(item);
            self.space();
            if self.accept(b']') {
                return Ok(Kind::Array(items));
            }
            if !self.accept(b',') {
                return Err(self.fail("a missing comma or closing bracket"));
            }
        }
    }

    /// Parses a string, rejecting control characters and lone surrogates.
    fn string(&mut self) -> Result<Cow<'a, str>, DecodeError> {
        self.pos += 1;
        let mut chunk = self.pos;
        let mut text: Option<String> = None;
        loop {
            let Some(c) = self.peek() else {
                return Err(self.fail("an unterminated string"));
            };
            match c {
                b'"' => {
                    let tail = self.since(chunk);
                    self.pos += 1;
                    return Ok(match text {
                        None => Cow::Borrowed(tail),
                        Some(mut text) => {
                            text.push_str(tail);
                            Cow::Owned(text)
                        }
                    });
                }
                b'\\' => {
                    let tail = self.since(chunk);
                    let c = self.escape()?;
                    let text = text.get_or_insert_with(String::new);
                    text.push_str(tail);
                    text.push(c);
                    chunk = self.pos;
                }
                0..=0x1f => return Err(self.fail("a control character in a string")),
                _ => self.pos += 1,
            }
        }
    }

    /// Reads one escape sequence at the backslash. A \u escape of a high surrogate must be
    /// followed by one of a low surrogate, and a low surrogate can't stand alone. A bad escape
    /// or hex digit fails at that byte, and a surrogate that isn't half of a pair fails at the
    /// backslash.
    fn escape(&mut self) -> Result<char, DecodeError> {
        let start = self.pos;
        self.pos += 1;
        let c = match self.peek() {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{c}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                self.pos += 1;
                return self.unicode(start);
            }
            _ => return Err(self.fail("an invalid escape")),
        };
        self.pos += 1;
        Ok(c)
    }

    /// Reads the hex digits of a \u escape that starts at start, and of its low surrogate.
    fn unicode(&mut self, start: usize) -> Result<char, DecodeError> {
        let lone = || invalid(start, "a lone surrogate");
        let unit = self.hex4()?;
        if (0xDC00..=0xDFFF).contains(&unit) {
            return Err(lone());
        }
        if !(0xD800..=0xDBFF).contains(&unit) {
            return char::from_u32(unit).ok_or_else(lone);
        }
        if self.peek() != Some(b'\\') || self.text.as_bytes().get(self.pos + 1) != Some(&b'u') {
            return Err(lone());
        }
        self.pos += 2;
        let low = self.hex4()?;
        if !(0xDC00..=0xDFFF).contains(&low) {
            return Err(lone());
        }
        char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)).ok_or_else(lone)
    }

    /// Reads the four hex digits of a \u escape, failing at the first that isn't one.
    fn hex4(&mut self) -> Result<u32, DecodeError> {
        let mut unit = 0;
        for _ in 0..4 {
            let Some(digit) = self.peek().and_then(|c| char::from(c).to_digit(16)) else {
                return Err(self.fail("an invalid escape"));
            };
            unit = unit * 16 + digit;
            self.pos += 1;
        }
        Ok(unit)
    }

    /// Consumes digits and returns how many.
    fn digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos - start
    }

    /// Parses a number in JSON's grammar that is finite as an f64, like serde_json.
    fn number(&mut self) -> Result<Kind<'a>, DecodeError> {
        let start = self.pos;
        self.accept(b'-');
        if self.accept(b'0') {
            if matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(self.fail("a leading zero"));
            }
        } else if self.digits() == 0 {
            return Err(self.fail("an invalid value"));
        }
        if self.accept(b'.') && self.digits() == 0 {
            return Err(self.fail("an invalid number"));
        }
        if self.accept(b'e') || self.accept(b'E') {
            if !self.accept(b'+') {
                self.accept(b'-');
            }
            if self.digits() == 0 {
                return Err(self.fail("an invalid number"));
            }
        }
        if !self.since(start).parse::<f64>().is_ok_and(f64::is_finite) {
            return Err(invalid(start, "a number out of range"));
        }
        Ok(Kind::Number)
    }
}

${report ? `${REPORT_CORE.trimStart()}\n` : ""}/// A type strictgen generates, which decodes itself from JSON strictly: ${report ? "missing" : "unknown keys, missing"}
/// required keys, explicit nulls for optional keys, a key given twice and values of the wrong
/// type fail with a [DecodeError], the same one Go and TypeScript report.${report ? "\n/// Unknown keys are accepted and reported." : ""} Once the whole
/// value has decoded, its constraints, like a maximum length, are checked in the order Go and
/// TypeScript check them.
pub trait Decode: Sized {
${report ? FROM_JSON_REPORT : FROM_JSON_STRICT}

    /// Decodes a parsed value, without checking its constraints.
    ///
    /// # Errors
    ///
    /// A [DecodeError] when the value doesn't fit the type.
    #[doc(hidden)]
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError>;

    /// Checks the constraints of a decoded value: its own, then those of the values inside it.
    ///
    /// # Errors
    ///
    /// A [DecodeError] for the first constraint the value breaks.
    #[doc(hidden)]
    fn check(&self) -> Result<(), DecodeError> {
        Ok(())
    }
}

/// A JSON string.
pub(super) fn string<'n>(node: &'n Node<'_>) -> Result<&'n str, DecodeError> {
    match &node.kind {
        Kind::String(text) => Ok(text),
        _ => Err(mismatch("a string", node)),
    }
}

/// A JSON integer that fits an i64. A fraction like 1.5, a spelling like 1.0 or 1e2, and -0,
/// which serde_json reads as a float, fail with wrong_type. An integer past the i64 range fails
/// with out_of_range_integer.
fn integer(node: &Node<'_>) -> Result<i64, DecodeError> {
    if !matches!(node.kind, Kind::Number) {
        return Err(mismatch("an integer", node));
    }
    let raw = node.raw;
    if raw.contains(['.', 'e', 'E']) || raw == "-0" {
        return Err(DecodeError::new(DecodeError::WRONG_TYPE, Some("an integer".to_owned()), Some(raw.to_owned())));
    }
    raw.parse().map_err(|_| {
        DecodeError::new(
            DecodeError::OUT_OF_RANGE_INTEGER,
            Some("an integer from -9223372036854775808 to 9223372036854775807".to_owned()),
            Some(raw.to_owned()),
        )
    })
}

/// A JSON boolean.
fn boolean(node: &Node<'_>) -> Result<bool, DecodeError> {
    match node.kind {
        Kind::True => Ok(true),
        Kind::False => Ok(false),
        _ => Err(mismatch("a boolean", node)),
    }
}

/// Any JSON value, null included.
fn json_value(node: &Node<'_>) -> Result<serde_json::Value, DecodeError> {
    Ok(match &node.kind {
        Kind::Null => serde_json::Value::Null,
        Kind::True => serde_json::Value::Bool(true),
        Kind::False => serde_json::Value::Bool(false),
        Kind::Number => serde_json::Value::Number(number(node)?),
        Kind::String(text) => serde_json::Value::String(text.clone().into_owned()),
        Kind::Array(items) => serde_json::Value::Array(items.iter().map(json_value).collect::<Result<_, _>>()?),
        Kind::Object(members) => serde_json::Value::Object(
            members
                .entries
                .iter()
                .map(|(name, item)| Ok((name.clone().into_owned(), json_value(item)?)))
                .collect::<Result<_, DecodeError>>()?,
        ),
    })
}

/// A finite JSON number. An integer that fits a u64 or an i64 stays one, as serde_json reads it.
/// Any other number, -0 included, is the nearest f64, read by Rust's own parser, which rounds
/// correctly where serde_json's default parser can be a step off, so constraints compare the
/// same value as in Go and TypeScript.
fn number(node: &Node<'_>) -> Result<serde_json::Number, DecodeError> {
    if !matches!(node.kind, Kind::Number) {
        return Err(mismatch("a number", node));
    }
    let raw = node.raw;
    if let Ok(value) = raw.parse::<u64>() {
        return Ok(value.into());
    }
    // -0 parses as the i64 0, which would lose its sign.
    if let Some(value) = raw.parse::<i64>().ok().filter(|&value| value != 0) {
        return Ok(value.into());
    }
    raw.parse::<f64>()
        .ok()
        .and_then(serde_json::Number::from_f64)
        .ok_or_else(|| invalid(node.at, "a number out of range"))
}

impl Decode for String {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        string(node).map(str::to_owned)
    }
}

impl Decode for i64 {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        integer(node)
    }
}

impl Decode for bool {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        boolean(node)
    }
}

/// Keeps a finite JSON number. serde_json writes it as it reads it, so 12 re-encodes as 12 and
/// 1E2 as 100.0.
impl Decode for serde_json::Number {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        number(node)
    }
}

/// Keeps any JSON value, null included.
impl Decode for serde_json::Value {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        json_value(node)
    }
}

impl<T: Decode> Decode for Box<T> {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        T::decode_node(node).map(Box::new)
    }

    fn check(&self) -> Result<(), DecodeError> {
        T::check(self)
    }
}

impl<T: Decode> Decode for Vec<T> {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        let Kind::Array(items) = &node.kind else {
            return Err(mismatch("an array", node));
        };
        items
            .iter()
            .enumerate()
            .map(|(i, item)| T::decode_node(item).map_err(|error| error.at(&i.to_string())))
            .collect()
    }
}

/// Decodes a JSON object whose keys decode as K, like an enum or an id, and values as V.
impl<K: Decode + Ord, V: Decode> Decode for BTreeMap<K, V> {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        let Kind::Object(members) = &node.kind else {
            return Err(mismatch("an object", node));
        };
        members.entries.iter().map(|(name, item)| entry(name, item)).collect()
    }
}

/// Decodes one member of a map, its key as a JSON string. A key that fails fails at its own
/// path, like the value under it.
fn entry<K: Decode, V: Decode>(name: &str, node: &Node<'_>) -> Result<(K, V), DecodeError> {
    let key = K::decode_node(&Node::key(name)).map_err(|error| error.at(name))?;
    let value = V::decode_node(node).map_err(|error| error.at(name))?;
    Ok((key, value))
}

/// Any JSON value except ${"`"}null${"`"} at the top, like ${"`"}jsonValue${"`"}. Nested values may be anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ${RUST_NON_NULL}(pub serde_json::Value);

impl Decode for ${RUST_NON_NULL} {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        if matches!(node.kind, Kind::Null) {
            return Err(DecodeError::new(
                DecodeError::NULL_NOT_ALLOWED,
                Some("a JSON value other than null".to_owned()),
                None,
            ));
        }
        json_value(node).map(Self)
    }
}
`;
}

/** Object::finish in strict mode: a key that wasn't read fails. */
const FINISH_STRICT = String.raw`    /// Fails on the first key, in input order, that wasn't read, at its own path.
    pub(super) fn finish(self) -> Result<(), DecodeError> {
        for ((name, _), used) in self.members.entries.iter().zip(&self.used) {
            if !used {
                return Err(DecodeError::new(DecodeError::UNKNOWN_KEY, None, None).at(name));
            }
        }
        Ok(())
    }`;

/** Object::finish in report mode: a key that wasn't read is noted, unless forbidden names it. */
const FINISH_REPORT = String.raw`    /// Notes each key, in input order, that wasn't read as unknown, for the decode that runs. A
    /// key in forbidden, which a sibling branch of an exactly-one union names, still fails with
    /// unknown_key at its own path.
    pub(super) fn finish(self, forbidden: &[&str]) -> Result<(), DecodeError> {
        for ((name, node), used) in self.members.entries.iter().zip(&self.used) {
            if *used {
                continue;
            }
            if forbidden.contains(&name.as_ref()) || !note_unknown(node.at) {
                return Err(DecodeError::new(DecodeError::UNKNOWN_KEY, None, None).at(name));
            }
        }
        Ok(())
    }`;

/** Report mode's note of one unknown key, which finish uses. */
const NOTE_UNKNOWN = String.raw`
/// Notes the unknown key whose value starts at the byte offset at, for the decode running on
/// this thread. False when none runs, so the key fails instead of being dropped.
fn note_unknown(at: usize) -> bool {
    UNKNOWN.with(|cell| match cell.borrow_mut().as_mut() {
        Some(offsets) => {
            offsets.push(at);
            true
        }
        None => false,
    })
}
`;

/** The object decoder, for outputs with a struct. `report` notes unknown keys instead of failing. */
export function rustHelpersObject(report: boolean): string {
  return String.raw`/// Reads the keys of a JSON object into a struct and tracks the keys it read.
pub(super) struct Object<'n, 'a> {
    members: &'n Members<'a>,
    used: Vec<bool>,
}

impl<'n, 'a> Object<'n, 'a> {
    /// Starts decoding a JSON object strictly: read its keys in schema order, then finish, which
    /// fails on the first key, in input order, that wasn't read.
    pub(super) fn new(node: &'n Node<'a>) -> Result<Self, DecodeError> {
        let Kind::Object(members) = &node.kind else {
            return Err(mismatch("an object", node));
        };
        Ok(Self { members, used: vec![false; members.entries.len()] })
    }

    /// Reads a key that must be present. A missing key fails at its own path.
    pub(super) fn required<T: Decode>(&mut self, key: &str) -> Result<T, DecodeError> {
        self.optional(key)?.ok_or_else(|| DecodeError::new(DecodeError::MISSING_KEY, None, None).at(key))
    }

    /// Reads an optional key, None when it is absent. An explicit null fails, unless the type
    /// takes any JSON value.
    pub(super) fn optional<T: Decode>(&mut self, key: &str) -> Result<Option<T>, DecodeError> {
        let Some(i) = self.members.find(key) else {
            return Ok(None);
        };
        let Some((_, node)) = self.members.entries.get(i) else {
            return Ok(None);
        };
        if let Some(used) = self.used.get_mut(i) {
            *used = true;
        }
        T::decode_node(node).map(Some).map_err(|error| error.at(key))
    }

${report ? FINISH_REPORT : FINISH_STRICT}
}
${report ? NOTE_UNKNOWN : ""}`;
}

/** The rest map reader, for outputs with a struct that has named keys and a map of the others. */
export const RUST_HELPERS_REST = String.raw`impl Object<'_, '_> {
    /// Reads every key not read yet into a map, for a struct with named keys and a map of the
    /// others.
    pub(super) fn rest<K: Decode + Ord, V: Decode>(&mut self) -> Result<BTreeMap<K, V>, DecodeError> {
        let mut out = BTreeMap::new();
        for ((name, node), used) in self.members.entries.iter().zip(self.used.iter_mut()) {
            if !*used {
                *used = true;
                let (key, value) = entry(name, node)?;
                out.insert(key, value);
            }
        }
        Ok(out)
    }
}
`;

/** Lists of values, for enums and tagged unions. */
export const RUST_HELPERS_ONE_OF = String.raw`/// Lists the values an enum or a tagged union takes, quoted, in the schema's order.
fn one_of(values: &[&str]) -> String {
    let quoted: Vec<String> = values.iter().map(|v| quote(v)).collect();
    format!("one of {}", quoted.join(", "))
}
`;

/** The enum decoder's error, for outputs with an enum. */
export const RUST_HELPERS_ENUM = String.raw`/// The error for a string an enum doesn't list: not_in_enum, naming the values in the schema's
/// order, or not_const for an enum of one value.
pub(super) fn not_in_enum(text: &str, values: &[&str]) -> DecodeError {
    if let [only] = values {
        return DecodeError::new(DecodeError::NOT_CONST, Some(quote(only)), Some(quote(text)));
    }
    DecodeError::new(DecodeError::NOT_IN_ENUM, Some(one_of(values)), Some(quote(text)))
}
`;

/** The tag reader, for outputs with a tagged union. */
export const RUST_HELPERS_TAGGED = String.raw`/// Reads the tag key of a tagged union. A missing tag fails with missing_key and a tag that
/// isn't a string with wrong_type, at the tag's path.
pub(super) fn tag<'n>(node: &'n Node<'_>, key: &str) -> Result<&'n str, DecodeError> {
    let Kind::Object(members) = &node.kind else {
        return Err(mismatch("an object", node));
    };
    let Some((_, tag)) = members.find(key).and_then(|i| members.entries.get(i)) else {
        return Err(DecodeError::new(DecodeError::MISSING_KEY, None, None).at(key));
    };
    string(tag).map_err(|error| error.at(key))
}

/// The error for a tag no branch has, naming the tags in the schema's order, at the tag's path.
pub(super) fn bad_tag(key: &str, text: &str, tags: &[&str]) -> DecodeError {
    DecodeError::new(DecodeError::BAD_TAG, Some(one_of(tags)), Some(quote(text))).at(key)
}
`;

/** The integer const, for outputs with one. */
export const RUST_HELPERS_CONST_INT = String.raw`/// An integer const, like schemaVersion. Decoding any other value fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ConstInt<const N: i64>;

impl<const N: i64> Serialize for ConstInt<N> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i64(N)
    }
}

impl<const N: i64> Decode for ConstInt<N> {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        if integer(node)? == N {
            return Ok(Self);
        }
        Err(DecodeError::new(DecodeError::NOT_CONST, Some(N.to_string()), Some(node.raw.to_owned())))
    }
}
`;

/** The boolean const, for outputs with one. */
export const RUST_HELPERS_CONST_BOOL = String.raw`/// A boolean const. Decoding the other value fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct ConstBool<const B: bool>;

impl<const B: bool> Serialize for ConstBool<B> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(B)
    }
}

impl<const B: bool> Decode for ConstBool<B> {
    fn decode_node(node: &Node<'_>) -> Result<Self, DecodeError> {
        let value = boolean(node)?;
        if value == B {
            return Ok(Self);
        }
        Err(DecodeError::new(DecodeError::NOT_CONST, Some(B.to_string()), Some(value.to_string())))
    }
}
`;

/** The untagged variant runner, for outputs in report mode with an untagged union. */
export const RUST_HELPERS_ATTEMPT = String.raw`/// Runs one variant of an untagged union. When it fails, the unknown keys it noted are dropped,
/// so only the variant used reports its own.
pub(super) fn attempt<T>(decode: impl FnOnce() -> Result<T, DecodeError>) -> Result<T, DecodeError> {
    let mark = UNKNOWN.with(|cell| cell.borrow().as_ref().map_or(0, Vec::len));
    let result = decode();
    if result.is_err() {
        UNKNOWN.with(|cell| {
            if let Some(offsets) = cell.borrow_mut().as_mut() {
                offsets.truncate(mark);
            }
        });
    }
    result
}
`;

/** One constraint check helper: its text, and the other parts it calls. */
export interface RustCheckPart {
  readonly needs: readonly string[];
  readonly text: string;
}

/**
 * The constraint checks, one part per helper, keyed by the helper's name. emitRust includes a
 * part when the generated code calls the helper, with the parts it needs, so the module has no
 * dead code. The checks run once the whole value has decoded, in the order src/checks.ts sets.
 */
export const RUST_HELPERS_CHECKS: Readonly<Record<string, RustCheckPart>> = {
  within: {
    needs: [],
    text: String.raw`/// Moves the error of a check under an object key, so it has the key's path.
pub(super) fn within(key: &str, result: Result<(), DecodeError>) -> Result<(), DecodeError> {
    result.map_err(|error| error.at(key))
}
`,
  },
  check_count: {
    needs: [],
    text: String.raw`/// Shows n things, like "1 character" or "3 items".
fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

/// Checks a count of things against a minimum and a maximum.
fn check_count(n: usize, min: Option<usize>, max: Option<usize>, one: &str, many: &str) -> Result<(), DecodeError> {
    if let Some(min) = min.filter(|&min| n < min) {
        return Err(DecodeError::new(
            DecodeError::TOO_SHORT,
            Some(format!("at least {}", count(min, one, many))),
            Some(count(n, one, many)),
        ));
    }
    if let Some(max) = max.filter(|&max| n > max) {
        return Err(DecodeError::new(
            DecodeError::TOO_LONG,
            Some(format!("at most {}", count(max, one, many))),
            Some(count(n, one, many)),
        ));
    }
    Ok(())
}
`,
  },
  check_length: {
    needs: ["check_count"],
    text: String.raw`/// Checks the length of a string in code points, like Go and TypeScript count it.
pub(super) fn check_length(text: &str, min: Option<usize>, max: Option<usize>) -> Result<(), DecodeError> {
    check_count(text.chars().count(), min, max, "${COUNT_UNITS.length[0]}", "${COUNT_UNITS.length[1]}")
}
`,
  },
  check_items: {
    needs: ["check_count"],
    text: String.raw`/// Checks the number of items of an array, then each item with item.
pub(super) fn check_items<T>(
    items: &[T],
    min: Option<usize>,
    max: Option<usize>,
    item: impl Fn(&T) -> Result<(), DecodeError>,
) -> Result<(), DecodeError> {
    check_count(items.len(), min, max, "${COUNT_UNITS.items[0]}", "${COUNT_UNITS.items[1]}")?;
    for (i, value) in items.iter().enumerate() {
        item(value).map_err(|error| error.at(&i.to_string()))?;
    }
    Ok(())
}
`,
  },
  check_entries: {
    needs: ["check_count"],
    text: String.raw`/// Checks the number of keys of a map, then, in key order, which is code point order, each key
/// with key and its value with value, at the key's path, which name gives.
pub(super) fn check_entries<K, V>(
    map: &BTreeMap<K, V>,
    min: Option<usize>,
    max: Option<usize>,
    name: impl Fn(&K) -> &str,
    key: impl Fn(&K) -> Result<(), DecodeError>,
    value: impl Fn(&V) -> Result<(), DecodeError>,
) -> Result<(), DecodeError> {
    check_count(map.len(), min, max, "${COUNT_UNITS.keys[0]}", "${COUNT_UNITS.keys[1]}")?;
    for (k, v) in map {
        key(k).map_err(|error| error.at(name(k)))?;
        value(v).map_err(|error| error.at(name(k)))?;
    }
    Ok(())
}
`,
  },
  limit_error: {
    needs: [],
    text: String.raw`/// The error for a value outside a limit: op is >=, >, <= or <, or % for a multiple, and text
/// is the bound as errors show it.
fn limit_error(op: &str, text: &str, found: String) -> DecodeError {
    let (code, expected) = match op {
        ">=" | ">" => (DecodeError::TOO_SMALL, format!("{op} {text}")),
        "<=" | "<" => (DecodeError::TOO_LARGE, format!("{op} {text}")),
        _ => (DecodeError::NOT_MULTIPLE_OF, format!("a multiple of {text}")),
    };
    DecodeError::new(code, Some(expected), Some(found))
}
`,
  },
  check_integer: {
    needs: ["limit_error"],
    text: String.raw`/// Checks an integer against each limit in order, given as (op, bound, text).
pub(super) fn check_integer(value: i64, limits: &[(&str, i64, &str)]) -> Result<(), DecodeError> {
    for &(op, bound, text) in limits {
        let outside = match op {
            ">=" => value < bound,
            ">" => value <= bound,
            "<=" => value > bound,
            "<" => value >= bound,
            _ => value % bound != 0,
        };
        if outside {
            return Err(limit_error(op, text, value.to_string()));
        }
    }
    Ok(())
}
`,
  },
  check_number: {
    needs: ["limit_error"],
    text: String.raw`/// Checks a number against each limit in order, given as (op, bound, text). It compares the f64
/// serde_json reads, the nearest f64 to the number as spelled, as Go and TypeScript do. Without
/// serde_json's float_roundtrip feature, a rare number with many digits reads one step off.
pub(super) fn check_number(value: &serde_json::Number, limits: &[(&str, f64, &str)]) -> Result<(), DecodeError> {
    let Some(number) = value.as_f64() else {
        return Err(DecodeError::new(DecodeError::WRONG_TYPE, Some("a number".to_owned()), Some(value.to_string())));
    };
    for &(op, bound, text) in limits {
        let outside = match op {
            ">=" => number < bound,
            ">" => number <= bound,
            "<=" => number > bound,
            _ => number >= bound,
        };
        if outside {
            return Err(limit_error(op, text, number_text(number)));
        }
    }
    Ok(())
}

/// Writes an f64 as JavaScript does, as Go and TypeScript errors show it: the shortest digits
/// that read back as the same f64, without an exponent from 1e-6 up to 1e21, and -0 kept.
fn number_text(number: f64) -> String {
    let text = format!("{number:e}");
    let (sign, text) = text.strip_prefix('-').map_or(("", text.as_str()), |rest| ("-", rest));
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let digits = mantissa.replace('.', "");
    // The number is 0.digits times 10 to the n.
    let n = exponent.parse::<i64>().unwrap_or(0) + 1;
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let zeros = |count: i64| "0".repeat(usize::try_from(count).unwrap_or(0));
    if k <= n && n <= 21 {
        return format!("{sign}{digits}{}", zeros(n - k));
    }
    if 0 < n && n <= 21 {
        let (head, tail) = digits.split_at(usize::try_from(n).unwrap_or(0));
        return format!("{sign}{head}.{tail}");
    }
    if -6 < n && n <= 0 {
        return format!("{sign}0.{}{digits}", zeros(-n));
    }
    let (first, rest) = digits.split_at(1);
    let point = if rest.is_empty() { String::new() } else { format!(".{rest}") };
    let exponent = n - 1;
    let exponent_sign = if exponent < 0 { '-' } else { '+' };
    format!("{sign}{first}{point}e{exponent_sign}{}", exponent.abs())
}
`,
  },
};
