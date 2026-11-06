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

// TestAliasFixturesThroughUnmarshal decodes the fixtures of the constrained alias Tags with
// json.Unmarshal and with Report[Tags], the standard entry points. A constrained alias is a type
// of its own, so both check its constraints and fail as the registry does.
func TestAliasFixturesThroughUnmarshal(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "fixtures", "order", "tags", "*", "*.json"))
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
			want := expectation(t, strings.TrimSuffix(path, ".json")+expectSuffix, valid)
			var tags Tags
			errs := []error{json.Unmarshal(data, &tags)}
			reported, err := Report[Tags](data)
			errs = append(errs, err)
			for _, err := range errs {
				if valid {
					if err != nil {
						t.Fatal(err)
					}
					continue
				}
				var got *DecodeError
				if !errors.As(err, &got) {
					t.Fatalf("got %v, expected a *DecodeError", err)
				}
				if got.Path != *want.Path || got.Code != *want.Code {
					t.Fatalf("got path %q code %q, expected path %q code %q", got.Path, got.Code, *want.Path, *want.Code)
				}
			}
			if !valid {
				return
			}
			if len(reported.Unknown) != 0 || !reflect.DeepEqual(reported.Value, tags) {
				t.Fatalf("Report[Tags] returned %#v, json.Unmarshal %#v", reported, tags)
			}
			encoded, err := json.Marshal(tags)
			if err != nil {
				t.Fatal(err)
			}
			if got, want := jsonValue(t, encoded), jsonValue(t, data); !reflect.DeepEqual(got, want) {
				t.Fatalf("encodes as %s", encoded)
			}
		})
	}
	if count == 0 {
		t.Fatal("no fixtures for order/tags")
	}
}

// TestFixturesThroughUnmarshal decodes every fixture whose type json.Unmarshal can fill with
// json.Unmarshal, the standard entry point, and checks that it gives what the registry gives:
// the same path and code for an invalid case, the same JSON for a valid one.
func TestFixturesThroughUnmarshal(t *testing.T) {
	root := filepath.Join("..", "fixtures")
	types := fixtureTypes()
	decoders := fixtureDecoders()
	count := 0
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
		count++
		t.Run(filepath.ToSlash(rel), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			want, _, wantErr := decoders[key](data)
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
	if count == 0 {
		t.Fatal("no fixtures through json.Unmarshal")
	}
}
