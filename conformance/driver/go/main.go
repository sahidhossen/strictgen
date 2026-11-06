// Command conformance-driver decodes conformance requests with the Go code strictgen generates,
// many per process.
//
// It reads one JSON request per line on stdin and writes one JSON result per line on stdout, in
// request order, in the format src/conformance/protocol.ts describes. The runner writes the
// generated packages, strict and report, before it builds the command. Each has a conform.go,
// also written by the runner, that decodes by type name through the package's fixture registry.
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

	"conformance/report"
	"conformance/strict"
)

// crash is the error code of a decoder that panicked instead of returning an error.
const crash = "crash"

// readMode is one generated package: a decoder by type name, and the fields of its DecodeError.
type readMode struct {
	decode func(typ string, data []byte) (value any, unknown []string, ok bool, err error)
	fields func(err error) (path, code, expected, found string, ok bool)
}

var modes = map[string]readMode{
	"strict": {strict.ConformanceDecode, strict.ConformanceFields},
	"report": {report.ConformanceDecode, report.ConformanceFields},
}

type request struct {
	ID      *int   `json:"id"`
	Type    string `json:"type"`
	Mode    string `json:"mode"`
	Decoder string `json:"decoder"`
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

// outcome decodes data as typ in one read mode and encodes the value again. A panic, in the
// decoder or the encoder, becomes a result with the code crash. found is false when the mode
// has no such type.
func outcome(mode readMode, id int, typ string, data []byte) (r result, found bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			r = result{ID: id, Error: &errorFields{Code: crash, Message: fmt.Sprint(recovered)}}
			found = true
		}
	}()
	value, unknown, ok, err := mode.decode(typ, data)
	if !ok {
		return result{}, false
	}
	if err != nil {
		path, code, expected, foundText, isDecodeError := mode.fields(err)
		if !isDecodeError {
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
	if req.Decoder != "normal" {
		return result{}, fmt.Errorf("decoder %q is not supported", req.Decoder)
	}
	mode, ok := modes[req.Mode]
	if !ok {
		return result{}, fmt.Errorf("mode %q is not supported", req.Mode)
	}
	data, err := hex.DecodeString(req.Hex)
	if err != nil {
		return result{}, err
	}
	r, found := outcome(mode, *req.ID, req.Type, data)
	if !found {
		return result{}, fmt.Errorf("no generated type %s", req.Type)
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
