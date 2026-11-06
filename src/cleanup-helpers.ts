/**
 * The cleanup step, as the helper code each language's output gets when `llm.cleanup` is on. It
 * fixes only the JSON syntax LLMs often get wrong, before an LLM decoder reads the text, and
 * nothing else. docs/llm.md spells out the algorithm, which all three run step by step the same
 * way, on the bytes of UTF-8 text (TypeScript on UTF-16 code units, which gives the same result,
 * since every character the steps look at or remove is ASCII, but the byte order mark):
 *
 * 1. Remove one byte order mark at the very start.
 * 2. Trim JSON white space (space, tab, line feed, carriage return) at both ends.
 * 3. Remove a code fence around the whole text: a first line of three backticks and an info
 *    string of only letters, digits and `_+.-` (like `json`), then spaces, tabs or a carriage
 *    return; and a last line of three backticks, after only spaces and tabs. Then trim again.
 *    Without both fence lines, the text stays as it is.
 * 4. Remove each comma that is outside a string and followed, after JSON white space only, by
 *    `}` or `]`.
 *
 * The templates are plain text with no escapes of their own, so no tool or editor can turn an
 * escape into the character it stands for.
 */

/** The TypeScript cleanup, appended to `helpers.ts` and re-exported from `index.ts`. */
export const TS_CLEANUP = `
/** True for JSON white space: space, tab, line feed and carriage return. */
function isJsonSpace(unit: number): boolean {
  return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d;
}

/** The range [start, end) of text without the JSON white space at both ends. */
function trimJsonSpace(text: string, start: number, end: number): [number, number] {
  while (start < end && isJsonSpace(text.charCodeAt(start))) start++;
  while (end > start && isJsonSpace(text.charCodeAt(end - 1))) end--;
  return [start, end];
}

/** True for a character a code fence's info string may hold: a letter, a digit or _+.- */
function isFenceInfo(unit: number): boolean {
  return (
    (unit >= 0x30 && unit <= 0x39) ||
    (unit >= 0x41 && unit <= 0x5a) ||
    (unit >= 0x61 && unit <= 0x7a) ||
    unit === 0x5f ||
    unit === 0x2b ||
    unit === 0x2e ||
    unit === 0x2d
  );
}

/**
 * The range inside the code fence around text[start, end), already trimmed, or undefined when
 * the text isn't fenced: the opening line is three backticks, an info string and then only
 * spaces, tabs or a carriage return, and the closing line is three backticks after only spaces
 * and tabs.
 */
function fenced(text: string, start: number, end: number): [number, number] | undefined {
  if (end - start < 3 || !text.startsWith("\`\`\`", start)) return undefined;
  const line = text.indexOf("\\n", start);
  if (line === -1 || line >= end) return undefined;
  let info = line;
  while (info > start + 3) {
    const unit = text.charCodeAt(info - 1);
    if (unit !== 0x20 && unit !== 0x09 && unit !== 0x0d) break;
    info--;
  }
  for (let i = start + 3; i < info; i++) if (!isFenceInfo(text.charCodeAt(i))) return undefined;
  if (end - 3 <= line || !text.startsWith("\`\`\`", end - 3)) return undefined;
  let close = end - 3;
  while (close > line + 1) {
    const unit = text.charCodeAt(close - 1);
    if (unit !== 0x20 && unit !== 0x09) break;
    close--;
  }
  if (close !== line + 1 && text.charCodeAt(close - 1) !== 0x0a) return undefined;
  return trimJsonSpace(text, line + 1, close);
}

/** Removes each comma outside a string that only JSON white space separates from } or ]. */
function dropTrailingCommas(text: string): string {
  let out = "";
  let from = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (inString) {
      if (unit === 0x5c) i++;
      else if (unit === 0x22) inString = false;
    } else if (unit === 0x22) {
      inString = true;
    } else if (unit === 0x2c) {
      let next = i + 1;
      while (next < text.length && isJsonSpace(text.charCodeAt(next))) next++;
      const after = text.charCodeAt(next);
      if (after === 0x7d || after === 0x5d) {
        out += text.slice(from, i);
        from = i + 1;
      }
    }
  }
  return out + text.slice(from);
}

/**
 * Fixes only the JSON syntax LLMs often get wrong, and nothing else: removes a byte order mark
 * at the start, JSON white space at both ends, a code fence around the whole text and each
 * trailing comma outside a string. It never renames a key, fills in a value or changes one.
 * Rust and Go run the same steps, which docs/llm.md spells out.
 */
export function cleanLlmJson(text: string): string {
  const [start, end] = trimJsonSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0, text.length);
  const [from, to] = fenced(text, start, end) ?? [start, end];
  return dropTrailingCommas(text.slice(from, to));
}
`;

/** The Go cleanup, appended to `helpers.go`. It uses only the bytes package, which helpers import. */
export const GO_CLEANUP = `
// isJSONSpace is true for JSON white space: space, tab, line feed and carriage return.
func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\\t' || b == '\\n' || b == '\\r'
}

// trimJSONSpace returns the range [start, end) of data without the JSON white space at both ends.
func trimJSONSpace(data []byte, start, end int) (int, int) {
	for start < end && isJSONSpace(data[start]) {
		start++
	}
	for end > start && isJSONSpace(data[end-1]) {
		end--
	}
	return start, end
}

// isFenceInfo is true for a byte a code fence's info string may hold: a letter, a digit or _+.-
func isFenceInfo(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') ||
		b == '_' || b == '+' || b == '.' || b == '-'
}

// fenced returns the range inside the code fence around data[start:end], already trimmed, and
// false when the text isn't fenced: the opening line is three backticks, an info string and then
// only spaces, tabs or a carriage return, and the closing line is three backticks after only
// spaces and tabs.
func fenced(data []byte, start, end int) (int, int, bool) {
	fence := []byte("\`\`\`")
	if !bytes.HasPrefix(data[start:end], fence) {
		return 0, 0, false
	}
	nl := bytes.IndexByte(data[start:end], '\\n')
	if nl == -1 {
		return 0, 0, false
	}
	line := start + nl
	info := line
	for info > start+3 && (data[info-1] == ' ' || data[info-1] == '\\t' || data[info-1] == '\\r') {
		info--
	}
	for _, b := range data[start+3 : info] {
		if !isFenceInfo(b) {
			return 0, 0, false
		}
	}
	if end-3 <= line || !bytes.Equal(data[end-3:end], fence) {
		return 0, 0, false
	}
	closing := end - 3
	for closing > line+1 && (data[closing-1] == ' ' || data[closing-1] == '\\t') {
		closing--
	}
	if closing != line+1 && data[closing-1] != '\\n' {
		return 0, 0, false
	}
	from, to := trimJSONSpace(data, line+1, closing)
	return from, to, true
}

// dropTrailingCommas returns data without each comma outside a string that only JSON white space
// separates from } or ].
func dropTrailingCommas(data []byte) []byte {
	out := make([]byte, 0, len(data))
	from := 0
	inString := false
	for i := 0; i < len(data); i++ {
		b := data[i]
		switch {
		case inString && b == '\\\\':
			i++
		case inString && b == '"':
			inString = false
		case inString:
		case b == '"':
			inString = true
		case b == ',':
			next := i + 1
			for next < len(data) && isJSONSpace(data[next]) {
				next++
			}
			if next < len(data) && (data[next] == '}' || data[next] == ']') {
				out = append(out, data[from:i]...)
				from = i + 1
			}
		}
	}
	return append(out, data[from:]...)
}

// CleanLLMJSON fixes only the JSON syntax LLMs often get wrong, and nothing else: it removes a
// byte order mark at the start, JSON white space at both ends, a code fence around the whole text
// and each trailing comma outside a string. It never renames a key, fills in a value or changes
// one. Rust and TypeScript run the same steps, which docs/llm.md spells out. It returns a new
// slice and leaves data as it is.
func CleanLLMJSON(data []byte) []byte {
	start := 0
	if bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}) {
		start = 3
	}
	start, end := trimJSONSpace(data, start, len(data))
	if from, to, ok := fenced(data, start, end); ok {
		start, end = from, to
	}
	return dropTrailingCommas(data[start:end])
}
`;

/** The Rust cleanup, appended to the helpers module and re-exported from `mod.rs`. */
export const RUST_CLEANUP = `/// True for JSON white space: space, tab, line feed and carriage return.
fn is_json_space(b: u8) -> bool {
    matches!(b, b' ' | b'\\t' | b'\\n' | b'\\r')
}

/// The range \`[start, end)\` of \`bytes\` without the JSON white space at both ends.
fn trim_json_space(bytes: &[u8], mut start: usize, mut end: usize) -> (usize, usize) {
    while start < end && is_json_space(bytes[start]) {
        start += 1;
    }
    while end > start && is_json_space(bytes[end - 1]) {
        end -= 1;
    }
    (start, end)
}

/// The range inside the code fence around \`bytes[start..end]\`, already trimmed, or \`None\` when
/// the text isn't fenced: the opening line is three backticks, an info string of letters, digits
/// and \`_+.-\` and then only spaces, tabs or a carriage return, and the closing line is three
/// backticks after only spaces and tabs.
fn fenced(bytes: &[u8], start: usize, end: usize) -> Option<(usize, usize)> {
    const FENCE: &[u8] = b"\`\`\`";
    if !bytes[start..end].starts_with(FENCE) {
        return None;
    }
    let line = start + bytes[start..end].iter().position(|&b| b == b'\\n')?;
    let mut info = line;
    while info > start + 3 && matches!(bytes[info - 1], b' ' | b'\\t' | b'\\r') {
        info -= 1;
    }
    let plain = |b: &u8| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'.' | b'-');
    if !bytes[start + 3..info].iter().all(plain) {
        return None;
    }
    if end - 3 <= line || &bytes[end - 3..end] != FENCE {
        return None;
    }
    let mut close = end - 3;
    while close > line + 1 && matches!(bytes[close - 1], b' ' | b'\\t') {
        close -= 1;
    }
    if close != line + 1 && bytes[close - 1] != b'\\n' {
        return None;
    }
    Some(trim_json_space(bytes, line + 1, close))
}

/// \`text\` without each comma outside a string that only JSON white space separates from \`}\` or
/// \`]\`.
fn drop_trailing_commas(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_string {
            if b == b'\\\\' {
                i += 1;
            } else if b == b'"' {
                in_string = false;
            }
        } else if b == b'"' {
            in_string = true;
        } else if b == b',' {
            let mut next = i + 1;
            while next < bytes.len() && is_json_space(bytes[next]) {
                next += 1;
            }
            if next < bytes.len() && matches!(bytes[next], b'}' | b']') {
                out.push_str(&text[from..i]);
                from = i + 1;
            }
        }
        i += 1;
    }
    out.push_str(&text[from..]);
    out
}

/// Fixes only the JSON syntax LLMs often get wrong, and nothing else: removes a byte order mark
/// at the start, JSON white space at both ends, a code fence around the whole text and each
/// trailing comma outside a string. It never renames a key, fills in a value or changes one. Go
/// and TypeScript run the same steps, which \`docs/llm.md\` spells out.
#[must_use]
pub fn clean_llm_json(text: &str) -> String {
    let bytes = text.as_bytes();
    let first = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) { 3 } else { 0 };
    let (start, end) = trim_json_space(bytes, first, bytes.len());
    let (from, to) = fenced(bytes, start, end).unwrap_or((start, end));
    drop_trailing_commas(&text[from..to])
}
`;
