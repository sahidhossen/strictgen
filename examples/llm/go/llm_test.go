package types

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// decoders holds, for each type with an LLM decoder, that decoder and the normal one.
type decoders struct {
	llm    func([]byte) (any, error)
	normal func([]byte) (any, error)
}

// fromLlm wraps an LLM decoder to return any.
func fromLlm[T any](decode func([]byte) (T, error)) func([]byte) (any, error) {
	return func(data []byte) (any, error) { return decode(data) }
}

// unmarshalled decodes with json.Unmarshal, the normal decoder of every type but a tagged union.
func unmarshalled[T any]() func([]byte) (any, error) {
	return func(data []byte) (any, error) {
		var v T
		err := json.Unmarshal(data, &v)
		return v, err
	}
}

var llmDecoders = map[string]decoders{
	"Billing":      {fromLlm(DecodeBillingFromLlm), fromLlm(DecodePayment)},
	"Boxes":        {fromLlm(DecodeBoxesFromLlm), unmarshalled[Boxes]()},
	"Card":         {fromLlm(DecodeCardFromLlm), unmarshalled[Card]()},
	"Contact":      {fromLlm(DecodeContactFromLlm), unmarshalled[Contact]()},
	"Customer":     {fromLlm(DecodeCustomerFromLlm), unmarshalled[Customer]()},
	"Invoice":      {fromLlm(DecodeInvoiceFromLlm), unmarshalled[Invoice]()},
	"Line":         {fromLlm(DecodeLineFromLlm), unmarshalled[Line]()},
	"OrderRequest": {fromLlm(DecodeOrderRequestFromLlm), unmarshalled[OrderRequest]()},
	"Payment":      {fromLlm(DecodePaymentFromLlm), fromLlm(DecodePayment)},
	"Picks":        {fromLlm(DecodePicksFromLlm), unmarshalled[Picks]()},
	"Remark":       {fromLlm(DecodeRemarkFromLlm), unmarshalled[Remark]()},
	"Sku":          {fromLlm(DecodeSkuFromLlm), unmarshalled[Sku]()},
	"Status":       {fromLlm(DecodeStatusFromLlm), unmarshalled[Status]()},
	"Stock":        {fromLlm(DecodeStockFromLlm), unmarshalled[Stock]()},
}

// TestLlmVectors runs the shared LLM vectors through the LLM decoders. Rust and TypeScript run
// the same file, so the three languages decode every payload to the same value, which equals the
// value the normal decoder makes of the same JSON, and report the same error for every near miss.
func TestLlmVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "llm-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	// A misspelled key would leave a vector half read, so only these keys are allowed.
	decoder.DisallowUnknownFields()
	var vectors []struct {
		Name  *string `json:"name"`
		Type  *string `json:"type"`
		Llm   *string `json:"llm"`
		JSON  *string `json:"json"`
		Error *string `json:"error"`
	}
	if err := decoder.Decode(&vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) < 1000 {
		t.Fatalf("expected the full set of vectors, found %d", len(vectors))
	}
	seen := map[string]bool{}
	for i, v := range vectors {
		if v.Name == nil || v.Type == nil || v.Llm == nil || (v.JSON == nil) == (v.Error == nil) {
			t.Fatalf("vector %d needs name, type, llm and one of json or error", i)
		}
		d, ok := llmDecoders[*v.Type]
		if !ok {
			t.Fatalf("%s: no decoder for type %s", *v.Name, *v.Type)
		}
		seen[*v.Type] = true
		got, err := d.llm([]byte(*v.Llm))
		if v.JSON != nil {
			if err != nil {
				t.Errorf("%s: %v", *v.Name, err)
				continue
			}
			want, err := d.normal([]byte(*v.JSON))
			if err != nil {
				t.Errorf("%s: the normal decoder fails: %v", *v.Name, err)
				continue
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s: decoded %#v, the normal decoder %#v", *v.Name, got, want)
			}
			continue
		}
		var decodeErr *DecodeError
		if !errors.As(err, &decodeErr) {
			t.Errorf("%s: expected %s, got %v", *v.Name, *v.Error, err)
			continue
		}
		if decodeErr.Compact() != *v.Error {
			t.Errorf("%s: got %s, expected %s", *v.Name, decodeErr.Compact(), *v.Error)
		}
	}
	if len(seen) != len(llmDecoders) {
		t.Fatalf("vectors cover %d of the %d types", len(seen), len(llmDecoders))
	}
}

// TestLlmInvalidUTF8 checks that bytes which aren't UTF-8, which Rust and TypeScript strings can't
// hold, fail as text that isn't JSON, after the cleanup step left them as they are.
func TestLlmInvalidUTF8(t *testing.T) {
	_, err := DecodeRemarkFromLlm([]byte{'{', '"', 'v', 'a', 'l', 'u', 'e', '"', ':', '"', 0xff, '"', ',', '}'})
	var decodeErr *DecodeError
	if !errors.As(err, &decodeErr) || decodeErr.Code != CodeInvalidJSON {
		t.Fatalf("got %v, expected invalid_json", err)
	}
}

// TestLlmPayloadKept checks that an LLM decoder leaves its input as it is, the cleanup step
// included.
func TestLlmPayloadKept(t *testing.T) {
	input := []byte("```json\n{\"value\": 2,}\n```")
	kept := bytes.Clone(input)
	if _, err := DecodeBoxesFromLlm(input); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(input, kept) {
		t.Fatal("DecodeBoxesFromLlm changed its input")
	}
}
