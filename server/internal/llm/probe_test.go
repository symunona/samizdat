package llm

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
)

func probeFor(results []ProbeResult, id string) *ProbeResult {
	for i := range results {
		if results[i].ID == id {
			return &results[i]
		}
	}
	return nil
}

// A local box that answers /models is reachable, needs no key, and has no balance
// to run out of.
func TestProbeLocalBoxIsReachable(t *testing.T) {
	clearLLMEnv(t)
	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "qwen3:4b"}}})
	}))
	defer box.Close()

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: box.URL + "/v1"})
	got := probeFor(r.Probe(context.Background(), false), hostOf(box.URL))
	if got == nil {
		t.Fatal("configured box missing from the probe")
	}
	if !got.Reachable || got.Auth != AuthOK || got.Credits != CreditsNA || got.Models != 1 {
		t.Fatalf("want reachable/ok/n-a/1 model, got %+v", got)
	}
}

// Nothing listening is the ONLY case that means unreachable. A 4xx came back over
// a working connection — the box is up and refused the request.
func TestProbeUnreachableVsRefused(t *testing.T) {
	clearLLMEnv(t)
	refuser := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"invalid api key"}}`))
	}))
	defer refuser.Close()

	r := NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: "http://127.0.0.1:1/v1",
		Fallback: []config.LLMSection{{Provider: "openai_compat", BaseURL: refuser.URL + "/v1"}},
	})
	results := r.Probe(context.Background(), false)

	dead := probeFor(results, "127.0.0.1:1")
	if dead == nil || dead.Reachable || dead.ErrorKind != KindTransport {
		t.Fatalf("dead port: want unreachable/transport, got %+v", dead)
	}
	refused := probeFor(results, hostOf(refuser.URL))
	if refused == nil || !refused.Reachable || refused.Auth != AuthBadKey {
		t.Fatalf("401: want reachable/bad_key, got %+v", refused)
	}
}

// OpenRouter is the one provider that reports a balance without spending it.
func TestProbeOpenRouterReadsCredits(t *testing.T) {
	clearLLMEnv(t)
	t.Setenv(envOpenRouterKey, "sk-or")

	var limitRemaining float64 // 0 = spent
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/models":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "anthropic/claude-haiku-4.5"}}})
		case "/api/v1/key":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{
				"usage": 10.0, "limit": 10.0, "limit_remaining": limitRemaining,
			}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: srv.URL + "/api/v1", APIKey: "sk-or"})
	// The flavor is decided by host, so point the probe at this server by ID.
	got := probeFor(r.Probe(context.Background(), false), hostOf(srv.URL))
	if got == nil {
		t.Fatalf("test server missing from the probe")
	}
	// A local-flavored host reports n/a credits; the OpenRouter path is exercised
	// directly below, where the flavor is what is under test.
	if got.Credits != CreditsNA {
		t.Fatalf("an unrecognized host is local-flavored: want n/a credits, got %+v", got)
	}

	or := &Provider{ID: "openrouter", Transport: transportOpenAI, Flavor: flavorOpenRouter,
		BaseURL: srv.URL + "/api/v1", apiKey: "sk-or", HasKey: true, NeedsKey: true}
	res := ProbeResult{Auth: AuthOK, Credits: CreditsUnknown}
	r.fillOpenRouterCredits(context.Background(), or, &res)
	if res.Credits != CreditsExhausted {
		t.Fatalf("limit_remaining=0 must read exhausted, got %+v", res)
	}

	limitRemaining = 6.5
	res = ProbeResult{Auth: AuthOK, Credits: CreditsUnknown}
	r.fillOpenRouterCredits(context.Background(), or, &res)
	if res.Credits != CreditsOK || res.CreditsNote == "" {
		t.Fatalf("headroom left must read ok with the numbers, got %+v", res)
	}
}

// Anthropic answers a spent balance with a plain 400, so only a real call settles
// it. A deep probe spends one token and reports exhausted, not "bad request".
func TestProbeDeepDetectsExhaustedCredits(t *testing.T) {
	clearLLMEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "claude-haiku-4-5-20251001"}}})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"Your credit balance is too low to access the Anthropic API"}}`))
	}))
	defer srv.Close()
	anthropicBaseURL = srv.URL
	t.Cleanup(func() { anthropicBaseURL = "https://api.anthropic.com" })

	r := NewRouter(config.LLMSection{Provider: "anthropic", APIKey: "sk-test"})

	shallow := probeFor(r.Probe(context.Background(), false), "anthropic")
	if shallow == nil || shallow.Auth != AuthOK {
		t.Fatalf("key lists models — want auth ok, got %+v", shallow)
	}

	deep := probeFor(r.Probe(context.Background(), true), "anthropic")
	if deep.Credits != CreditsExhausted {
		t.Fatalf("deep ping on a spent balance must read exhausted, got %+v", deep)
	}
	if deep.ErrorKind != KindQuota {
		t.Fatalf("a 400 saying 'credit balance' is quota, not api: %+v", deep)
	}
}

// A provider with no key says so — and is never contacted, so it must not claim
// reachability it never established.
func TestProbeMissingKeyDoesNotGuess(t *testing.T) {
	clearLLMEnv(t)
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{}})
	}))
	defer srv.Close()
	anthropicBaseURL = srv.URL
	t.Cleanup(func() { anthropicBaseURL = "https://api.anthropic.com" })

	r := NewRouter(config.LLMSection{Provider: "anthropic"})
	got := probeFor(r.Probe(context.Background(), false), "anthropic")
	if got == nil || got.Auth != AuthMissingKey {
		t.Fatalf("want missing_key, got %+v", got)
	}
	if got.Reachable {
		t.Fatalf("never contacted, must not read reachable: %+v", got)
	}
	if hits != 0 {
		t.Fatalf("probed %d times with no key to probe with", hits)
	}
}
