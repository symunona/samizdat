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

// anthropicCompletion is a canned Messages API reply.
var anthropicCompletion = map[string]any{
	"content": []map[string]string{{"type": "text", "text": "ok"}},
	"usage":   map[string]int{"input_tokens": 5, "output_tokens": 2},
}

// Haiku 5.5 thinks unless told not to and 400s on a non-default temperature: it
// is sent thinking:disabled, never the step's temperature, and Usage says so.
func TestAnthropicHaiku55DisablesThinkingAndDropsTemp(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, anthropicCompletion, &sent)

	temp := 0.2
	c := &anthropicClient{apiKey: "k", defaultModel: "claude-haiku-5-5", baseURL: srv.URL}
	_, u, err := c.Complete(context.Background(), Params{Temp: &temp}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if th, _ := sent["thinking"].(map[string]any); th["type"] != "disabled" || len(th) != 1 {
		t.Fatalf("thinking on the wire: %v", sent["thinking"])
	}
	if _, ok := sent["temperature"]; ok {
		t.Fatalf("temperature must not reach claude-haiku-5-5, got %v", sent["temperature"])
	}
	if u.Temp != nil {
		t.Fatalf("Usage must report the temperature unsent, got %v", *u.Temp)
	}
	if _, ok := sent["output_config"]; ok {
		t.Fatalf("no ReplySchema, no output_config: got %v", sent["output_config"])
	}
}

// Haiku 4.5 keeps the request it always had: the temperature it was given, and
// no thinking or output_config field even when a schema rides the Params.
func TestAnthropicHaiku45RequestUnchanged(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, anthropicCompletion, &sent)

	temp := 0.2
	c := &anthropicClient{apiKey: "k", defaultModel: "claude-haiku-4-5-20251001", baseURL: srv.URL}
	_, u, err := c.Complete(context.Background(), Params{Temp: &temp, ReplySchema: json.RawMessage(`{"type":"object"}`)}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if sent["temperature"] != 0.2 || u.Temp == nil || *u.Temp != 0.2 {
		t.Fatalf("temperature: wire %v, usage %v", sent["temperature"], u.Temp)
	}
	for _, k := range []string{"thinking", "output_config"} {
		if _, ok := sent[k]; ok {
			t.Fatalf("%s must not reach claude-haiku-4-5-20251001, got %v", k, sent[k])
		}
	}
}

// A ReplySchema reaches Haiku 5.5 as output_config.format, verbatim.
func TestAnthropicHaiku55SendsReplySchema(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, anthropicCompletion, &sent)

	schema := `{"type":"object","additionalProperties":false,"required":["a"],"properties":{"a":{"type":"string"}}}`
	c := &anthropicClient{apiKey: "k", baseURL: srv.URL}
	if _, _, err := c.Complete(context.Background(), Params{Model: "claude-haiku-5-5", ReplySchema: json.RawMessage(schema)}, nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	oc, _ := sent["output_config"].(map[string]any)
	format, _ := oc["format"].(map[string]any)
	got, _ := json.Marshal(format["schema"])
	var want any
	_ = json.Unmarshal([]byte(schema), &want)
	wantJSON, _ := json.Marshal(want)
	if format["type"] != "json_schema" || string(got) != string(wantJSON) {
		t.Fatalf("output_config on the wire: %v", sent["output_config"])
	}
}

// An endpoint with no default_model serves the built-in one.
func TestAnthropicBuiltInDefaultModel(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, anthropicCompletion, &sent)

	c := &anthropicClient{apiKey: "k", baseURL: srv.URL}
	_, u, err := c.Complete(context.Background(), Params{}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if sent["model"] != "claude-haiku-5-5" || u.Model != "claude-haiku-5-5" {
		t.Fatalf("default model: wire %v, usage %q", sent["model"], u.Model)
	}
}

// Haiku 5.5 bills the whole call at the long rate once the prompt passes 100K.
func TestEstimateCostLongPromptTier(t *testing.T) {
	if got := EstimateCost("claude-haiku-5-5", 100_000, 1_000_000); got != 0.01+0.50 {
		t.Fatalf("at 100K: %v", got)
	}
	if got := EstimateCost("claude-haiku-5-5", 200_000, 1_000_000); got != 0.10+2.50 {
		t.Fatalf("over 100K: %v", got)
	}
	if got := EstimateCost("claude-haiku-4-5", 200_000, 0); got != 0.20 {
		t.Fatalf("flat rate: %v", got)
	}
}
