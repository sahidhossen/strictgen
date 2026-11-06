package types

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
)

// TestLlmParallel runs LLM decodes and normal decodes of the same types at the same time. An LLM
// decode reads null for an optional key as absent, which a normal decode must not, so what an
// LLM decode notes belongs to that one decode, never to a variable another goroutine reads. CI
// runs it with -race, which also fails on any shared write.
func TestLlmParallel(t *testing.T) {
	const llmText = `{"name":"Ada","email":null,"contact":null}`
	const normalText = `{"name":"Ada","email":null}`
	const rounds = 200
	var wg sync.WaitGroup
	errs := make(chan error, 8*rounds)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				if g%2 == 0 {
					got, err := DecodeCustomerFromLlm([]byte(llmText))
					if err != nil || got.Email != nil || got.Contact != nil {
						errs <- fmt.Errorf("LLM decode: got %#v, %v", got, err)
					}
					// A failing LLM decode in between leaves nothing behind either.
					if _, err := DecodeCustomerFromLlm([]byte(`{"name":1}`)); err == nil {
						errs <- errors.New("LLM decode of a number for a string: no error")
					}
					continue
				}
				var c Customer
				err := json.Unmarshal([]byte(normalText), &c)
				var decodeErr *DecodeError
				if !errors.As(err, &decodeErr) || decodeErr.Code != CodeNullNotAllowed || decodeErr.Path != "/email" {
					errs <- fmt.Errorf("normal decode: got %v, expected null_not_allowed at /email", err)
				}
			}
		}(g)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}
