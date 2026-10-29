package types

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestFixtures decodes every fixture under examples/basic/fixtures through the generated
// registry. A fixture lives in <schema>/valid or <schema>/invalid for a schema's root type, and
// in <schema>/<def>/valid or <schema>/<def>/invalid for one of its defs. A valid case must decode
// and encode again to the same JSON value. An invalid case must fail to decode.
func TestFixtures(t *testing.T) {
	root := filepath.Join("..", "fixtures")
	decoders := fixtureDecoders()
	count := 0
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".json" {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 3 || (parts[len(parts)-2] != "valid" && parts[len(parts)-2] != "invalid") {
			t.Errorf("%s: not in a valid or invalid folder", rel)
			return nil
		}
		count++
		key := strings.Join(parts[:len(parts)-2], "/")
		valid := parts[len(parts)-2] == "valid"
		t.Run(filepath.ToSlash(rel), func(t *testing.T) {
			decode, ok := decoders[key]
			if !ok {
				t.Fatalf("no generated type for %s", key)
			}
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			value, err := decode(data)
			if !valid {
				if err == nil {
					t.Fatalf("decoded, expected an error: %#v", value)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := jsonValue(t, encoded), jsonValue(t, data); !reflect.DeepEqual(got, want) {
				t.Fatalf("encodes as %s", encoded)
			}
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatalf("no fixtures under %s", root)
	}
}

// jsonValue reads JSON into maps, slices and numbers as spelled, for comparing two documents.
func jsonValue(t *testing.T, data []byte) any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var v any
	if err := decoder.Decode(&v); err != nil {
		t.Fatal(err)
	}
	return v
}
