package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

// The red-dot contract. A local box is the flavor most likely to blip (a cold
// model load past the 90s cap), and the passive registry cannot clear itself —
// only a real completion writes LastOKAt. So a DEEP probe has to ping a local
// provider, not just the cloud ones it was originally written for.
func TestDeepProbeClearsStaleHealthOnLocalBox(t *testing.T) {
	clearLLMEnv(t)
	resetHealth()
	defer resetHealth()

	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/chat/completions") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{{"message": map[string]any{"content": "ok"}}},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "qwen3:4b"}}})
	}))
	defer box.Close()

	// The stale red state: one failed call, nothing since.
	Record(transportOpenAI, box.URL+"/v1", transportErr(errors.New("context deadline exceeded")))
	key := ProviderKey(transportOpenAI, box.URL+"/v1")
	before := healthFor(t, key)
	if !before.LastErrorAt.After(before.LastOKAt) {
		t.Fatal("setup: want a red row (last_error_at after last_ok_at)")
	}

	r := NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: box.URL + "/v1", DefaultModel: "qwen3:4b",
	})
	got := probeFor(r.Probe(context.Background(), true), hostOf(box.URL))
	if got == nil || !got.Reachable {
		t.Fatalf("want a reachable result, got %+v", got)
	}
	// A local box has no balance, so the ping must not invent credits for it.
	if got.Credits != CreditsNA {
		t.Fatalf("local box credits = %q, want %q", got.Credits, CreditsNA)
	}

	after := healthFor(t, key)
	if !after.LastOKAt.After(after.LastErrorAt) {
		t.Fatalf("deep probe left the row red: ok=%v err=%v", after.LastOKAt, after.LastErrorAt)
	}
}

// The other half of the same contract: health.go stays passive. A SHALLOW probe
// renders in Settings, so it must never write a health row — otherwise the dot
// would report "the /models endpoint answered", not "a completion worked".
func TestShallowProbeRecordsNoHealth(t *testing.T) {
	clearLLMEnv(t)
	resetHealth()
	defer resetHealth()

	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "qwen3:4b"}}})
	}))
	defer box.Close()

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: box.URL + "/v1"})
	r.Probe(context.Background(), false)

	if snap := Snapshot(); len(snap) != 0 {
		t.Fatalf("shallow probe wrote %d health rows, want 0: %+v", len(snap), snap)
	}
}

// healthFor returns the registry row for key, failing the test when absent.
func healthFor(t *testing.T, key string) ProviderHealth {
	t.Helper()
	for _, h := range Snapshot() {
		if h.Key == key {
			return h
		}
	}
	t.Fatalf("no health row for %q", key)
	return ProviderHealth{}
}

// A DISCOVERED box (the well-known localhost Ollama) is configured nowhere, so it
// has no default_model. Complete would refuse before the wire and Record would
// paint a working box red — the deep ping borrows a model the box just listed.
func TestDeepProbeBorrowsListedModelWhenNoDefault(t *testing.T) {
	clearLLMEnv(t)
	resetHealth()
	defer resetHealth()

	var asked string
	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/chat/completions") {
			var body struct {
				Model string `json:"model"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			asked = body.Model
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{{"message": map[string]any{"content": "ok"}}},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "granite4.1:3b"}}})
	}))
	defer box.Close()

	r := NewRouter(config.LLMSection{Provider: "openai_compat", BaseURL: box.URL + "/v1"})
	got := probeFor(r.Probe(context.Background(), true), hostOf(box.URL))
	if got == nil || got.Error != "" {
		t.Fatalf("want a clean result, got %+v", got)
	}
	if asked != "granite4.1:3b" {
		t.Fatalf("pinged with model %q, want the listed one", asked)
	}
	h := healthFor(t, ProviderKey(transportOpenAI, box.URL+"/v1"))
	if h.LastOKAt.IsZero() {
		t.Fatal("deep ping did not record a healthy call")
	}
}
