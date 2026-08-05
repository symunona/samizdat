package pipeline

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
)

// stubRouter is a Router pointed at a fake OpenAI-compatible box that answers
// with reply. Steps take a Router, not a Client, so the test drives the same
// resolution path production does.
func stubRouter(t *testing.T, reply string) *llm.Router {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"choices": []map[string]any{{"message": map[string]string{"content": reply}}},
		"usage":   map[string]int{"prompt_tokens": 7, "completion_tokens": 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: srv.URL + "/v1", DefaultModel: "stub",
	})
}

// TestLLMSummarizeFalseParseToken: when the model emits the NOT_PARSEABLE
// sentinel, the step must flag the Document, fail with a *FalseParseError, and
// create NO highlight.
func TestLLMSummarizeFalseParseToken(t *testing.T) {
	ctx, q, run := setupRun(t)

	_, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), stubRouter(t, notParseableToken))
	var fpe *FalseParseError
	if !errors.As(err, &fpe) {
		t.Fatalf("want *FalseParseError, got %v", err)
	}
	if fpe.Reason != ReasonUnparseable {
		t.Fatalf("want reason %q, got %q", ReasonUnparseable, fpe.Reason)
	}
	if got := countHighlights(t, ctx, q, run); got != 0 {
		t.Fatalf("want 0 highlights on false parse, got %d", got)
	}
	doc, _ := q.GetDocumentByID(ctx, run.DocumentID)
	if doc.ErrorReason != ReasonUnparseable {
		t.Fatalf("document error_reason = %q, want %q", doc.ErrorReason, ReasonUnparseable)
	}
}

// TestLLMSummarizeNormalControl: a genuine reply produces exactly one highlight
// and leaves the Document unflagged (detection isn't over-eager).
func TestLLMSummarizeNormalControl(t *testing.T) {
	ctx, q, run := setupRun(t)

	_, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), stubRouter(t, "- **foxes** run fast, matters for speed"))
	if err != nil {
		t.Fatalf("normal summarize: %v", err)
	}
	if got := countHighlights(t, ctx, q, run); got != 1 {
		t.Fatalf("want 1 highlight, got %d", got)
	}
	doc, _ := q.GetDocumentByID(ctx, run.DocumentID)
	if doc.ErrorReason != "" {
		t.Fatalf("document should not be flagged, error_reason = %q", doc.ErrorReason)
	}
}
