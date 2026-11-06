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

// TestAliasFixturesThroughUnmarshal decodes the fixtures of each constrained alias with
// json.Unmarshal, the standard entry point. A constrained alias is a type of its own, so
// json.Unmarshal checks its constraints and fails as the registry does.
func TestAliasFixturesThroughUnmarshal(t *testing.T) {
	cases := []struct {
		key   string
		fresh func() json.Unmarshaler
	}{
		{"order/code", func() json.Unmarshaler { return new(Code) }},
		{"order/codes", func() json.Unmarshaler { return new(Codes) }},
	}
	for _, c := range cases {
		paths, err := filepath.Glob(filepath.Join("..", "fixtures", filepath.FromSlash(c.key), "*", "*.json"))
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for _, path := range paths {
			if strings.HasSuffix(path, expectSuffix) {
				continue
			}
			count++
			valid := filepath.Base(filepath.Dir(path)) == "valid"
			t.Run(filepath.ToSlash(path), func(t *testing.T) {
				data, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				v := c.fresh()
				err = json.Unmarshal(data, v)
				if !valid {
					want := expectation(t, strings.TrimSuffix(path, ".json")+expectSuffix)
					var got *DecodeError
					if !errors.As(err, &got) {
						t.Fatalf("got %v, expected a *DecodeError", err)
					}
					if got.Path != want.Path || got.Code != want.Code {
						t.Fatalf("got path %q code %q, expected path %q code %q", got.Path, got.Code, want.Path, want.Code)
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
				if got, want := jsonValue(t, encoded), jsonValue(t, data); !reflect.DeepEqual(got, want) {
					t.Fatalf("encodes as %s", encoded)
				}
			})
		}
		if count == 0 {
			t.Fatalf("no fixtures for %s", c.key)
		}
	}
}
