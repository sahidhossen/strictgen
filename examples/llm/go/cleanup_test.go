package types

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestCleanupVectors runs the shared cleanup vectors through CleanLLMJSON. Rust and TypeScript
// run the same file, so the three languages clean every input to the same output.
func TestCleanupVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "cleanup-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	// A misspelled key would leave a vector half read, so only these keys are allowed.
	decoder.DisallowUnknownFields()
	var vectors []struct {
		Name   *string `json:"name"`
		Input  *string `json:"input"`
		Output *string `json:"output"`
	}
	if err := decoder.Decode(&vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) <= 40 {
		t.Fatalf("expected the full set of vectors, found %d", len(vectors))
	}
	for i, v := range vectors {
		if v.Name == nil || v.Input == nil || v.Output == nil {
			t.Fatalf("vector %d needs name, input and output", i)
		}
		t.Run(*v.Name, func(t *testing.T) {
			input := []byte(*v.Input)
			kept := bytes.Clone(input)
			got := CleanLLMJSON(input)
			if string(got) != *v.Output {
				t.Fatalf("got %q, expected %q", got, *v.Output)
			}
			if !bytes.Equal(input, kept) {
				t.Fatal("CleanLLMJSON changed its input")
			}
		})
	}
}
