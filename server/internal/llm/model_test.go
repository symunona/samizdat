package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
)

// fakeOllama answers an OpenAI-compatible completion and records the model asked for.
func fakeOllama(t *testing.T, got *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		*got = body.Model
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}`))
	}))
}

// A step that names no model must reach the local box asking for the model that
// box actually has — a Claude id here is a 404, and a 404 never falls back.
func TestOpenAICompatUsesSectionDefaultModel(t *testing.T) {
	var got string
	srv := fakeOllama(t, &got)
	defer srv.Close()

	c := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "gemma3:4b"})
	_, usage, err := c.Complete(context.Background(), "", nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if got != "gemma3:4b" {
		t.Fatalf("model sent: want gemma3:4b, got %q", got)
	}
	if usage.Model != "gemma3:4b" {
		t.Fatalf("usage.Model: want gemma3:4b, got %q", usage.Model)
	}
}

func TestExplicitModelBeatsDefault(t *testing.T) {
	var got string
	srv := fakeOllama(t, &got)
	defer srv.Close()

	c := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "gemma3:4b"})
	if _, _, err := c.Complete(context.Background(), "qwen2.5:3b", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if got != "qwen2.5:3b" {
		t.Fatalf("model sent: want qwen2.5:3b, got %q", got)
	}
}

// No model anywhere: a local box serves only what was pulled onto it, so guessing
// is worse than saying which config knob is missing.
func TestOpenAICompatNoModelIsAnError(t *testing.T) {
	var got string
	srv := fakeOllama(t, &got)
	defer srv.Close()

	c := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: srv.URL + "/v1"})
	_, _, err := c.Complete(context.Background(), "", nil)
	if err == nil || !strings.Contains(err.Error(), "default_model") {
		t.Fatalf("want a 'set llm.default_model' error, got %v", err)
	}
	if got != "" {
		t.Fatalf("must not call the box without a model, sent %q", got)
	}
}

// A local primary + cloud fallback: each entry must be asked for ITS own model.
func TestFallbackChainResolvesPerProviderModels(t *testing.T) {
	var localModel string
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		localModel = body.Model
		w.WriteHeader(http.StatusBadGateway) // box up but wedged → transport → fall through
	}))
	defer local.Close()

	r := NewRouter(config.LLMSection{
		Provider:     "openai_compat",
		BaseURL:      local.URL + "/v1",
		DefaultModel: "gemma3:4b",
		Fallback: []config.LLMSection{
			{Provider: "anthropic", APIKey: "k", DefaultModel: "claude-haiku-4-5-20251001"},
		},
	})

	fc, ok := r.chain.(*fallbackClient)
	if !ok {
		t.Fatalf("want a fallback chain, got %T", r.chain)
	}
	// Swap the cloud leg for a stub — the point is the model each leg is asked for,
	// not a real Anthropic call.
	stub := &stubClient{name: "anthropic"}
	fc.entries[1].client = stub

	if _, usage, err := fc.Complete(context.Background(), "", nil); err != nil {
		t.Fatalf("want the fallback to serve, got %v", err)
	} else if usage.Provider != "anthropic" {
		t.Fatalf("served by %q, want anthropic", usage.Provider)
	}
	if localModel != "gemma3:4b" {
		t.Fatalf("local leg asked for %q, want gemma3:4b", localModel)
	}
	if stub.gotModel != "claude-haiku-4-5-20251001" {
		t.Fatalf("cloud leg asked for %q, want claude-haiku-4-5-20251001", stub.gotModel)
	}
}
