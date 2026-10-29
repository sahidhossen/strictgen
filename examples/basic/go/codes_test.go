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
