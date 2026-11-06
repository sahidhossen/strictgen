package types

import (
	"errors"
	"strings"
	"testing"
)

// TestJSONErrorCodes checks the code of each kind of input that isn't JSON the decoders read.
func TestJSONErrorCodes(t *testing.T) {
	cases := []struct {
		name, input, code string
	}{
		{"syntax error", `{"id":`, CodeInvalidJSON},
		{"invalid UTF-8", "\"\xff\"", CodeInvalidJSON},
		{"lone surrogate", `"\ud800"`, CodeInvalidJSON},
		{"trailing data", `{} {}`, CodeInvalidJSON},
		{"number out of range", `1e400`, CodeInvalidJSON},
		{"duplicate key", `{"id":"usr_1","id":"usr_2"}`, CodeDuplicateKey},
		{"too deep", strings.Repeat("[", 128) + strings.Repeat("]", 128), CodeTooDeep},
	}
	decode := fixtureDecoders()["user"]
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := decode([]byte(c.input))
			var decodeErr *DecodeError
			if !errors.As(err, &decodeErr) {
				t.Fatalf("got %v, expected a *DecodeError", err)
			}
			if decodeErr.Code != c.code {
				t.Fatalf("got code %q (%v), expected %q", decodeErr.Code, err, c.code)
			}
		})
	}
}

// TestFoundStrings checks how errors show strings, the same rule as TypeScript: quoted, " and \
// escaped, control characters, U+2028 and U+2029 as \u escapes, and cut to 64 code points.
func TestFoundStrings(t *testing.T) {
	cases := []struct{ text, want string }{
		{`a"b\c`, `"a\"b\\c"`},
		{"\u0000\u001f\u007f\u0085\u2028\u2029é😀", `"\u0000\u001f\u007f\u0085\u2028\u2029é😀"`},
		{strings.Repeat("😀", 64), `"` + strings.Repeat("😀", 64) + `"`},
		{strings.Repeat("😀", 65), `"` + strings.Repeat("😀", 64) + `"...`},
	}
	for _, c := range cases {
		if got := quote(c.text); got != c.want {
			t.Errorf("quote(%q) = %s, expected %s", c.text, got, c.want)
		}
	}
}

// TestConstraintMessages checks the messages of constraint errors, the same as Rust's
// constraint_messages and the TypeScript tests: counts in code points, items and keys, and
// numbers as JavaScript writes them.
func TestConstraintMessages(t *testing.T) {
	order := func(note, rest string) string {
		return `{"id":"ord_5h1c","note":` + note + `,"quantity":1,"tags":["a"]` + rest + `}`
	}
	cases := []struct{ note, rest, want string }{
		{`"😀"`, `,"price":1`, "/note: too short, expected at least 2 characters, found 1 character"},
		{`"e\u0301e\u0301e\u0301"`, `,"price":1`, "/note: too long, expected at most 5 characters, found 6 characters"},
		{`"ab"`, `,"price":1,"packSize":7`, "/packSize: not a multiple, expected a multiple of 6, found 7"},
		{`"ab"`, `,"price":1,"packSize":50`, "/packSize: too large, expected < 50, found 50"},
		{`"ab"`, `,"price":1E3`, "/price: too large, expected < 1000, found 1000"},
		{`"ab"`, `,"price":1e-7`, "/price: too small, expected >= 0.5, found 1e-7"},
		{`"ab"`, `,"price":1,"discount":-0`, "/discount: too small, expected > 0, found -0"},
		{`"ab"`, `,"price":1,"discount":1e21`, "/discount: too large, expected <= 0.75, found 1e+21"},
		{`"ab"`, `,"price":1,"attributes":{"c":"abc","b":"abc","a":"abc"}`, "/attributes: too long, expected at most 2 keys, found 3 keys"},
		{`"ab"`, `,"price":1,"attributes":{"b":"x","a":"y"}`, "/attributes/a: too short, expected at least 3 characters, found 1 character"},
		{`"a"`, `,"price":"1"`, `/price: wrong type, expected a number, found "1"`},
	}
	decode := fixtureDecoders()["order"]
	for _, c := range cases {
		text := order(c.note, c.rest)
		if _, err := decode([]byte(text)); err == nil || err.Error() != c.want {
			t.Errorf("%s: got %v, expected %s", text, err, c.want)
		}
	}
	text := `{"id":"ord_5h1c","note":"ab","quantity":1,"price":1,"tags":[]}`
	if _, err := decode([]byte(text)); err == nil || err.Error() != "/tags: too short, expected at least 1 item, found 0 items" {
		t.Errorf("%s: got %v", text, err)
	}
}
