package types

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// TestEncodeRefusesUnlistedEnumValue checks that an enum value the schema doesn't list fails
// to encode, as a value and inside a struct, as in Rust and TypeScript.
func TestEncodeRefusesUnlistedEnumValue(t *testing.T) {
	if data, err := json.Marshal(RoleAdmin); err != nil || string(data) != `"admin"` {
		t.Fatalf("got %s, %v, expected \"admin\"", data, err)
	}
	if _, err := json.Marshal(Role("root")); err == nil || !strings.Contains(err.Error(), `unknown value "root"`) {
		t.Fatalf("got %v, expected an unknown value error", err)
	}
	card := Card{Type: CardTypeCard, Brand: CardBrand("discover"), Last4: "4242", ExpMonth: 1, ExpYear: 2030}
	if _, err := json.Marshal(card); err == nil || !strings.Contains(err.Error(), `unknown value "discover"`) {
		t.Fatalf("got %v, expected an unknown value error", err)
	}
}

// TestEncodeRefusesUnlistedEnumKey checks that a map key its enum doesn't list fails to encode,
// which encoding/json would write without MarshalText, as in Rust and TypeScript.
func TestEncodeRefusesUnlistedEnumKey(t *testing.T) {
	user := User{Id: "usr_1", Email: "a@example.com", Role: RoleMember, Labels: map[string]string{}, CreatedAt: "2026-01-15T09:30:00Z"}
	quota := map[Role]int64{RoleMember: 2, RoleAdmin: 1}
	user.Quota = &quota
	data, err := json.Marshal(user)
	if err != nil || !strings.Contains(string(data), `"quota":{"admin":1,"member":2}`) {
		t.Fatalf("got %s, %v, expected the quota sorted by key", data, err)
	}
	quota[Role("guest")] = 1
	if _, err := json.Marshal(user); err == nil || !strings.Contains(err.Error(), `key "guest": unknown value "guest"`) {
		t.Fatalf("got %v, expected an unknown value error for the key", err)
	}
}

// TestEncodeWritesTheBytesRustAndTypeScriptWrite checks that Encode writes <, >, &, U+2028 and
// U+2029 as they are, gives the strings of a value kept as raw JSON the same escapes as any other
// string, keeps an escaped backslash before "u2028" as text, and fails where json.Marshal fails.
func TestEncodeWritesTheBytesRustAndTypeScriptWrite(t *testing.T) {
	input := `{"id":"123e4567-e89b-12d3-a456-426614174000","tracking":"AB123456789US",` +
		`"shippedAt":"2024-02-29T23:59:60Z","notes":{"gift":"<a> & b \u2028\u2029 \\u2028"},` +
		`"extra":["\u0041\/\u00E9\ud83d\ude00\u001F\u003c",{"k":"\\\\"}]}`
	var shipment Shipment
	if err := json.Unmarshal([]byte(input), &shipment); err != nil {
		t.Fatal(err)
	}
	data, err := Encode(shipment)
	want := `{"id":"123e4567-e89b-12d3-a456-426614174000","tracking":"AB123456789US",` +
		"\"shippedAt\":\"2024-02-29T23:59:60Z\",\"notes\":{\"gift\":\"<a> & b \u2028\u2029 \\\\u2028\"}," +
		"\"extra\":[\"A/\u00e9\U0001f600\\u001f<\",{\"k\":\"\\\\\\\\\"}]}"
	if err != nil || string(data) != want {
		t.Fatalf("got %s, %v, expected %s", data, err, want)
	}
	if marshaled, err := json.Marshal(shipment); err != nil || !strings.Contains(string(marshaled), `\u003ca\u003e \u0026 b \u2028`) {
		t.Fatalf("got %s, %v, expected json.Marshal to escape them", marshaled, err)
	}
	if _, err := Encode(Role("root")); err == nil || !strings.Contains(err.Error(), `unknown value "root"`) {
		t.Fatalf("got %v, expected an unknown value error", err)
	}
}

// TestEncodeRefusesRawValuesRustCouldNotWrite checks that a value kept as raw JSON, built by
// hand, fails to encode with a string holding a lone surrogate or bytes that aren't UTF-8,
// which json.Marshal would write as U+FFFD or as they are, and that a surrogate pair still
// encodes.
func TestEncodeRefusesRawValuesRustCouldNotWrite(t *testing.T) {
	for _, raw := range []string{`"\ud800"`, `"a\udc00"`, `["\ud83dx"]`, `{"k":"\ud83dA"}`} {
		if data, err := Encode(NonNullJson(raw)); err == nil || !strings.Contains(err.Error(), "lone surrogate") {
			t.Fatalf("%s: got %s, %v, expected a lone surrogate error", raw, data, err)
		}
	}
	for _, raw := range []string{"\"a\xffb\"", "{\"k\xc3\":1}"} {
		if data, err := Encode(NonNullJson(raw)); err == nil || !strings.Contains(err.Error(), "isn't valid UTF-8") {
			t.Fatalf("%q: got %s, %v, expected an invalid UTF-8 error", raw, data, err)
		}
	}
	if data, err := Encode(NonNullJson(`"😀\\ud800"`)); err != nil || string(data) != "\"\U0001f600\\\\ud800\"" {
		t.Fatalf("got %s, %v, expected the pair as one character and the escaped backslash kept", data, err)
	}
}

// TestDecodeErrorShape checks the shared error shape, its message and its compact form.
func TestDecodeErrorShape(t *testing.T) {
	var event Event
	err := json.Unmarshal([]byte(`{"id":"evt_1","type":"user.created","occurredAt":"t","attempt":12.0}`), &event)
	var got *DecodeError
	if !errors.As(err, &got) {
		t.Fatalf("got %v, expected a *DecodeError", err)
	}
	want := DecodeError{Path: "/attempt", Code: CodeWrongType, Expected: "an integer", Found: "12.0"}
	if *got != want {
		t.Fatalf("got %+v, expected %+v", *got, want)
	}
	if got.Error() != "/attempt: wrong type, expected an integer, found 12.0" {
		t.Fatalf("got message %q", got.Error())
	}
	if got.Compact() != "/attempt wrong_type, expected an integer, found 12.0" {
		t.Fatalf("got compact form %q", got.Compact())
	}
}
