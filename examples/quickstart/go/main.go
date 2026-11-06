// Command decode decodes each file given as an Order and prints what happened. The first
// argument picks the decoder: json for the normal one, llm for the one that reads a model's
// answer.
//
//	go run . json ../payloads/zero-quantity.json
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"example.com/strictgen/quickstart/types"
)

// lines gives the lines printed for one decode: the value written again, or the error.
func lines(order types.Order, err error) []string {
	var decodeErr *types.DecodeError
	if errors.As(err, &decodeErr) {
		return []string{"error " + decodeErr.Error(), "compact " + decodeErr.Compact()}
	}
	if err != nil {
		return []string{"error " + err.Error()}
	}
	out, err := json.Marshal(order)
	if err != nil {
		return []string{"encode error " + err.Error()}
	}
	return []string{"ok " + string(out)}
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: decode json|llm <file>...")
		os.Exit(2)
	}
	decoder := os.Args[1]
	for _, file := range os.Args[2:] {
		data, err := os.ReadFile(file)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		// docs:start decode
		var order types.Order
		if decoder == "llm" {
			order, err = types.DecodeOrderFromLlm(data)
		} else {
			err = json.Unmarshal(data, &order)
		}
		// docs:end decode
		fmt.Println("file " + file)
		for _, line := range lines(order, err) {
			fmt.Println(line)
		}
	}
}
