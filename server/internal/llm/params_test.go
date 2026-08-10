package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// captureBody serves a canned completion and hands the request body back.
func captureBody(t *testing.T, resp any, got *map[string]any) *httptest.Server {
	t.Helper()
	body, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// An openai-compatible box must receive the params it was given, and report them
// back as the effective ones.
func TestOpenAICompatSendsParams(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, map[string]any{
		"choices": []map[string]any{{"message": map[string]string{"content": "ok"}}},
		"usage":   map[string]int{"prompt_tokens": 7, "completion_tokens": 3},
	}, &sent)

	temp := 0.25
	c := &openAICompatClient{baseURL: srv.URL + "/v1", defaultModel: "gemma3:4b"}
	_, u, err := c.Complete(context.Background(), Params{MaxTokens: 512, Temp: &temp}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if sent["max_tokens"] != float64(512) || sent["temperature"] != 0.25 {
		t.Fatalf("params on the wire: %v", sent)
	}
	if u.MaxTokens != 512 || u.Temp == nil || *u.Temp != 0.25 {
		t.Fatalf("effective params: max=%d temp=%v", u.MaxTokens, u.Temp)
	}
}

// Unset params must NOT reach a local box: it has its own Modelfile defaults, and
// an invented number would silently override them. Usage reports "not set".
func TestOpenAICompatOmitsUnsetParams(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, map[string]any{
		"choices": []map[string]any{{"message": map[string]string{"content": "ok"}}},
		"usage":   map[string]int{"prompt_tokens": 1, "completion_tokens": 1},
	}, &sent)

	c := &openAICompatClient{baseURL: srv.URL + "/v1", defaultModel: "gemma3:4b"}
	_, u, err := c.Complete(context.Background(), Params{}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if _, ok := sent["max_tokens"]; ok {
		t.Fatalf("max_tokens must be omitted, got %v", sent["max_tokens"])
	}
	if _, ok := sent["temperature"]; ok {
		t.Fatalf("temperature must be omitted, got %v", sent["temperature"])
	}
	if u.MaxTokens != 0 || u.Temp != nil {
		t.Fatalf("unset params must report unset, got max=%d temp=%v", u.MaxTokens, u.Temp)
	}
}

// Anthropic's max_tokens is mandatory, so an unset one has a real effective value
// (4096) — that IS what served the call and the provenance must say so.
func TestAnthropicReportsDefaultMaxTokens(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, map[string]any{
		"content": []map[string]string{{"type": "text", "text": "ok"}},
		"usage":   map[string]int{"input_tokens": 5, "output_tokens": 2},
	}, &sent)

	c := &anthropicClient{apiKey: "k", defaultModel: "claude-haiku-4-5-20251001", baseURL: srv.URL}
	_, u, err := c.Complete(context.Background(), Params{}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if sent["max_tokens"] != float64(anthropicDefaultMaxTokens) {
		t.Fatalf("max_tokens on the wire: %v", sent["max_tokens"])
	}
	if _, ok := sent["temperature"]; ok {
		t.Fatalf("temperature must be omitted when unset, got %v", sent["temperature"])
	}
	if u.MaxTokens != anthropicDefaultMaxTokens {
		t.Fatalf("effective max_tokens = %d", u.MaxTokens)
	}
}
