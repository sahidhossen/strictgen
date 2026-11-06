// Command conformance-driver decodes conformance requests with the Go code strictgen generates,
// many per process.
//
// It reads one JSON request per line on stdin and writes one JSON result per line on stdout, in
// request order, in the format src/conformance/protocol.ts describes. The runner writes the
// generated packages before it builds the command, and packages.go, which lists them by name.
// Each has a conform.go, also written by the runner, that decodes by type name through the
// package's public entry points (json.Unmarshal, DecodeX, Report[T], ReportX), its fixture
// registry or its LLM decoders (DecodeXFromLlm), and runs its cleanup step (CleanLLMJSON).
package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

// crash is the error code of a decoder that panicked instead of returning an error.
const crash = "crash"

// syntaxError is the error code for a *json.SyntaxError, which json.Unmarshal returns before the
// generated decoder runs when the input isn't JSON.
const syntaxError = "json.SyntaxError"

// generated is one generated package: a decoder and an LLM decoder by type name, its cleanup
// step, and the fields of its DecodeError.
type generated struct {
	decode func(typ, entry string, data []byte) (value any, unknown []string, ok bool, err error)
	llm    func(typ string, data []byte) (value any, ok bool, err error)
	clean  func(data []byte) (out []byte, ok bool)
	fields func(err error) (path, code, expected, found string, ok bool)
}

type request struct {
	ID      *int   `json:"id"`
	Type    string `json:"type"`
	Mode    string `json:"mode"`
	Decoder string `json:"decoder"`
	Entry   string `json:"entry"`
	Package string `json:"package"`
	Hex     string `json:"hex"`
}

type errorFields struct {
	Path     string  `json:"path"`
	Code     string  `json:"code"`
	Expected *string `json:"expected"`
	Found    *string `json:"found"`
	Message  string  `json:"message"`
}

type result struct {
	ID          int          `json:"id"`
	Accepted    bool         `json:"accepted"`
	Error       *errorFields `json:"error"`
	Unknown     []string     `json:"unknown"`
	Encoded     *string      `json:"encoded"`
	EncodeError *string      `json:"encodeError"`
}

// optional is nil for an empty field, which a DecodeError leaves empty when the code has none.
func optional(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// outcome decodes data as typ with one decoder of a package and encodes the value again, or
// runs the package's cleanup step. A panic, in the decoder or the encoder, becomes a result with
// the code crash. found is false when the package has no such type or step.
func outcome(pkg generated, id int, decoder, typ, entry string, data []byte) (r result, found bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			r = result{ID: id, Error: &errorFields{Code: crash, Message: fmt.Sprint(recovered)}}
			found = true
		}
	}()
	var (
		value   any
		unknown []string
		ok      bool
		err     error
	)
	switch decoder {
	case "cleanup":
		cleaned, has := pkg.clean(data)
		if !has {
			return result{}, false
		}
		text := string(cleaned)
		return result{ID: id, Accepted: true, Unknown: []string{}, Encoded: &text}, true
	case "llm":
		// LLM decoders are strict in every read mode, so no key is unknown.
		value, ok, err = pkg.llm(typ, data)
		unknown = []string{}
	default:
		value, unknown, ok, err = pkg.decode(typ, entry, data)
	}
	if !ok {
		return result{}, false
	}
	if err != nil {
		path, code, expected, foundText, isDecodeError := pkg.fields(err)
		if !isDecodeError {
			var syntax *json.SyntaxError
			if errors.As(err, &syntax) {
				return result{ID: id, Error: &errorFields{Code: syntaxError, Message: err.Error()}}, true
			}
			return result{ID: id, Error: &errorFields{Code: crash, Message: "not a *DecodeError: " + err.Error()}}, true
		}
		return result{ID: id, Error: &errorFields{
			Path:     path,
			Code:     code,
			Expected: optional(expected),
			Found:    optional(foundText),
			Message:  err.Error(),
		}}, true
	}
	r = result{ID: id, Accepted: true, Unknown: unknown}
	encoded, err := json.Marshal(value)
	if err != nil {
		why := err.Error()
		r.EncodeError = &why
	} else {
		text := string(encoded)
		r.Encoded = &text
	}
	return r, true
}

// answer reads one request line and returns its result.
func answer(line []byte) (result, error) {
	var req request
	decoder := json.NewDecoder(bytes.NewReader(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return result{}, err
	}
	if req.ID == nil {
		return result{}, errors.New("no id")
	}
	switch req.Decoder {
	case "normal", "llm", "cleanup":
	default:
		return result{}, fmt.Errorf("decoder %q is not supported", req.Decoder)
	}
	if req.Entry != "public" && req.Entry != "registry" {
		return result{}, fmt.Errorf("entry %q is not supported", req.Entry)
	}
	if req.Mode != "strict" && req.Mode != "report" {
		return result{}, fmt.Errorf("mode %q is not supported", req.Mode)
	}
	pkg, ok := packages[req.Package]
	if !ok {
		return result{}, fmt.Errorf("no generated package %q", req.Package)
	}
	data, err := hex.DecodeString(req.Hex)
	if err != nil {
		return result{}, err
	}
	r, found := outcome(pkg, *req.ID, req.Decoder, req.Type, req.Entry, data)
	if !found {
		return result{}, fmt.Errorf("no %s decoder for type %s in package %s", req.Decoder, req.Type, req.Package)
	}
	if r.Accepted && r.Unknown == nil {
		r.Unknown = []string{}
	}
	return r, nil
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "conformance-driver: "+format+"\n", args...)
	os.Exit(2)
}

func main() {
	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	encoder := json.NewEncoder(out)
	encoder.SetEscapeHTML(false)
	for number := 1; ; number++ {
		line, err := in.ReadBytes('\n')
		if err == io.EOF && len(line) == 0 {
			break
		}
		if err != nil && err != io.EOF {
			fail("reading line %d: %v", number, err)
		}
		r, err := answer(bytes.TrimSuffix(line, []byte("\n")))
		if err != nil {
			fail("request on line %d: %v", number, err)
		}
		if err := encoder.Encode(r); err != nil {
			fail("%v", err)
		}
	}
	if err := out.Flush(); err != nil {
		fail("%v", err)
	}
}
