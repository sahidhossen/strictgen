package types

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// TestFixtures decodes every fixture under examples/report/fixtures through the generated
// registry, in report mode. A fixture lives in <schema>/valid or <schema>/invalid for a schema's
// root type, and in <schema>/<def>/valid or <schema>/<def>/invalid for one of its defs. A valid
// case must decode with the unknown key paths in <case>.expect.json, {"unknown": [...]}, in that
// order, give the same paths to the hook, and encode again to the same JSON value without the
// unknown keys. An invalid case must fail with the path and code in <case>.expect.json and call
// no hook, as in Rust and TypeScript.
func TestFixtures(t *testing.T) {
	var hooked [][]string
	SetUnknownKeyHook(func(paths []string) { hooked = append(hooked, paths) })
	defer SetUnknownKeyHook(nil)

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
		if strings.HasSuffix(path, expectSuffix) {
			// An expectation belongs to a case next to it, and is not a case itself.
			if _, err := os.Stat(strings.TrimSuffix(path, expectSuffix) + ".json"); err != nil {
				t.Errorf("%s: no case next to it", rel)
			}
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
			hooked = nil
			value, unknown, err := decode(data)
			want := expectation(t, strings.TrimSuffix(path, ".json")+expectSuffix, valid)
			if !valid {
				if err == nil {
					t.Fatalf("decoded, expected an error: %#v", value)
				}
				var got *DecodeError
				if !errors.As(err, &got) {
					t.Fatalf("got %v, expected a *DecodeError", err)
				}
				if got.Path != *want.Path || got.Code != *want.Code {
					t.Fatalf("got path %q code %q (%v), expected path %q code %q", got.Path, got.Code, err, *want.Path, *want.Code)
				}
				if len(hooked) != 0 {
					t.Fatalf("a failed decode called the hook with %q", hooked)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(unknown, *want.Unknown) {
				t.Fatalf("got unknown keys %q, expected %q", unknown, *want.Unknown)
			}
			if len(unknown) == 0 && len(hooked) != 0 || len(unknown) > 0 && (len(hooked) != 1 || !slices.Equal(hooked[0], unknown)) {
				t.Fatalf("the hook got %q, expected %q once", hooked, unknown)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			expected := jsonValue(t, data)
			for _, path := range unknown {
				remove(t, expected, path)
			}
			if got := jsonValue(t, encoded); !reflect.DeepEqual(got, expected) {
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

// TestUnmarshalReports checks that json.Unmarshal and the Report functions give the unknown
// keys to the hook, and that SetUnknownKeyHook(nil) removes it.
func TestUnmarshalReports(t *testing.T) {
	var hooked [][]string
	SetUnknownKeyHook(func(paths []string) { hooked = append(hooked, paths) })
	data := []byte(`{"id":"o","customer":{"name":"Ada","phone":"1","x":1},"lines":[],"payment":{"type":"invoice","dueDays":3,"y":2}}`)
	var order Order
	if err := json.Unmarshal(data, &order); err != nil {
		t.Fatal(err)
	}
	payment, err := ReportPayment([]byte(`{"type":"card","last4":"4242","z":3}`))
	if err != nil {
		t.Fatal(err)
	}
	line, err := Report[Line]([]byte(`{"sku":"A","quantity":1}`))
	if err != nil {
		t.Fatal(err)
	}
	SetUnknownKeyHook(nil)
	if err := json.Unmarshal(data, &order); err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"/customer/x", "/payment/y"}, {"/z"}}
	if !reflect.DeepEqual(hooked, want) {
		t.Fatalf("the hook got %q, expected %q", hooked, want)
	}
	if !slices.Equal(payment.Unknown, []string{"/z"}) || payment.Value.(PaymentCard).Last4 != "4242" {
		t.Fatalf("ReportPayment returned %#v", payment)
	}
	if line.Unknown == nil || len(line.Unknown) != 0 || line.Value.Sku != "A" {
		t.Fatalf("Report[Line] returned %#v", line)
	}
}

// expectSuffix ends the file next to a case that holds what it expects.
const expectSuffix = ".expect.json"

// want is what a case expects: the unknown key paths of a valid case, the path and code of an
// invalid one.
type want struct {
	Unknown *[]string `json:"unknown"`
	Path    *string   `json:"path"`
	Code    *string   `json:"code"`
}

// expectation reads what a case expects: {"unknown": [...]} for a valid case and
// {"path": ..., "code": ...} for an invalid one. No other key is allowed.
func expectation(t *testing.T, path string, valid bool) want {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("every case needs %s: %v", filepath.Base(path), err)
	}
	var w want
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	err = decoder.Decode(&w)
	if valid && (err != nil || w.Unknown == nil || w.Path != nil || w.Code != nil) {
		t.Fatalf("%s: expected {\"unknown\": [...]}: %v", path, err)
	}
	if !valid && (err != nil || w.Unknown != nil || w.Path == nil || w.Code == nil) {
		t.Fatalf("%s: expected {\"path\": ..., \"code\": ...}: %v", path, err)
	}
	return w
}

// remove deletes the key a JSON Pointer names from a JSON value read by jsonValue.
func remove(t *testing.T, value any, path string) {
	t.Helper()
	segments := strings.Split(path, "/")[1:]
	for i, s := range segments {
		segments[i] = strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
	}
	for _, s := range segments[:len(segments)-1] {
		switch v := value.(type) {
		case map[string]any:
			value = v[s]
		case []any:
			var i int
			if err := json.Unmarshal([]byte(s), &i); err != nil || i < 0 || i >= len(v) {
				t.Fatalf("%s: no item %s", path, s)
			}
			value = v[i]
		}
	}
	object, ok := value.(map[string]any)
	last := segments[len(segments)-1]
	if _, has := object[last]; !ok || !has {
		t.Fatalf("%s: no such key in the input", path)
	}
	delete(object, last)
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
