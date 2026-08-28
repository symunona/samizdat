package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// stubLLMBox serves the OpenAI-compatible completion surface and records the
// message it was handed, so the composition (master prompt + prompt) is asserted
// on the wire rather than trusted.
func stubLLMBox(t *testing.T, got *string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if len(body.Messages) > 0 {
			*got = body.Messages[0].Content
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"stub-model","choices":[{"message":{"content":"stub reply"}}],` +
			`"usage":{"prompt_tokens":7,"completion_tokens":3}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func askHandler(t *testing.T, baseURL string) (*llmStatusHandler, *store.Queries) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	q := store.New(db)
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: baseURL + "/v1", APIKey: "k", DefaultModel: "stub-model",
	})
	return &llmStatusHandler{q: q, router: router}, q
}

// An ad-hoc ask routes through the Router, prepends the master prompt to the user
// message (there is no system role — Anthropic's API takes none) and lands one
// row in the same ledger a pipeline call writes to.
func TestAskRoutesAndMeters(t *testing.T) {
	var sent string
	srv := stubLLMBox(t, &sent)
	h, q := askHandler(t, srv.URL)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/llm/ask",
		strings.NewReader(`{"prompt":"explain this","system":"you are terse"}`))
	rec := httptest.NewRecorder()
	h.ask(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var out askResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Reply != "stub reply" {
		t.Fatalf("reply = %q", out.Reply)
	}
	if out.TokensIn != 7 || out.TokensOut != 3 {
		t.Fatalf("tokens = %d/%d, want 7/3", out.TokensIn, out.TokensOut)
	}
	if sent != "you are terse\n\nexplain this" {
		t.Fatalf("composed message = %q", sent)
	}

	totals, err := q.GetLLMUsageTotals(req.Context())
	if err != nil {
		t.Fatal(err)
	}
	if totals.TotalCalls != 1 {
		t.Fatalf("ledger rows = %d, want 1 (an ad-hoc ask spends real money too)", totals.TotalCalls)
	}
}

func TestAskRejectsEmptyPrompt(t *testing.T) {
	var sent string
	srv := stubLLMBox(t, &sent)
	h, _ := askHandler(t, srv.URL)

	rec := httptest.NewRecorder()
	h.ask(rec, httptest.NewRequest(http.MethodPost, "/api/v1/llm/ask", strings.NewReader(`{"prompt":"  "}`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if sent != "" {
		t.Fatal("an empty prompt must never reach a provider")
	}
}

// Nothing configured must read as "no provider", not as a gateway failure — the
// popout tells the user to configure one.
func TestAskWithoutProvider(t *testing.T) {
	// Discovery treats a bare env key as a configured primary, so "nothing
	// configured" only exists with the environment cleared.
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")

	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	h := &llmStatusHandler{q: store.New(db), router: llm.NewRouter(config.LLMSection{})}

	rec := httptest.NewRecorder()
	h.ask(rec, httptest.NewRequest(http.MethodPost, "/api/v1/llm/ask", strings.NewReader(`{"prompt":"hi"}`)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
