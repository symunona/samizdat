package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// modelsBox serves the OpenAI-compatible GET /v1/models list — the same shape
// checkPipelineModels cross-checks a pinned step's model id against.
func modelsBox(t *testing.T, ids ...string) *httptest.Server {
	t.Helper()
	var data string
	for i, id := range ids {
		if i > 0 {
			data += ","
		}
		data += `{"id":"` + id + `"}`
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[` + data + `]}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newTestQueries(t *testing.T) *store.Queries {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return store.New(db)
}

// insertPipeline is the minimal InsertPipeline call every case below needs.
func insertPipeline(t *testing.T, q *store.Queries, id, steps string) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := q.InsertPipeline(t.Context(), store.InsertPipelineParams{
		ID: id, Name: "pipeline " + id, Enabled: 1, Trigger: "on_new_document", Filter: "{}",
		Steps: steps, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
}

// This is the exact bug the check exists to catch: a step pinned to a real
// provider, naming a model that provider no longer serves. It must not be
// silently skipped — silence is what let it run 404-and-escalate for days.
func TestCheckPipelineModelsFlagsStaleModel(t *testing.T) {
	srv := modelsBox(t, "qwen3-sum:latest")
	host := mustHost(t, srv.URL)
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "qwen3-sum:latest",
	})
	q := newTestQueries(t)
	insertPipeline(t, q, "p1", `[{"kind":"llm_summarize","config":{"provider":"`+host+`","model":"qwen3:4b-instruct-ctx7k","prompt":"P"}}]`)

	got := checkPipelineModels(t.Context(), q, router)
	if len(got) != 1 {
		t.Fatalf("mismatches = %d, want 1: %+v", len(got), got)
	}
	m := got[0]
	if m.PipelineID != "p1" || m.Model != "qwen3:4b-instruct-ctx7k" || m.Provider != host {
		t.Fatalf("mismatch = %+v", m)
	}
	if m.Reason != "model not found on provider" {
		t.Fatalf("reason = %q", m.Reason)
	}
}

// A step whose pinned model IS on its provider must not be reported — the check
// exists to catch the stale case, not to flag every pin.
func TestCheckPipelineModelsIgnoresLiveModel(t *testing.T) {
	srv := modelsBox(t, "qwen3-sum:latest")
	host := mustHost(t, srv.URL)
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "qwen3-sum:latest",
	})
	q := newTestQueries(t)
	insertPipeline(t, q, "p1", `[{"kind":"llm_summarize","config":{"provider":"`+host+`","model":"qwen3-sum:latest","prompt":"P"}}]`)

	got := checkPipelineModels(t.Context(), q, router)
	if len(got) != 0 {
		t.Fatalf("want no mismatches for a live model, got %+v", got)
	}
}

// A step with no model, or no provider pin, resolves at call time to whatever
// provider serves it and that provider's own default_model — there is nothing
// fixed to check it against, so it must be skipped, not misreported.
func TestCheckPipelineModelsSkipsUnpinnedSteps(t *testing.T) {
	srv := modelsBox(t, "qwen3-sum:latest")
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "qwen3-sum:latest",
	})
	q := newTestQueries(t)
	insertPipeline(t, q, "p1", `[{"kind":"llm_summarize","config":{"prompt":"P"}}]`)
	insertPipeline(t, q, "p2", `[{"kind":"llm_summarize","config":{"model":"qwen3-sum:latest","prompt":"P"}}]`)

	got := checkPipelineModels(t.Context(), q, router)
	if len(got) != 0 {
		t.Fatalf("want no mismatches for unpinned steps, got %+v", got)
	}
}

// A step pinned at a provider id the Router does not know about at all (typo, or
// a box that was removed from config) is its own distinct reason from "model not
// on this provider" — the fix is different (add the provider vs. fix the model).
func TestCheckPipelineModelsFlagsUnknownProvider(t *testing.T) {
	router := llm.NewRouter(config.LLMSection{})
	q := newTestQueries(t)
	insertPipeline(t, q, "p1", `[{"kind":"llm_summarize","config":{"provider":"nowhere:1234","model":"m","prompt":"P"}}]`)

	got := checkPipelineModels(t.Context(), q, router)
	if len(got) != 1 || got[0].Reason != "provider not configured" {
		t.Fatalf("mismatches = %+v", got)
	}
}

// A soft-deleted pipeline is not live config — it must not haunt the check
// forever after being deleted.
func TestCheckPipelineModelsSkipsDeletedPipelines(t *testing.T) {
	srv := modelsBox(t, "qwen3-sum:latest")
	host := mustHost(t, srv.URL)
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "qwen3-sum:latest",
	})
	q := newTestQueries(t)
	insertPipeline(t, q, "p1", `[{"kind":"llm_summarize","config":{"provider":"`+host+`","model":"stale","prompt":"P"}}]`)
	now := time.Now().UTC().Format(time.RFC3339)
	if err := q.SoftDeletePipeline(t.Context(), store.SoftDeletePipelineParams{
		ID: "p1", DeletedAt: strPtr(now), UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	got := checkPipelineModels(t.Context(), q, router)
	if len(got) != 0 {
		t.Fatalf("want no mismatches for a deleted pipeline, got %+v", got)
	}
}

func mustHost(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

func strPtr(s string) *string { return &s }
