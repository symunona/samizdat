package pipeline

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
)

// truncatingBox always answers with finish_reason: "length" — the completion cap
// cut it off — and counts how many times it was called, so a test can assert a
// strict step fails FAST instead of burning every retry on an identical cap.
type truncatingBox struct {
	mu    sync.Mutex
	calls int
	reply string
}

func newTruncatingBox(t *testing.T, reply string) (*truncatingBox, string) {
	t.Helper()
	b := &truncatingBox{reply: reply}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b.mu.Lock()
		b.calls++
		b.mu.Unlock()
		body, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]string{"content": b.reply},
				"finish_reason": "length",
			}},
			"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 1024},
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return b, srv.URL + "/v1"
}

func (b *truncatingBox) count() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.calls
}

// truncatingRouter routes through a box that always reports finish_reason:
// "length", with max_tries raised so a fail-fast bug (retrying an identical cap)
// would be visible as extra calls rather than masked by a tries=1 config. Bands
// are sized so any document at least a couple hundred runes long lands on the
// `big` role in one call — the shape of the real incident (job 461fce04).
func truncatingRouter(baseURL string, maxTries int) *llm.Router {
	lim := config.DefaultSummarize().SummarizeLimits
	lim.MaxTries = maxTries
	lim.ChunkAbove = 20
	lim.BigAbove = 20
	lim.Big.MaxTokens = 1024
	return llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: baseURL, DefaultModel: "claude-haiku-4-5-20251001",
		Summarize: config.SummarizeSection{SummarizeLimits: lim},
	})
}

// A JSON-parsing step (llm_ai_newsletter) cannot survive a completion cut off at
// max_tokens: a partial JSON reply is not a degraded answer, it is not an answer.
// The step must fail with a message naming the cap, the served model, and the
// config key to raise — not a bare json.Unmarshal error — and must do so on the
// FIRST attempt, not after burning every one of max_tries identical retries
// against the same deterministic cap (see job 461fce04).
func TestJSONStepFailsFastAndNamesTheCapOnTruncation(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast across the field. ", 20))

	box, url := newTruncatingBox(t, `{"summary": [`)
	router := truncatingRouter(url, 3)

	_, err := handleLLMAINewsletter(ctx, q, run, json.RawMessage(`{}`), router)
	if err == nil {
		t.Fatal("a truncated JSON reply must fail the step")
	}
	if got := err.Error(); !strings.Contains(got, "truncated at max_tokens=1024") ||
		!strings.Contains(got, "raise") {
		t.Fatalf("error must name the cap and the config key to raise, got %q", got)
	}
	if strings.Contains(err.Error(), "unexpected end of JSON input") {
		t.Fatalf("error must not be the raw json.Unmarshal failure, got %q", err.Error())
	}
	if got := box.count(); got != 1 {
		t.Fatalf("must fail fast on the first attempt (a retry at the same cap truncates identically), got %d calls", got)
	}
	if got := countHighlights(t, ctx, q, run); got != 0 {
		t.Fatalf("a fatally truncated reply must write no highlight, got %d", got)
	}
}

// A prose step (llm_summarize) survives the same failure: it keeps the partial
// reply, discloses the cut in the body (reusing the existing truncation-note
// mechanism), and records it in provenance as OUTPUT truncation — distinct from
// the INPUT-clamp `truncated` field, which must stay false here since the
// document was never clamped.
func TestProseStepSurvivesTruncationWithDisclosure(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, "Short body about foxes.")

	box, url := newTruncatingBox(t, "- **foxes** run fast, cut off mid")
	router := truncatingRouter(url, 3)

	if _, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), router); err != nil {
		t.Fatalf("a prose step must survive a truncated reply, got: %v", err)
	}
	if got := box.count(); got != 1 {
		t.Fatalf("a tolerant step must not retry a deterministic cap either, got %d calls", got)
	}

	h, p := provenanceOf(t, ctx, q, run)
	if !strings.Contains(h.Body, "foxes") {
		t.Fatalf("the partial reply must still be used, got body %q", h.Body)
	}
	if !strings.Contains(h.Body, "completion cap") {
		t.Fatalf("body must disclose the output cut, got %q", h.Body)
	}
	if !p.OutputTruncated {
		t.Fatalf("provenance must record output truncation: %+v", p)
	}
	if p.Truncated {
		t.Fatalf("output truncation must not be reported as the INPUT-clamp field: %+v", p)
	}
}
