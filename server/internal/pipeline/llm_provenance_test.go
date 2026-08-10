package pipeline

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
)

// recordingRouter is stubRouter that also hands back the request body the box saw,
// so a test can assert the step's params reached the wire.
func recordingRouter(t *testing.T, reply string, sent *map[string]any) *llm.Router {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"choices": []map[string]any{{"message": map[string]string{"content": reply}}},
		"usage":   map[string]int{"prompt_tokens": 7, "completion_tokens": 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(sent)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "stub",
	})
}

// A summary highlight must carry the provenance of the call that wrote it — the
// model/provider that actually SERVED it (the step named none), the params that
// went on the wire, and the token counts.
func TestSummaryHighlightCarriesProvenance(t *testing.T) {
	ctx, q, run := setupRun(t)
	var sent map[string]any

	cfg := json.RawMessage(`{"max_tokens":512,"temperature":0.25}`)
	if _, err := handleLLMSummarize(ctx, q, run, cfg, recordingRouter(t, "- **foxes** run fast", &sent)); err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if sent["max_tokens"] != float64(512) || sent["temperature"] != 0.25 {
		t.Fatalf("step params never reached the box: %v", sent)
	}

	hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if err != nil || len(hs) != 1 {
		t.Fatalf("want 1 highlight, got %d (%v)", len(hs), err)
	}
	var p highlightProvenance
	if err := json.Unmarshal([]byte(hs[0].Metadata), &p); err != nil {
		t.Fatalf("metadata %q: %v", hs[0].Metadata, err)
	}
	// The step config named no model: what ran is the box's default, not "".
	if p.Model != "stub" || p.Provider == "" {
		t.Fatalf("served model/provider = %q/%q", p.Model, p.Provider)
	}
	if p.Step != kindLLMSummarize {
		t.Fatalf("step = %q", p.Step)
	}
	if p.MaxTokens != 512 || p.Temp == nil || *p.Temp != 0.25 {
		t.Fatalf("params: max=%d temp=%v", p.MaxTokens, p.Temp)
	}
	if p.TokensIn != 7 || p.TokensOut != 3 {
		t.Fatalf("tokens: in=%d out=%d", p.TokensIn, p.TokensOut)
	}
	if p.PromptSHA == "" {
		t.Fatal("prompt_sha missing — a summary can't be dated against a prompt change")
	}

	// The ledger row is written too, and exactly once per call (COALESCE(SUM(…))
	// comes back as an untyped value, so the counts are compared as text).
	totals, err := q.GetLLMUsageTotals(ctx)
	if err != nil {
		t.Fatalf("usage totals: %v", err)
	}
	if totals.TotalCalls != 1 ||
		fmt.Sprint(totals.TotalInputTokens) != "7" || fmt.Sprint(totals.TotalOutputTokens) != "3" {
		t.Fatalf("ledger: %+v", totals)
	}
}

// Unset params must stay unset all the way to the metadata: an omitted knob means
// "the endpoint's own default", and printing an invented number would read as a
// setting the user chose.
func TestProvenanceOmitsUnsetParams(t *testing.T) {
	ctx, q, run := setupRun(t)
	var sent map[string]any

	if _, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), recordingRouter(t, "- **foxes** run fast", &sent)); err != nil {
		t.Fatalf("summarize: %v", err)
	}
	hs, _ := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if len(hs) != 1 {
		t.Fatalf("want 1 highlight, got %d", len(hs))
	}
	var raw map[string]any
	if err := json.Unmarshal([]byte(hs[0].Metadata), &raw); err != nil {
		t.Fatalf("metadata %q: %v", hs[0].Metadata, err)
	}
	if _, ok := raw["max_tokens"]; ok {
		t.Fatalf("max_tokens must be absent, got %v", raw["max_tokens"])
	}
	if _, ok := raw["temperature"]; ok {
		t.Fatalf("temperature must be absent, got %v", raw["temperature"])
	}
}

// The prompt fingerprint tracks the TEMPLATE, so two runs of the same step over
// different documents share it — otherwise it could not answer "was this summary
// made before I changed the prompt?".
func TestPromptSHATracksTemplateNotDocument(t *testing.T) {
	if a, b := promptSHA("x"), promptSHA("x"); a != b {
		t.Fatalf("same template must hash the same: %q vs %q", a, b)
	}
	if a, b := promptSHA("x"), promptSHA("y"); a == b {
		t.Fatalf("different templates must differ: %q", a)
	}
	if promptSHA("") != "" {
		t.Fatal("no prompt = no fingerprint")
	}
}

// A pinned step names its endpoint, and a pin never falls back — so the highlight
// must say WHICH box served it, not just which protocol. The ledger keeps the
// transport name (llm_status aggregates spend by it).
func TestPinnedProviderNamesTheEndpoint(t *testing.T) {
	ctx, q, run := setupRun(t)
	var sent map[string]any
	router := recordingRouter(t, "- **foxes** run fast", &sent)

	// Providers() is in routing order, so [0] is the configured primary — the
	// recording box. (Discovery also offers the well-known localhost Ollama, which
	// is not listening in a test.)
	pinned := router.Providers()[0].ID
	cfg := json.RawMessage(`{"provider":"` + pinned + `"}`)
	if _, err := handleLLMSummarize(ctx, q, run, cfg, router); err != nil {
		t.Fatalf("summarize: %v", err)
	}

	hs, _ := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if len(hs) != 1 {
		t.Fatalf("want 1 highlight, got %d", len(hs))
	}
	var p highlightProvenance
	if err := json.Unmarshal([]byte(hs[0].Metadata), &p); err != nil {
		t.Fatalf("metadata %q: %v", hs[0].Metadata, err)
	}
	if p.Provider != pinned {
		t.Fatalf("provenance provider = %q, want the pinned endpoint %q", p.Provider, pinned)
	}
	byProv, err := q.GetLLMUsageTotalsByProviderModel(ctx)
	if err != nil || len(byProv) != 1 {
		t.Fatalf("ledger rows = %d (%v)", len(byProv), err)
	}
	if byProv[0].Provider != "openai_compat" {
		t.Fatalf("ledger provider = %q, want the transport name spend aggregates by", byProv[0].Provider)
	}
}
