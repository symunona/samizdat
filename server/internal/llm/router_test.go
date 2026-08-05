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

// clearLLMEnv isolates a test from whatever keys this box happens to export —
// discovery reads the environment, so without this the results depend on the shell.
func clearLLMEnv(t *testing.T) {
	t.Helper()
	t.Setenv(envAnthropicKey, "")
	t.Setenv(envOpenAIKey, "")
	t.Setenv(envOpenRouterKey, "")
}

// fakeBox answers an OpenAI-compatible completion and counts the calls it served.
func fakeBox(t *testing.T, calls *int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*calls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func findProvider(ps []*Provider, id string) *Provider {
	for _, p := range ps {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// A config section and an env key naming the SAME endpoint are one provider, not
// two — otherwise Settings shows Anthropic twice and the probe pays for it twice.
func TestDiscoverDedupesConfigAndEnv(t *testing.T) {
	clearLLMEnv(t)
	t.Setenv(envAnthropicKey, "sk-env")

	ps := Discover(config.LLMSection{Provider: "anthropic", APIKey: "sk-config"})

	var anthropic int
	for _, p := range ps {
		if p.ID == "anthropic" {
			anthropic++
		}
	}
	if anthropic != 1 {
		t.Fatalf("want 1 anthropic provider, got %d", anthropic)
	}
	p := findProvider(ps, "anthropic")
	if p.Role != "primary" {
		t.Fatalf("config section must win the primary role, got %q", p.Role)
	}
	if p.apiKey != "sk-config" {
		t.Fatalf("config key must beat the env key, got %q", p.apiKey)
	}
	// The well-known local box is always a candidate; the probe decides if it lives.
	if findProvider(ps, "localhost:11434") == nil {
		t.Fatalf("well-known local Ollama missing from discovery: %+v", ps)
	}
}

// A key in the environment makes a provider usable with no config edit — that is
// what puts OpenRouter in the model picker the moment a key exists.
func TestDiscoverAddsEnvOnlyProvider(t *testing.T) {
	clearLLMEnv(t)
	t.Setenv(envOpenRouterKey, "sk-or")

	ps := Discover(config.LLMSection{})
	p := findProvider(ps, "openrouter")
	if p == nil {
		t.Fatalf("openrouter not discovered from its env key: %+v", ps)
	}
	if p.Role != "available" || p.Source != "env" {
		t.Fatalf("want role=available source=env, got role=%q source=%q", p.Role, p.Source)
	}
	if !p.HasKey {
		t.Fatal("env key not picked up")
	}
}

// Pinning is pinning. A step aimed at the local box must fail when the box is
// down, never quietly spend cloud money on the fallback.
func TestRouterPinnedProviderDoesNotFallBack(t *testing.T) {
	clearLLMEnv(t)
	var fallbackCalls int
	backup := fakeBox(t, &fallbackCalls)

	r := NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: "http://127.0.0.1:1/v1", DefaultModel: "dead",
		Fallback: []config.LLMSection{
			{Provider: "openai_compat", BaseURL: backup.URL + "/v1", DefaultModel: "backup"},
		},
	})

	if _, _, err := r.CompleteRoute(context.Background(), Route{Provider: "127.0.0.1:1"}, nil); err == nil {
		t.Fatal("pinned provider is down — want an error, got success")
	}
	if fallbackCalls != 0 {
		t.Fatalf("pinned route reached the fallback %d times", fallbackCalls)
	}

	// The same router, unpinned, DOES fall through — the chain still works.
	if _, _, err := r.CompleteRoute(context.Background(), Route{}, nil); err != nil {
		t.Fatalf("unpinned route should fall through to the backup: %v", err)
	}
	if fallbackCalls != 1 {
		t.Fatalf("fallback served %d calls, want 1", fallbackCalls)
	}
}

// Steps stored a bare transport name before the Router existed ("anthropic",
// "openai_compat"). Those rows are live in the DB and must keep routing.
func TestRouterResolvesLegacyProviderName(t *testing.T) {
	clearLLMEnv(t)
	var calls int
	box := fakeBox(t, &calls)

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: box.URL + "/v1", DefaultModel: "m"})
	if _, _, err := r.CompleteRoute(context.Background(), Route{Provider: "openai_compat"}, nil); err != nil {
		t.Fatalf("legacy transport name did not resolve: %v", err)
	}
	if calls != 1 {
		t.Fatalf("box served %d calls, want 1", calls)
	}
}

// An unknown provider names itself in the error — a silent fall-through to the
// chain would hide a typo'd pin behind a working (and billable) call.
func TestRouterUnknownProviderErrors(t *testing.T) {
	clearLLMEnv(t)
	var calls int
	box := fakeBox(t, &calls)

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: box.URL + "/v1", DefaultModel: "m"})
	_, _, err := r.CompleteRoute(context.Background(), Route{Provider: "typo"}, nil)
	if err == nil || !strings.Contains(err.Error(), "unknown provider") {
		t.Fatalf("want an unknown-provider error, got %v", err)
	}
	if calls != 0 {
		t.Fatalf("unknown pin still called a box %d times", calls)
	}
}

// The catalog groups by provider so a model can only ever be picked for the
// endpoint that serves it.
func TestModelsGroupPerProvider(t *testing.T) {
	clearLLMEnv(t)
	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"id": "qwen3:4b"}, {"id": "gemma3:4b"},
		}})
	}))
	defer box.Close()

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: box.URL + "/v1", DefaultModel: "qwen3:4b"})
	groups := r.Models(context.Background(), true)

	var found *ModelGroup
	for i := range groups {
		if groups[i].ProviderID == hostOf(box.URL) {
			found = &groups[i]
		}
	}
	if found == nil {
		t.Fatalf("no group for the configured box: %+v", groups)
	}
	if len(found.Models) != 2 || found.Models[0].ID != "gemma3:4b" {
		t.Fatalf("want 2 models sorted by id, got %+v", found.Models)
	}
	// A dead provider contributes an error, never an empty picker for everyone else.
	for _, g := range groups {
		if g.ProviderID == "localhost:11434" && g.Error == "" && len(g.Models) == 0 {
			t.Fatal("unreachable provider reported neither models nor an error")
		}
	}
}
