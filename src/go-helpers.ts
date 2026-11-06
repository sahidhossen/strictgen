import { codeName, COUNT_UNITS, ERROR_CODES, FOUND_MAX, MAX_DEPTH } from "./errors.js";

/** The name of the built in type for any JSON value except `null`. */
export const GO_NON_NULL = "NonNullJson";

/** The error code constants the helpers file declares, like `CodeUnknownKey`. */
export const GO_CODES = ERROR_CODES.map((c) => `Code${codeName(c.code, true)}`);

/** The Code constants, one per code, with their doc comments. */
const CODE_CONSTANTS = ERROR_CODES.map(
  (c, i) => `\t// ${GO_CODES[i] ?? ""} is ${c.doc}.\n\t${GO_CODES[i] ?? ""} = "${c.code}"\n`,
).join("");

/** The title of each code in messages. */
const CODE_TITLES = ERROR_CODES.map((c, i) => `\t${GO_CODES[i] ?? ""}: "${c.title}",\n`).join("");

/** In report mode, every node holds its offset and the document it belongs to. */
const NODE_FIELDS_REPORT = String.raw`
	at     int              // the byte offset of the value in the input
	doc    *document        // what the decode of this input shares`;

/** In report mode, a node the parser makes notes its offset and document. */
const AT = ", at: start, doc: p.doc";

/** What report mode adds: the document, Reported, Report, the hook, and input order. */
const REPORT_SECTION = String.raw`
// document is what one decode of a parsed input shares: the offsets of the unknown keys it
// accepted so far, in decode order.
type document struct {
	unknown []int
}

// Reported is a decoded value and the paths of the unknown keys its input had.
type Reported[T any] struct {
	// Value is the decoded value, which leaves the unknown keys out.
	Value T
	// Unknown holds the JSON Pointer of each unknown key, like /customer/nickname, in the
	// order the keys appear in the input. It is empty when there are none.
	Unknown []string
}

// Report decodes data as T, like json.Unmarshal into a T, and returns the value with the
// paths of its unknown keys. A tagged union has its own Report function instead.
func Report[T any, PT interface {
	*T
	nodeDecoder
}](data []byte) (Reported[T], error) {
	return decodeReport(data, decodeType[T, PT])
}

// unknownKeyHook holds the hook SetUnknownKeyHook set.
var unknownKeyHook atomic.Pointer[func(paths []string)]

// SetUnknownKeyHook sets the one hook every decode calls with the paths of the unknown keys it
// accepted, for logging or counting them in one place. A decode calls it after the value
// decoded, only when there is at least one unknown key, and before it returns. nil removes it.
// It is safe to call while other goroutines decode.
func SetUnknownKeyHook(hook func(paths []string)) {
	if hook == nil {
		unknownKeyHook.Store(nil)
		return
	}
	unknownKeyHook.Store(&hook)
}

// decodeReport parses data once, decodes it with decode, calls the hook and returns the value
// with the paths of its unknown keys.
func decodeReport[T any](data []byte, decode func(*node) (T, *DecodeError)) (Reported[T], error) {
	n, err := parse(data)
	if err != nil {
		return Reported[T]{}, err
	}
	v, err := decode(n)
	if err == nil {
		err = checkValue(v)
	}
	if err != nil {
		return Reported[T]{}, err
	}
	paths := n.unknownPaths()
	if hook := unknownKeyHook.Load(); hook != nil && len(paths) > 0 {
		(*hook)(slices.Clone(paths))
	}
	return Reported[T]{Value: v, Unknown: paths}, nil
}

// unknownPaths returns the paths of the unknown keys noted under the root n, in input order,
// which is the order of their offsets.
func (n *node) unknownPaths() []string {
	offsets := slices.Clone(n.doc.unknown)
	slices.Sort(offsets)
	paths := make([]string, 0, len(offsets))
	for _, at := range offsets {
		paths = append(paths, n.pathTo(at))
	}
	return paths
}

// pathTo returns the JSON Pointer, under n, of the value that starts at the byte offset at.
// The children of a node are in input order, so the last one that starts at or before the
// offset holds it.
func (n *node) pathTo(at int) string {
	var path strings.Builder
	for n.at != at {
		count := len(n.items)
		if n.kind == '{' {
			count = len(n.keys)
		}
		child := func(i int) *node {
			if n.kind == '{' {
				return n.fields[n.keys[i]]
			}
			return n.items[i]
		}
		lo, hi := 0, count
		for lo < hi {
			mid := (lo + hi) / 2
			if child(mid).at <= at {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo == 0 {
			break
		}
		if n.kind == '{' {
			path.WriteString(pointer(n.keys[lo-1]))
		} else {
			path.WriteString(pointer(strconv.Itoa(lo - 1)))
		}
		n = child(lo - 1)
	}
	return path.String()
}
`;

/** unmarshal and decodeRoot in strict mode. */
const ROOT_STRICT = String.raw`// unmarshal parses data once and decodes it into v, for UnmarshalJSON, then checks the
// constraints of the whole value.
func unmarshal[T any, PT interface {
	*T
	nodeDecoder
}](data []byte, v PT) error {
	n, err := parse(data)
	if err == nil {
		err = v.decode(n)
	}
	if err == nil {
		err = checkValue(v)
	}
	if err != nil {
		return err
	}
	return nil
}

// decodeRoot parses data once and decodes it with decode, then checks the constraints of the
// whole value.
func decodeRoot[T any](data []byte, decode func(*node) (T, *DecodeError)) (T, error) {
	var v T
	n, err := parse(data)
	if err == nil {
		v, err = decode(n)
	}
	if err == nil {
		err = checkValue(v)
	}
	if err != nil {
		var zero T
		return zero, err
	}
	return v, nil
}`;

/** unmarshal and decodeRoot in report mode, which give the unknown keys to the hook. */
const ROOT_REPORT = String.raw`// unmarshal parses data once and decodes it into v, for UnmarshalJSON, then checks the
// constraints of the whole value. The paths of the unknown keys go to the hook.
func unmarshal[T any, PT interface {
	*T
	nodeDecoder
}](data []byte, v PT) error {
	_, err := decodeReport(data, func(n *node) (struct{}, *DecodeError) {
		if err := v.decode(n); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, checkValue(v)
	})
	return err
}

// decodeRoot parses data once and decodes it with decode, then checks the constraints of the
// whole value. The paths of the unknown keys go to the hook.
func decodeRoot[T any](data []byte, decode func(*node) (T, *DecodeError)) (T, error) {
	r, err := decodeReport(data, decode)
	return r.Value, err
}`;

/** decodeObject in strict mode: a key fill didn't read fails. */
const OBJECT_STRICT = String.raw`// decodeObject decodes a JSON object strictly: fill reads its keys, any key fill didn't read
// fails at its own path, and commit stores the result only when everything decoded.
func decodeObject(n *node, fill func(*objectDecoder), commit func()) *DecodeError {
	if err := expect(n, '{'); err != nil {
		return err
	}
	d := &objectDecoder{n: n, used: make(map[string]bool, len(n.keys))}
	fill(d)
	if d.err != nil {
		return d.err
	}
	for _, key := range n.keys {
		if !d.used[key] {
			return fail(CodeUnknownKey, "", "").at(key)
		}
	}
	commit()
	return nil
}`;

/** decodeObject in report mode: a key fill didn't read is noted, unless forbidden names it. */
const OBJECT_REPORT = String.raw`// decodeObject decodes a JSON object: fill reads its keys, and commit stores the result only
// when everything decoded. A key fill didn't read is unknown and noted for the decode that
// runs, in input order. A key in forbidden, which a sibling branch of an exactly-one union
// names, still fails with CodeUnknownKey at its own path.
func decodeObject(n *node, fill func(*objectDecoder), commit func(), forbidden ...string) *DecodeError {
	if err := expect(n, '{'); err != nil {
		return err
	}
	d := &objectDecoder{n: n, used: make(map[string]bool, len(n.keys))}
	fill(d)
	if d.err != nil {
		return d.err
	}
	for _, key := range n.keys {
		if d.used[key] {
			continue
		}
		if n.doc == nil || slices.Contains(forbidden, key) {
			return fail(CodeUnknownKey, "", "").at(key)
		}
		n.doc.unknown = append(n.doc.unknown, n.fields[key].at)
	}
	commit()
	return nil
}`;

/** decodeUntagged in strict mode. */
const UNTAGGED_STRICT = String.raw`// decodeUntagged tries each variant in order and commits the first one that decodes. When
// none does, it fails with CodeWrongType, or CodeNullNotAllowed for null, naming the union.
func decodeUntagged(n *node, name string, commit func(), variants ...func(*node) bool) *DecodeError {
	for _, variant := range variants {
		if variant(n) {
			commit()
			return nil
		}
	}
	return mismatch(name, n)
}`;

/** decodeUntagged in report mode, which drops the unknown keys of a variant that failed. */
const UNTAGGED_REPORT = String.raw`// decodeUntagged tries each variant in order and commits the first one that decodes. The
// unknown keys of a variant that failed are dropped, so only the variant used reports its own.
// When none decodes, it fails with CodeWrongType, or CodeNullNotAllowed for null, naming the
// union.
func decodeUntagged(n *node, name string, commit func(), variants ...func(*node) bool) *DecodeError {
	for _, variant := range variants {
		mark := 0
		if n.doc != nil {
			mark = len(n.doc.unknown)
		}
		if variant(n) {
			commit()
			return nil
		}
		if n.doc != nil {
			n.doc.unknown = n.doc.unknown[:mark]
		}
	}
	return mismatch(name, n)
}`;

/**
 * The body of the generated `helpers.go`. It is a raw template, so backslashes stand for
 * themselves. `report` adds what report mode needs.
 */
export function goHelpersBody(report: boolean): string {
  return String.raw`// maxDepth is serde_json's recursion limit: a value nested in ${String(MAX_DEPTH)} or more arrays and objects
// fails, so Go and Rust accept the same documents and decoding stays bounded.
const maxDepth = ${String(MAX_DEPTH)}

// foundMax is the number of code points of a string an error shows, before "...".
const foundMax = ${String(FOUND_MAX)}

// The error codes, in DecodeError.Code. Codes are public API: changing one is a major version.
const (
${CODE_CONSTANTS})

// codeTitles holds the words for each code in a message.
var codeTitles = map[string]string{
${CODE_TITLES}}

// DecodeError is a value that doesn't fit its generated type, or input that isn't JSON. Rust
// and TypeScript report the same Path, Code, Expected and Found for the same input, and the
// same message.
type DecodeError struct {
	// Path is a JSON Pointer to the value that failed, like /items/0/price, empty for the
	// whole input.
	Path string
	// Code says what failed, like CodeMissingKey.
	Code string
	// Expected is what the type takes there, like "a string", empty when the code has none.
	Expected string
	// Found is what the input has there, like 12.5 or "x", empty when the code has none.
	Found string
}

// describe builds a message: the path, then head, then expected and found when they are set.
func describe(path, head, gap, expected, found string) string {
	text := head
	if path != "" {
		text = path + gap + head
	}
	if expected != "" {
		text += ", expected " + expected
	}
	if found != "" {
		text += ", found " + found
	}
	return text
}

// Error returns the message, like /items/0: wrong type, expected a string, found 1.
func (e *DecodeError) Error() string {
	return describe(e.Path, codeTitles[e.Code], ": ", e.Expected, e.Found)
}

// Compact returns the one-line form, made for logs and for asking an LLM to retry, like
// /items/0 wrong_type, expected a string, found 1.
func (e *DecodeError) Compact() string {
	return describe(e.Path, e.Code, " ", e.Expected, e.Found)
}

// fail returns a DecodeError at the current value.
func fail(code, expected, found string) *DecodeError {
	return &DecodeError{Code: code, Expected: expected, Found: found}
}

// at moves the error one level down, under an object key or array index.
func (e *DecodeError) at(segment string) *DecodeError {
	return &DecodeError{Path: pointer(segment) + e.Path, Code: e.Code, Expected: e.Expected, Found: e.Found}
}

// pointer returns segment as a JSON Pointer segment, with its slash.
func pointer(segment string) string {
	return "/" + strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
}

// quote shows a string as errors do in every language: in double quotes, with " and \ escaped
// by a backslash and control characters (U+0000 to U+001F, U+007F to U+009F), U+2028 and
// U+2029 as \u and four hex digits. A string of more than foundMax code points shows its first
// foundMax, then ... after the quote.
func quote(text string) string {
	var out strings.Builder
	out.WriteByte('"')
	count := 0
	for _, r := range text {
		if count == foundMax {
			out.WriteString("\"...")
			return out.String()
		}
		count++
		switch {
		case r == '"' || r == '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case r < 0x20 || (r >= 0x7f && r <= 0x9f) || r == 0x2028 || r == 0x2029:
			fmt.Fprintf(&out, "\\u%04x", r)
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
}

// node is one parsed JSON value. Input is parsed once, then decoders walk the nodes, so
// decoding is linear in the input size.
type node struct {
	kind   byte             // '{', '[', '"', 'n', 't', 'f' or '0' for a number
	raw    []byte           // the value as spelled in the input
	text   string           // the value of a string
	keys   []string         // the keys of an object in input order, each once
	fields map[string]*node // the members of an object; a key given twice fails to parse
	items  []*node          // the items of an array${report ? NODE_FIELDS_REPORT : ""}
}

// foundOf shows a value as errors do: null, true and false, a number as spelled, a string
// quoted, "an array" and "an object".
func foundOf(n *node) string {
	switch n.kind {
	case '{':
		return "an object"
	case '[':
		return "an array"
	case '"':
		return quote(n.text)
	case 'n':
		return "null"
	case 't':
		return "true"
	case 'f':
		return "false"
	default:
		return string(n.raw)
	}
}

// mismatch is the error for a value that is not what expected names: CodeNullNotAllowed for
// null, else CodeWrongType.
func mismatch(expected string, n *node) *DecodeError {
	if n.kind == 'n' {
		return fail(CodeNullNotAllowed, expected, "")
	}
	return fail(CodeWrongType, expected, foundOf(n))
}

// expect fails unless the node is of the given kind.
func expect(n *node, kind byte) *DecodeError {
	if n.kind == kind || (kind == 't' && n.kind == 'f') {
		return nil
	}
	switch kind {
	case '{':
		return mismatch("an object", n)
	case '[':
		return mismatch("an array", n)
	case '"':
		return mismatch("a string", n)
	case 't':
		return mismatch("a boolean", n)
	default:
		return mismatch("a number", n)
	}
}

// parser reads JSON like serde_json: strict grammar, valid UTF-8, no lone surrogates,
// finite numbers and at most maxDepth - 1 nested arrays and objects.
type parser struct {
	data []byte
	pos  int
	// path holds the keys and indexes of the values being read, for the path of a failure.
	path []string${report ? "\n\t// doc is shared by every node of the input.\n\tdoc *document" : ""}
}

// parse parses a whole JSON document. Every failure carries its error code and the JSON
// Pointer of the value being read, and Found gives the byte offset.
func parse(data []byte) (*node, *DecodeError) {
	p := &parser{data: data${report ? ", doc: &document{}" : ""}}
	if !utf8.Valid(data) {
		return nil, p.failAt(invalidUTF8At(data), "invalid UTF-8")
	}
	n, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.space()
	if p.pos != len(p.data) {
		return nil, p.fail("trailing characters")
	}
	return n, nil
}

// invalidUTF8At returns the offset of the first byte that isn't valid UTF-8.
func invalidUTF8At(data []byte) int {
	at := 0
	for at < len(data) {
		r, size := utf8.DecodeRune(data[at:])
		if r == utf8.RuneError && size == 1 {
			break
		}
		at += size
	}
	return at
}

// pointer returns the JSON Pointer of the value being read.
func (p *parser) pointer() string {
	var path strings.Builder
	for _, segment := range p.path {
		path.WriteString(pointer(segment))
	}
	return path.String()
}

// failAt returns a CodeInvalidJSON failure, what was found at a byte offset.
func (p *parser) failAt(offset int, what string) *DecodeError {
	return &DecodeError{Path: p.pointer(), Code: CodeInvalidJSON, Found: fmt.Sprintf("%s at offset %d", what, offset)}
}

func (p *parser) fail(what string) *DecodeError {
	return p.failAt(p.pos, what)
}

func (p *parser) space() {
	for p.pos < len(p.data) && strings.IndexByte(" \t\n\r", p.data[p.pos]) >= 0 {
		p.pos++
	}
}

// accept consumes c if it comes next.
func (p *parser) accept(c byte) bool {
	if p.pos < len(p.data) && p.data[p.pos] == c {
		p.pos++
		return true
	}
	return false
}

// value parses one value inside depth arrays and objects.
func (p *parser) value(depth int) (*node, *DecodeError) {
	p.space()
	if p.pos >= len(p.data) {
		return nil, p.fail("an unexpected end of input")
	}
	start := p.pos
	switch c := p.data[p.pos]; c {
	case '{', '[':
		if depth+1 >= maxDepth {
			return nil, &DecodeError{
				Path:     p.pointer(),
				Code:     CodeTooDeep,
				Expected: fmt.Sprintf("at most %d nested arrays and objects", maxDepth-1),
				Found:    fmt.Sprintf("more at offset %d", p.pos),
			}
		}
		if c == '{' {
			return p.object(start, depth+1)
		}
		return p.array(start, depth+1)
	case '"':
		text, err := p.str()
		if err != nil {
			return nil, err
		}
		return &node{kind: '"', raw: p.data[start:p.pos], text: text${report ? AT : ""}}, nil
	case 't':
		return p.literal(start, "true", 't')
	case 'f':
		return p.literal(start, "false", 'f')
	case 'n':
		return p.literal(start, "null", 'n')
	default:
		return p.number(start)
	}
}

// literal reads true, false or null, failing at the first byte that differs, like serde_json.
func (p *parser) literal(start int, word string, kind byte) (*node, *DecodeError) {
	for i := 0; i < len(word); i++ {
		if p.pos >= len(p.data) || p.data[p.pos] != word[i] {
			return nil, p.fail("an invalid literal")
		}
		p.pos++
	}
	return &node{kind: kind, raw: p.data[start:p.pos]${report ? AT : ""}}, nil
}

func (p *parser) object(start, depth int) (*node, *DecodeError) {
	n := &node{kind: '{', fields: map[string]*node{}${report ? AT : ""}}
	p.pos++
	p.space()
	if p.accept('}') {
		n.raw = p.data[start:p.pos]
		return n, nil
	}
	for {
		p.space()
		if p.pos >= len(p.data) || p.data[p.pos] != '"' {
			return nil, p.fail("a missing key")
		}
		keyAt := p.pos
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		if _, seen := n.fields[key]; seen {
			return nil, &DecodeError{
				Path:  p.pointer() + pointer(key),
				Code:  CodeDuplicateKey,
				Found: fmt.Sprintf("%s at offset %d", quote(key), keyAt),
			}
		}
		p.space()
		if !p.accept(':') {
			return nil, p.fail("a missing colon")
		}
		p.path = append(p.path, key)
		value, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		p.path = p.path[:len(p.path)-1]
		n.keys = append(n.keys, key)
		n.fields[key] = value
		p.space()
		if p.accept('}') {
			n.raw = p.data[start:p.pos]
			return n, nil
		}
		if !p.accept(',') {
			return nil, p.fail("a missing comma or closing brace")
		}
	}
}

func (p *parser) array(start, depth int) (*node, *DecodeError) {
	n := &node{kind: '['${report ? AT : ""}}
	p.pos++
	p.space()
	if p.accept(']') {
		n.raw = p.data[start:p.pos]
		return n, nil
	}
	for {
		p.path = append(p.path, strconv.Itoa(len(n.items)))
		item, err := p.value(depth)
		if err != nil {
			return nil, err
		}
		p.path = p.path[:len(p.path)-1]
		n.items = append(n.items, item)
		p.space()
		if p.accept(']') {
			n.raw = p.data[start:p.pos]
			return n, nil
		}
		if !p.accept(',') {
			return nil, p.fail("a missing comma or closing bracket")
		}
	}
}

// str parses a string, rejecting invalid UTF-8, control characters and lone surrogates.
func (p *parser) str() (string, *DecodeError) {
	start := p.pos
	p.pos++
	escaped := false
	for {
		if p.pos >= len(p.data) {
			return "", p.fail("an unterminated string")
		}
		switch c := p.data[p.pos]; {
		case c == '"':
			p.pos++
			raw := p.data[start:p.pos]
			if !escaped {
				return string(raw[1 : len(raw)-1]), nil
			}
			// The escapes were checked as they were read, so unescaping can't fail.
			var text string
			_ = json.Unmarshal(raw, &text)
			return text, nil
		case c == '\\':
			escaped = true
			if err := p.escape(); err != nil {
				return "", err
			}
		case c < 0x20:
			return "", p.fail("a control character in a string")
		default:
			p.pos++
		}
	}
}

// escape reads one escape sequence at the backslash. A \u escape of a high surrogate must be
// followed by one of a low surrogate, and a low surrogate can't stand alone. A bad escape or hex
// digit fails at that byte, and a surrogate that isn't half of a pair fails at the backslash.
func (p *parser) escape() *DecodeError {
	start := p.pos
	p.pos++
	if p.pos < len(p.data) && strings.IndexByte("\"\\/bfnrt", p.data[p.pos]) >= 0 {
		p.pos++
		return nil
	}
	if p.pos >= len(p.data) || p.data[p.pos] != 'u' {
		return p.fail("an invalid escape")
	}
	p.pos++
	unit, err := p.hex4()
	if err != nil {
		return err
	}
	if unit >= 0xDC00 && unit <= 0xDFFF {
		return p.failAt(start, "a lone surrogate")
	}
	if unit >= 0xD800 && unit <= 0xDBFF {
		if p.pos+1 >= len(p.data) || p.data[p.pos] != '\\' || p.data[p.pos+1] != 'u' {
			return p.failAt(start, "a lone surrogate")
		}
		p.pos += 2
		low, err := p.hex4()
		if err != nil {
			return err
		}
		if low < 0xDC00 || low > 0xDFFF {
			return p.failAt(start, "a lone surrogate")
		}
	}
	return nil
}

// hex4 reads the four hex digits of a \u escape, failing at the first that isn't one.
func (p *parser) hex4() (int, *DecodeError) {
	unit := 0
	for range 4 {
		if p.pos >= len(p.data) {
			return 0, p.fail("an invalid escape")
		}
		digit := strings.IndexByte("0123456789abcdefABCDEF", p.data[p.pos])
		if digit > 15 {
			digit -= 6
		}
		if digit < 0 {
			return 0, p.fail("an invalid escape")
		}
		unit = unit*16 + digit
		p.pos++
	}
	return unit, nil
}

// digits consumes digits and returns how many.
func (p *parser) digits() int {
	start := p.pos
	for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
		p.pos++
	}
	return p.pos - start
}

// number parses a number in JSON's grammar that is finite as a float64, like serde_json.
func (p *parser) number(start int) (*node, *DecodeError) {
	p.accept('-')
	if p.accept('0') {
		if p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			return nil, p.fail("a leading zero")
		}
	} else if p.digits() == 0 {
		return nil, p.fail("an invalid value")
	}
	if p.accept('.') && p.digits() == 0 {
		return nil, p.fail("an invalid number")
	}
	if p.accept('e') || p.accept('E') {
		if !p.accept('+') {
			p.accept('-')
		}
		if p.digits() == 0 {
			return nil, p.fail("an invalid number")
		}
	}
	raw := p.data[start:p.pos]
	if _, err := strconv.ParseFloat(string(raw), 64); err != nil {
		return nil, p.failAt(start, "a number out of range")
	}
	return &node{kind: '0', raw: raw${report ? AT : ""}}, nil
}

// nodeDecoder is a generated type that decodes itself from a parsed node.
type nodeDecoder interface {
	decode(n *node) *DecodeError
}

${report ? `${ROOT_REPORT}\n${REPORT_SECTION.trimEnd()}` : ROOT_STRICT}

// decodeType decodes a generated type, which checks its own shape.
func decodeType[T any, PT interface {
	*T
	nodeDecoder
}](n *node) (T, *DecodeError) {
	var v T
	err := PT(&v).decode(n)
	return v, err
}

// decodeString decodes a JSON string.
func decodeString(n *node) (string, *DecodeError) {
	return n.text, expect(n, '"')
}

// decodeInt decodes a JSON integer that fits an int64. A fraction like 1.5, a spelling like
// 1.0 or 1e2, and -0, which serde_json reads as a float, fail with CodeWrongType. An integer
// past the int64 range fails with CodeOutOfRangeInteger.
func decodeInt(n *node) (int64, *DecodeError) {
	if n.kind != '0' {
		return 0, mismatch("an integer", n)
	}
	raw := string(n.raw)
	if strings.ContainsAny(raw, ".eE") || raw == "-0" {
		return 0, fail(CodeWrongType, "an integer", raw)
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fail(CodeOutOfRangeInteger, "an integer from -9223372036854775808 to 9223372036854775807", raw)
	}
	return v, nil
}

// decodeNumber decodes a finite JSON number as spelled, so 12 re-encodes as 12. Spellings
// Rust writes differently, like 1E2 or 1.50, are kept as they are.
func decodeNumber(n *node) (json.Number, *DecodeError) {
	return json.Number(n.raw), expect(n, '0')
}

// decodeBool decodes a JSON boolean.
func decodeBool(n *node) (bool, *DecodeError) {
	return n.kind == 't', expect(n, 't')
}

// decodeAny keeps any JSON value, null included.
func decodeAny(n *node) (json.RawMessage, *DecodeError) {
	return json.RawMessage(bytes.Clone(n.raw)), nil
}

// boxed returns decode with its result behind a pointer.
func boxed[T any](decode func(*node) (T, *DecodeError)) func(*node) (*T, *DecodeError) {
	return func(n *node) (*T, *DecodeError) {
		v, err := decode(n)
		if err != nil {
			return nil, err
		}
		return &v, nil
	}
}

// decodeSlice returns a decoder of a JSON array whose items decode with item.
func decodeSlice[T any](item func(*node) (T, *DecodeError)) func(*node) ([]T, *DecodeError) {
	return func(n *node) ([]T, *DecodeError) {
		if err := expect(n, '['); err != nil {
			return nil, err
		}
		out := make([]T, 0, len(n.items))
		for i, raw := range n.items {
			v, err := item(raw)
			if err != nil {
				return nil, err.at(strconv.Itoa(i))
			}
			out = append(out, v)
		}
		return out, nil
	}
}

// decodeMap returns a decoder of a JSON object whose keys decode with key and values with value.
func decodeMap[K comparable, V any](
	key func(*node) (K, *DecodeError),
	value func(*node) (V, *DecodeError),
) func(*node) (map[K]V, *DecodeError) {
	return func(n *node) (map[K]V, *DecodeError) {
		if err := expect(n, '{'); err != nil {
			return nil, err
		}
		out := make(map[K]V, len(n.keys))
		for _, name := range n.keys {
			k, v, err := entry(key, value, name, n.fields[name])
			if err != nil {
				return nil, err
			}
			out[k] = v
		}
		return out, nil
	}
}

// entry decodes one member of a map, its key as a JSON string. A key that fails fails at its
// own path, like the value under it.
func entry[K, V any](
	key func(*node) (K, *DecodeError),
	value func(*node) (V, *DecodeError),
	name string,
	n *node,
) (K, V, *DecodeError) {
	k, err := key(&node{kind: '"', text: name})
	if err != nil {
		var v V
		return k, v, err.at(name)
	}
	v, err := value(n)
	if err != nil {
		return k, v, err.at(name)
	}
	return k, v, nil
}

// objectDecoder reads the keys of a JSON object into a struct and tracks the keys it read.
type objectDecoder struct {
	n    *node
	used map[string]bool
	err  *DecodeError
}

${report ? OBJECT_REPORT : OBJECT_STRICT}

// required reads a key that must be present. A missing key fails at its own path.
func required[T any](d *objectDecoder, key string, dst *T, decode func(*node) (T, *DecodeError)) {
	if d.err != nil {
		return
	}
	if _, ok := d.n.fields[key]; !ok {
		d.err = fail(CodeMissingKey, "", "").at(key)
		return
	}
	optionalValue(d, key, dst, decode)
}

// optional reads an optional key into a pointer, which stays nil when the key is absent.
// An explicit null fails, since only decodeAny accepts it.
func optional[T any](d *objectDecoder, key string, dst **T, decode func(*node) (T, *DecodeError)) {
	optionalValue(d, key, dst, boxed(decode))
}

// optionalValue reads an optional key into a value whose zero value means absent, like an
// interface or a json.RawMessage.
func optionalValue[T any](d *objectDecoder, key string, dst *T, decode func(*node) (T, *DecodeError)) {
	if d.err != nil {
		return
	}
	d.used[key] = true
	n, ok := d.n.fields[key]
	if !ok {
		return
	}
	v, err := decode(n)
	if err != nil {
		d.err = err.at(key)
		return
	}
	*dst = v
}

// rest reads every key not read yet into a map, for a struct with named keys and a map of the others.
func rest[K comparable, V any](
	d *objectDecoder,
	dst *map[K]V,
	key func(*node) (K, *DecodeError),
	value func(*node) (V, *DecodeError),
) {
	if d.err != nil {
		return
	}
	out := make(map[K]V)
	for _, name := range d.n.keys {
		if d.used[name] {
			continue
		}
		d.used[name] = true
		k, v, err := entry(key, value, name, d.n.fields[name])
		if err != nil {
			d.err = err
			return
		}
		out[k] = v
	}
	*dst = out
}

// checkRequired fails when one of the named required fields is nil.
func checkRequired(names []string, set []bool) error {
	for i, ok := range set {
		if !ok {
			return fmt.Errorf("required key %q is nil, which would encode as null", names[i])
		}
	}
	return nil
}

// encodeRequired encodes a struct after checking its required slices, maps, unions and pointers.
func encodeRequired(plain any, names []string, set ...bool) ([]byte, error) {
	if err := checkRequired(names, set); err != nil {
		return nil, err
	}
	data, err := json.Marshal(plain)
	if err != nil {
		return nil, fmt.Errorf("encoding: %w", err)
	}
	return data, nil
}

// checkKey fails when k is an enum value its type doesn't list. encoding/json writes a map key
// of a string type without its MarshalText, so the encoders check keys first.
func checkKey[K ~string](k K) error {
	if m, ok := any(k).(encoding.TextMarshaler); ok {
		if _, err := m.MarshalText(); err != nil {
			return fmt.Errorf("key %q: %w", string(k), err)
		}
	}
	return nil
}

// firstError returns the first error that is not nil.
func firstError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// mapKeys returns a check of the keys of a map, in sorted order, and of its values with inner
// when it is not nil.
func mapKeys[K ~string, V any](inner func(V) error) func(map[K]V) error {
	return func(m map[K]V) error {
		for _, k := range slices.Sorted(maps.Keys(m)) {
			if err := checkKey(k); err != nil {
				return err
			}
			if inner != nil {
				if err := inner(m[k]); err != nil {
					return err
				}
			}
		}
		return nil
	}
}

// sliceKeys returns a check of the map keys inside each item of a slice.
func sliceKeys[T any](inner func(T) error) func([]T) error {
	return func(items []T) error {
		for _, item := range items {
			if err := inner(item); err != nil {
				return err
			}
		}
		return nil
	}
}

// ptrKeys returns a check of the map keys inside the value of a pointer, when it is not nil.
func ptrKeys[T any](inner func(T) error) func(*T) error {
	return func(p *T) error {
		if p == nil {
			return nil
		}
		return inner(*p)
	}
}

// encodeWithRest encodes the named keys of a struct, then the keys of rest sorted, as one
// object, the order Rust writes. It fails when rest holds one of the named keys, so no key
// is written twice, a key its enum type doesn't list, or when a required field is nil.
func encodeWithRest[K ~string, V any](named any, rest map[K]V, keys, names []string, set ...bool) ([]byte, error) {
	if err := checkRequired(names, set); err != nil {
		return nil, err
	}
	data, err := json.Marshal(named)
	if err != nil {
		return nil, fmt.Errorf("encoding named keys: %w", err)
	}
	var out bytes.Buffer
	out.Write(data[:len(data)-1])
	first := len(data) == 2
	for _, key := range slices.Sorted(maps.Keys(rest)) {
		if slices.Contains(keys, string(key)) {
			return nil, fmt.Errorf("rest holds the named key %q", string(key))
		}
		if err := checkKey(key); err != nil {
			return nil, err
		}
		member, err := json.Marshal(map[K]V{key: rest[key]})
		if err != nil {
			return nil, fmt.Errorf("encoding key %q: %w", string(key), err)
		}
		if !first {
			out.WriteByte(',')
		}
		first = false
		out.Write(member[1 : len(member)-1])
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// oneOf lists the values an enum or a tagged union takes, quoted, in the schema's order.
func oneOf(values []string) string {
	quoted := make([]string, len(values))
	for i, v := range values {
		quoted[i] = quote(v)
	}
	return "one of " + strings.Join(quoted, ", ")
}

// decodeTagged reads the tag key of a JSON object and decodes only the branch it names. A
// missing tag fails with CodeMissingKey, a tag that isn't a string with CodeWrongType and a tag
// no branch has with CodeBadTag, naming the tags in the schema's order, at the tag's path.
func decodeTagged[U any](n *node, key string, tags []string, branches map[string]func(*node) (U, *DecodeError)) (U, *DecodeError) {
	var zero U
	if err := expect(n, '{'); err != nil {
		return zero, err
	}
	tag, ok := n.fields[key]
	if !ok {
		return zero, fail(CodeMissingKey, "", "").at(key)
	}
	if tag.kind != '"' {
		return zero, mismatch("a string", tag).at(key)
	}
	decode, ok := branches[tag.text]
	if !ok {
		return zero, fail(CodeBadTag, oneOf(tags), quote(tag.text)).at(key)
	}
	return decode(n)
}

// branch decodes one branch of a tagged union as the union's interface type U.
func branch[U any, T any, PT interface {
	*T
	nodeDecoder
}](n *node) (U, *DecodeError) {
	v, err := decodeType[T, PT](n)
	if err != nil {
		var zero U
		return zero, err
	}
	return any(v).(U), nil
}

${report ? UNTAGGED_REPORT : UNTAGGED_STRICT}

// try returns a variant of an untagged union that decodes into a pointer field.
func try[T any](dst **T, decode func(*node) (T, *DecodeError)) func(*node) bool {
	return tryValue(dst, boxed(decode))
}

// tryValue returns a variant of an untagged union that decodes into a value field.
func tryValue[T any](dst *T, decode func(*node) (T, *DecodeError)) func(*node) bool {
	return func(n *node) bool {
		v, err := decode(n)
		if err != nil {
			return false
		}
		*dst = v
		return true
	}
}

// encodeUntagged encodes the one variant that is set. None or more than one fails.
func encodeUntagged(name string, variants ...any) ([]byte, error) {
	var set []any
	for _, v := range variants {
		if v != nil {
			set = append(set, v)
		}
	}
	if len(set) != 1 {
		return nil, fmt.Errorf("%s must hold exactly one variant, it holds %d", name, len(set))
	}
	data, err := json.Marshal(set[0])
	if err != nil {
		return nil, fmt.Errorf("encoding %s: %w", name, err)
	}
	return data, nil
}

// some returns p as an any that is nil when p is nil.
func some[T any](p *T) any {
	if p == nil {
		return nil
	}
	return p
}

// someRaw returns raw as an any that is nil when raw is absent.
func someRaw(raw json.RawMessage) any {
	if raw == nil {
		return nil
	}
	return raw
}

// decodeEnum decodes a JSON string that must be one of values. One it doesn't list fails with
// CodeNotInEnum, naming the values in the schema's order, or with CodeNotConst for an enum of
// one value.
func decodeEnum[T ~string](n *node, dst *T, values ...T) *DecodeError {
	s, err := decodeString(n)
	if err != nil {
		return err
	}
	if !slices.Contains(values, T(s)) {
		if len(values) == 1 {
			return fail(CodeNotConst, quote(string(values[0])), quote(s))
		}
		names := make([]string, len(values))
		for i, v := range values {
			names[i] = string(v)
		}
		return fail(CodeNotInEnum, oneOf(names), quote(s))
	}
	*dst = T(s)
	return nil
}

// encodeEnum returns the text of v, failing when values doesn't list it. Used as MarshalText,
// it covers values; checkKey covers map keys, which encoding/json writes without it.
func encodeEnum[T ~string](v T, values ...T) ([]byte, error) {
	if !slices.Contains(values, v) {
		return nil, fmt.Errorf("unknown value %s", quote(string(v)))
	}
	return []byte(v), nil
}

// decodeStringInto decodes a JSON string into a named string type, like an id.
func decodeStringInto[T ~string](n *node, dst *T) *DecodeError {
	s, err := decodeString(n)
	if err != nil {
		return err
	}
	*dst = T(s)
	return nil
}

// decodeConstInt decodes an integer that must be want.
func decodeConstInt(n *node, want int64) *DecodeError {
	v, err := decodeInt(n)
	if err != nil {
		return err
	}
	if v != want {
		return fail(CodeNotConst, strconv.FormatInt(want, 10), string(n.raw))
	}
	return nil
}

// decodeConstBool decodes a boolean that must be want.
func decodeConstBool(n *node, want bool) *DecodeError {
	v, err := decodeBool(n)
	if err != nil {
		return err
	}
	if v != want {
		return fail(CodeNotConst, strconv.FormatBool(want), strconv.FormatBool(v))
	}
	return nil
}

// ${GO_NON_NULL} is any JSON value except null at the top, like jsonValue. Nested values may be anything.
type ${GO_NON_NULL} json.RawMessage

// MarshalJSON encodes the value as it was decoded. An empty value fails.
func (v ${GO_NON_NULL}) MarshalJSON() ([]byte, error) {
	if len(v) == 0 {
		return nil, errors.New("${GO_NON_NULL} is empty")
	}
	return []byte(v), nil
}

// UnmarshalJSON keeps any JSON value except null.
func (v *${GO_NON_NULL}) UnmarshalJSON(data []byte) error { return unmarshal(data, v) }

func (v *${GO_NON_NULL}) decode(n *node) *DecodeError {
	if n.kind == 'n' {
		return fail(CodeNullNotAllowed, "a JSON value other than null", "")
	}
	*v = ${GO_NON_NULL}(bytes.Clone(n.raw))
	return nil
}

// checker is a generated type whose values have constraints. They are checked once the whole
// value has decoded, so a structure error anywhere comes first, in the same order as Rust and
// TypeScript: a value's own constraints before the values inside it, fields in schema order,
// items by index and map keys in code point order.
type checker interface {
	check() *DecodeError
}

// checkValue checks the constraints of v when its type has any, like the branch a tagged union
// holds.
func checkValue(v any) *DecodeError {
	if c, ok := v.(checker); ok {
		return c.check()
	}
	return nil
}

// withCheck returns a decoder that decodes with decode, then checks the whole value with check,
// for an alias, which has no methods.
func withCheck[T any](decode func(*node) (T, *DecodeError), check func(T) *DecodeError) func(*node) (T, *DecodeError) {
	return func(n *node) (T, *DecodeError) {
		v, err := decode(n)
		if err == nil {
			err = check(v)
		}
		return v, err
	}
}

// count shows n things, like "1 character" or "3 items".
func count(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

// checkCount checks a count of things against a minimum and a maximum, each -1 when absent.
func checkCount(n, min, max int, one, many string) *DecodeError {
	if min >= 0 && n < min {
		return fail(CodeTooShort, "at least "+count(min, one, many), count(n, one, many))
	}
	if max >= 0 && n > max {
		return fail(CodeTooLong, "at most "+count(max, one, many), count(n, one, many))
	}
	return nil
}

// checkLength checks the length of a string in code points, like Rust and TypeScript count it.
func checkLength(text string, min, max int) *DecodeError {
	return checkCount(utf8.RuneCountInString(text), min, max, "${COUNT_UNITS.length[0]}", "${COUNT_UNITS.length[1]}")
}

// checkItems checks the number of items of an array, then each item with item, if not nil.
func checkItems[T any](items []T, min, max int, item func(T) *DecodeError) *DecodeError {
	if err := checkCount(len(items), min, max, "${COUNT_UNITS.items[0]}", "${COUNT_UNITS.items[1]}"); err != nil {
		return err
	}
	if item == nil {
		return nil
	}
	for i, v := range items {
		if err := item(v); err != nil {
			return err.at(strconv.Itoa(i))
		}
	}
	return nil
}

// checkEntries checks the number of keys of a map, then, in code point order, each key with key
// and its value with value, each if not nil, at the key's path.
func checkEntries[K ~string, V any](m map[K]V, min, max int, key func(K) *DecodeError, value func(V) *DecodeError) *DecodeError {
	if err := checkCount(len(m), min, max, "${COUNT_UNITS.keys[0]}", "${COUNT_UNITS.keys[1]}"); err != nil {
		return err
	}
	if key == nil && value == nil {
		return nil
	}
	for _, k := range slices.Sorted(maps.Keys(m)) {
		if key != nil {
			if err := key(k); err != nil {
				return err.at(string(k))
			}
		}
		if value != nil {
			if err := value(m[k]); err != nil {
				return err.at(string(k))
			}
		}
	}
	return nil
}

// limit is one bound of an integer or a number: op is >=, >, <= or <, or % for a multiple of
// an integer, and text is the bound as errors show it.
type limit[T int64 | float64] struct {
	op    string
	bound T
	text  string
}

// outside returns the error for v when it is outside l, with found showing v.
func outside[T int64 | float64](v T, l limit[T], found string) *DecodeError {
	switch {
	case l.op == ">=" && v < l.bound, l.op == ">" && v <= l.bound:
		return fail(CodeTooSmall, l.op+" "+l.text, found)
	case l.op == "<=" && v > l.bound, l.op == "<" && v >= l.bound:
		return fail(CodeTooLarge, l.op+" "+l.text, found)
	}
	return nil
}

// checkInt checks an integer against each limit in order.
func checkInt(v int64, limits ...limit[int64]) *DecodeError {
	found := strconv.FormatInt(v, 10)
	for _, l := range limits {
		if l.op == "%" {
			if v%l.bound != 0 {
				return fail(CodeNotMultipleOf, "a multiple of "+l.text, found)
			}
			continue
		}
		if err := outside(v, l, found); err != nil {
			return err
		}
	}
	return nil
}

// checkNumber checks a number against each limit in order. It compares the nearest float64 to
// the number as spelled, like Rust and TypeScript.
func checkNumber(v json.Number, limits ...limit[float64]) *DecodeError {
	f, err := strconv.ParseFloat(string(v), 64)
	if err != nil {
		return fail(CodeWrongType, "a number", string(v))
	}
	for _, l := range limits {
		if err := outside(f, l, numberText(f)); err != nil {
			return err
		}
	}
	return nil
}

// numberText writes a float64 as JavaScript does, like Rust and TypeScript errors show it: the
// shortest digits that read back as the same float, without an exponent from 1e-6 up to 1e21,
// and with -0 kept.
func numberText(f float64) string {
	text := strconv.FormatFloat(f, 'e', -1, 64)
	sign := ""
	if text[0] == '-' {
		sign, text = "-", text[1:]
	}
	mantissa, exponent, _ := strings.Cut(text, "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	e, _ := strconv.Atoi(exponent)
	// The number is 0.digits times 10 to the n.
	n, k := e+1, len(digits)
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	head := digits[:1]
	if k > 1 {
		head += "." + digits[1:]
	}
	if n-1 < 0 {
		return sign + head + "e-" + strconv.Itoa(1-n)
	}
	return sign + head + "e+" + strconv.Itoa(n-1)
}
`;
}
