package types

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestFixturesThroughUnmarshal decodes every fixture whose type json.Unmarshal can fill with
// json.Unmarshal, the standard entry point, and checks that it gives what the registry gives:
// the same path and code for an invalid case, the same JSON for a valid one. Every root kind
// that isn't a tagged union is in fixtureTypes, aliases of strings, numbers and lists included,
// so each reads with the strict parser and checks its constraints.
func TestFixturesThroughUnmarshal(t *testing.T) {
	root := filepath.Join("..", "fixtures")
	types := fixtureTypes()
	decoders := fixtureDecoders()
	seen := map[string]bool{}
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || filepath.Ext(path) != ".json" || strings.HasSuffix(path, expectSuffix) {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		key := strings.Join(parts[:len(parts)-2], "/")
		fresh, ok := types[key]
		if !ok {
			return nil
		}
		seen[key] = true
		t.Run(filepath.ToSlash(rel), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			want, wantErr := decoders[key](data)
			v := fresh()
			err = json.Unmarshal(data, v)
			if wantErr != nil {
				// json.Unmarshal checks the syntax itself before UnmarshalJSON runs.
				var syntax *json.SyntaxError
				var got, expected *DecodeError
				if !json.Valid(data) && errors.As(err, &syntax) && errors.As(wantErr, &expected) && expected.Code == CodeInvalidJSON {
					return
				}
				if !errors.As(err, &got) || !errors.As(wantErr, &expected) {
					t.Fatalf("got %v, expected %v", err, wantErr)
				}
				if got.Path != expected.Path || got.Code != expected.Code {
					t.Fatalf("got path %q code %q, expected path %q code %q", got.Path, got.Code, expected.Path, expected.Code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(v)
			if err != nil {
				t.Fatal(err)
			}
			expected, err := json.Marshal(want)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := jsonValue(t, encoded), jsonValue(t, expected); !reflect.DeepEqual(got, want) {
				t.Fatalf("encodes as %s, the registry's value as %s", encoded, expected)
			}
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Aliases of a string, a list and a string with a format, which json.Unmarshal used to read
	// without the strict parser.
	for _, key := range []string{"order/code", "order/codes", "common/timestamp", "shipment/day", "shipment/labelCodes"} {
		if !seen[key] {
			t.Errorf("no fixtures for %s", key)
		}
	}
}
