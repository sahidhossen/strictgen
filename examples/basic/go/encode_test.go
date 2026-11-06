package types

import (
	"encoding/json"
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
