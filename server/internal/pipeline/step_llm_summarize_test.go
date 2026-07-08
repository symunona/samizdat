package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/symunona/samizdat/server/internal/llm"
)

// summarizeStub is a canned llm.Client: it returns a fixed reply so the summarize
// step is exercised without a real provider.
type summarizeStub struct{ reply string }

func (s summarizeStub) Complete(_ context.Context, _ string, _ []llm.Message) (string, llm.Usage, error) {
	return s.reply, llm.Usage{Provider: "stub"}, nil
}

// TestLLMSummarizeFalseParseToken: when the model emits the NOT_PARSEABLE
// sentinel, the step must flag the Document, fail with a *FalseParseError, and
// create NO highlight.
func TestLLMSummarizeFalseParseToken(t *testing.T) {
	ctx, q, run := setupRun(t)

	_, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), summarizeStub{reply: notParseableToken})
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

	_, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), summarizeStub{reply: "- **foxes** run fast, matters for speed"})
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
