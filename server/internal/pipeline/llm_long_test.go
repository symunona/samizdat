package pipeline

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// fakeBox is an OpenAI-compatible endpoint that records every prompt it is sent
// and answers however the test tells it to.
type fakeBox struct {
	mu     sync.Mutex
	prompt []string // the user message of each call, in order
	model  []string // the model each call asked for
	reply  func(call int, model, prompt string) (string, int)
}

func newFakeBox(t *testing.T, reply func(call int, model, prompt string) (string, int)) (*fakeBox, string) {
	t.Helper()
	b := &fakeBox{reply: reply}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model    string `json:"model"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		msg := ""
		if len(req.Messages) > 0 {
			msg = req.Messages[0].Content
		}

		b.mu.Lock()
		call := len(b.prompt)
		b.prompt = append(b.prompt, msg)
		b.model = append(b.model, req.Model)
		b.mu.Unlock()

		text, status := b.reply(call, req.Model, msg)
		if status != 0 && status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"nope"}}`))
			return
		}
		body, _ := json.Marshal(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": text}}},
			"usage":   map[string]int{"prompt_tokens": 10, "completion_tokens": 4},
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return b, srv.URL + "/v1"
}

func (b *fakeBox) calls() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.prompt)
}

func (b *fakeBox) prompts() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.prompt...)
}

// bandRouter builds a Router over one fake box with the given size bands.
func bandRouter(baseURL string, lim config.SummarizeLimits) *llm.Router {
	return llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: baseURL, DefaultModel: "stub",
		Summarize: config.SummarizeSection{SummarizeLimits: lim},
	})
}

// testLimits are small enough to chunk a test-sized document.
func testLimits() config.SummarizeLimits {
	lim := config.DefaultSummarize().SummarizeLimits
	lim.ChunkAbove = 100
	lim.BigAbove = 100000
	lim.MaxChunks = 20
	lim.OverlapRunes = 0
	lim.MaxTries = 1
	lim.Map.CtxTokens = 900
	lim.Map.MaxTokens = 50
	lim.Reduce.CtxTokens = 900
	lim.Reduce.MaxTokens = 50
	lim.Big.CtxTokens = 4000
	return lim
}

func setMarkdown(t *testing.T, ctx context.Context, q *store.Queries, run store.PipelineRun, md string) {
	t.Helper()
	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		t.Fatalf("get document: %v", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: doc.ID, CanonicalUrl: doc.CanonicalUrl, Title: doc.Title, Markdown: md,
		FetchedAt: now, ContentHash: doc.ContentHash, CreatedAt: doc.CreatedAt, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("update document markdown: %v", err)
	}
}

// driveSteps runs the handler the way the worker does: repeat while the step
// reports progress, carrying the saved state into the next tick.
func driveSteps(t *testing.T, ctx context.Context, q *store.Queries, run store.PipelineRun,
	router *llm.Router, maxTicks int,
) (int, error) {
	t.Helper()
	ticks := 0
	for ticks < maxTicks {
		ticks++
		res, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), router)
		if err != nil {
			return ticks, err
		}
		if res.Done {
			return ticks, nil
		}
		if !res.Continue {
			t.Fatalf("tick %d made progress but did not ask to continue — every chunk would wait out the retry delay", ticks)
		}
		run.State = res.NewState
	}
	t.Fatalf("step never finished in %d ticks", maxTicks)
	return ticks, nil
}

func provenanceOf(t *testing.T, ctx context.Context, q *store.Queries, run store.PipelineRun) (store.Highlight, highlightProvenance) {
	t.Helper()
	hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("list highlights: %v", err)
	}
	if len(hs) != 1 {
		t.Fatalf("want exactly 1 highlight, got %d", len(hs))
	}
	var p highlightProvenance
	if err := json.Unmarshal([]byte(hs[0].Metadata), &p); err != nil {
		t.Fatalf("metadata %q: %v", hs[0].Metadata, err)
	}
	return hs[0], p
}

// A document under chunk_above takes exactly one call, and its provenance is
// shaped exactly as it was before chunking existed — no chunks, no calls field.
func TestBandSmallIsOneUnchangedCall(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, "Short body about foxes.")

	box, url := newFakeBox(t, func(int, string, string) (string, int) {
		return "- **foxes** run fast", 200
	})
	ticks, err := driveSteps(t, ctx, q, run, bandRouter(url, testLimits()), 5)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if ticks != 1 || box.calls() != 1 {
		t.Fatalf("small band must be one tick and one call, got %d ticks / %d calls", ticks, box.calls())
	}
	_, p := provenanceOf(t, ctx, q, run)
	if p.Chunks != 0 || p.Calls != 0 || p.Truncated {
		t.Fatalf("unchunked summary must not advertise chunking: %+v", p)
	}
	if p.TokensIn != 10 || p.TokensOut != 4 {
		t.Fatalf("token counts wrong: %+v", p)
	}
}

var chunkMarker = regexp.MustCompile(`chunk (\d+) of (\d+)`)

// The medium band maps every chunk, folds once, and writes ONE highlight whose
// provenance sums the whole run.
func TestBandChunkedMapsEveryChunkThenFolds(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast across the field. ", 150))

	box, url := newFakeBox(t, func(_ int, _, prompt string) (string, int) {
		if chunkMarker.MatchString(prompt) {
			return "- fragment fact", 200
		}
		return "- **foxes** run fast", 200
	})
	ticks, err := driveSteps(t, ctx, q, run, bandRouter(url, testLimits()), 30)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}

	var mapped, folded int
	seen := map[string]bool{}
	for _, p := range box.prompts() {
		if m := chunkMarker.FindStringSubmatch(p); m != nil {
			mapped++
			seen[m[1]] = true
			continue
		}
		folded++
	}
	if folded != 1 {
		t.Fatalf("want exactly one fold call, got %d", folded)
	}
	if mapped < 2 {
		t.Fatalf("want at least 2 map calls, got %d", mapped)
	}
	if len(seen) != mapped {
		t.Fatalf("a chunk was summarized twice: %d calls over %d distinct chunks", mapped, len(seen))
	}
	if ticks != mapped+1 {
		t.Fatalf("want one tick per call (%d), got %d ticks", mapped+1, ticks)
	}

	h, p := provenanceOf(t, ctx, q, run)
	if p.Chunks != mapped {
		t.Fatalf("provenance chunks = %d, want %d", p.Chunks, mapped)
	}
	if p.Calls != mapped+1 {
		t.Fatalf("provenance calls = %d, want %d", p.Calls, mapped+1)
	}
	if p.TokensIn != 10*(mapped+1) || p.TokensOut != 4*(mapped+1) {
		t.Fatalf("tokens must sum across every call: %+v", p)
	}
	if !strings.Contains(h.Body, "foxes") {
		t.Fatalf("body should be the fold reply, got %q", h.Body)
	}
	if strings.Contains(h.Body, "Truncated") {
		t.Fatal("a chunked document lost nothing and must not claim truncation")
	}
}

// The fold sees the partials, not the document: that is the whole point of the
// medium band, and getting it wrong would send the full text to the small box.
func TestChunkedFoldReceivesPartials(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast across the field. ", 150))

	box, url := newFakeBox(t, func(_ int, _, prompt string) (string, int) {
		if chunkMarker.MatchString(prompt) {
			return "PARTIAL-MARKER fact", 200
		}
		return "- **foxes** run", 200
	})
	if _, err := driveSteps(t, ctx, q, run, bandRouter(url, testLimits()), 30); err != nil {
		t.Fatalf("summarize: %v", err)
	}
	prompts := box.prompts()
	fold := prompts[len(prompts)-1]
	if !strings.Contains(fold, "PARTIAL-MARKER") {
		t.Fatalf("fold prompt does not carry the partials: %.200q", fold)
	}
	if strings.Contains(fold, "Foxes run fast across the field. Foxes run fast") {
		t.Fatal("fold prompt carries the raw document — the map output was ignored")
	}
}

// A failure mid-run must not lose the chunks already paid for, and must not
// produce a second highlight when the retry succeeds.
func TestChunkedRunResumesWithoutReworkOrDuplicates(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast across the field. ", 150))

	failAt := 2 // the third call, mid-map
	box, url := newFakeBox(t, func(call int, _, prompt string) (string, int) {
		if call == failAt {
			return "", http.StatusInternalServerError
		}
		if chunkMarker.MatchString(prompt) {
			return "- fragment fact", 200
		}
		return "- **foxes** run fast", 200
	})
	router := bandRouter(url, testLimits())

	// Drive until the injected failure.
	var state string
	failed := false
	for i := 0; i < 30 && !failed; i++ {
		res, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), router)
		if err != nil {
			failed = true
			break
		}
		if res.Done {
			t.Fatal("run finished without hitting the injected failure")
		}
		state = res.NewState
		run.State = state
	}
	if !failed {
		t.Fatal("injected failure never surfaced")
	}
	if got := countHighlights(t, ctx, q, run); got != 0 {
		t.Fatalf("a failed mid-run must write no highlight, got %d", got)
	}

	// The worker retries the job with the saved state. The run picks up where it
	// stopped rather than re-summarizing chunk 0.
	before := box.prompts()
	if _, err := driveSteps(t, ctx, q, run, router, 30); err != nil {
		t.Fatalf("resume: %v", err)
	}

	seen := map[string]int{}
	for _, p := range box.prompts() {
		if m := chunkMarker.FindStringSubmatch(p); m != nil {
			seen[m[1]]++
		}
	}
	for chunk, n := range seen {
		limit := 1
		if chunk == chunkIndexOf(before[failAt]) {
			limit = 2 // the failed chunk is legitimately re-run once
		}
		if n > limit {
			t.Fatalf("chunk %s summarized %d times — resume re-did finished work", chunk, n)
		}
	}
	if got := countHighlights(t, ctx, q, run); got != 1 {
		t.Fatalf("want exactly 1 highlight after resume, got %d", got)
	}
}

func chunkIndexOf(prompt string) string {
	if m := chunkMarker.FindStringSubmatch(prompt); m != nil {
		return m[1]
	}
	return ""
}

// Past big_above the document goes to the big model in one call, clamped to what
// that model holds, and the body says so.
func TestBandBigTruncatesAndDisclosesIt(t *testing.T) {
	ctx, q, run := setupRun(t)
	lim := testLimits()
	lim.BigAbove = 200
	lim.Big.CtxTokens = 1500
	lim.Big.MaxTokens = 50
	lim.Big.Model = "big" // names an endpoint, so the configured ctx is trusted

	// A distinctive tail: the body is repetitive, so any generic suffix of it also
	// appears near the front and would "prove" nothing about the clamp.
	huge := "OPENING-ALFA. " + strings.Repeat("Foxes run fast across the field. ", 150) + "CLOSING-ZULU."
	setMarkdown(t, ctx, q, run, huge)

	box, url := newFakeBox(t, func(int, string, string) (string, int) {
		return "- **foxes** run fast", 200
	})
	ticks, err := driveSteps(t, ctx, q, run, bandRouter(url, lim), 5)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if ticks != 1 || box.calls() != 1 {
		t.Fatalf("big band is one call, got %d ticks / %d calls", ticks, box.calls())
	}
	if got := box.model[0]; got != "big" {
		t.Fatalf("big band must use the big role's model, got %q", got)
	}
	sent := box.prompts()[0]
	if strings.Contains(sent, "CLOSING-ZULU") {
		t.Fatal("document was not clamped: its tail reached the model")
	}
	if !strings.Contains(sent, "OPENING-ALFA") {
		t.Fatal("the clamp must keep the START of the document")
	}

	h, p := provenanceOf(t, ctx, q, run)
	if !p.Truncated {
		t.Fatalf("provenance must record the cut: %+v", p)
	}
	if !strings.Contains(h.Body, "Truncated: summarized first") {
		t.Fatalf("body must disclose the cut, got %q", h.Body)
	}
	if !strings.Contains(h.Body, "foxes") {
		t.Fatalf("the note must be appended to the summary, not replace it: %q", h.Body)
	}
}

// A role that exhausts its retries escalates to the big model rather than
// failing the step.
func TestRoleEscalatesToBigAfterRetries(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, "Short body about foxes.")

	lim := testLimits()
	lim.MaxTries = 3
	lim.Big.Model = "big"

	box, url := newFakeBox(t, func(_ int, model, _ string) (string, int) {
		if model != "big" {
			return "", http.StatusInternalServerError
		}
		return "- **foxes** run fast", 200
	})
	if _, err := driveSteps(t, ctx, q, run, bandRouter(url, lim), 5); err != nil {
		t.Fatalf("escalation should have rescued the call: %v", err)
	}
	if got := box.calls(); got != 4 {
		t.Fatalf("want 3 failed attempts then 1 on the big model, got %d calls", got)
	}
	if got := box.model[3]; got != "big" {
		t.Fatalf("last call should be the big model, got %q", got)
	}
	// A failed attempt never reports usage, so the ledger holds only the call that
	// actually produced tokens.
	totals, err := q.GetLLMUsageTotals(ctx)
	if err != nil {
		t.Fatalf("usage totals: %v", err)
	}
	if totals.TotalCalls != int64(1) {
		t.Fatalf("want 1 metered call, got %v", totals.TotalCalls)
	}
	_, p := provenanceOf(t, ctx, q, run)
	if p.Model != "big" {
		t.Fatalf("provenance must name the model that actually wrote the text, got %q", p.Model)
	}
}

// An escalation target identical to the primary is skipped: retrying the same
// endpoint twice as often is not a fallback.
func TestNoEscalationWhenBigRoleIsTheSameEndpoint(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, "Short body about foxes.")

	lim := testLimits()
	lim.MaxTries = 2 // big role names nothing → same endpoint as the step's

	box, url := newFakeBox(t, func(int, string, string) (string, int) {
		return "", http.StatusInternalServerError
	})
	if _, err := driveSteps(t, ctx, q, run, bandRouter(url, lim), 5); err == nil {
		t.Fatal("a permanently failing box must fail the step")
	}
	if got := box.calls(); got != 2 {
		t.Fatalf("want max_tries=2 calls and no pointless escalation, got %d", got)
	}
}

// A context window too small to hold the prompt must fail loudly. Silently
// skipping the clamp would send the whole document to a box that cannot hold it.
func TestBigBandFailsWhenNothingFits(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast. ", 100))

	lim := testLimits()
	lim.BigAbove = 200
	lim.Big.Model = "big"
	lim.Big.CtxTokens = 100 // smaller than the step prompt itself

	box, url := newFakeBox(t, func(int, string, string) (string, int) {
		return "- **foxes** run fast", 200
	})
	if _, err := handleLLMSummarize(ctx, q, run, json.RawMessage(`{}`), bandRouter(url, lim)); err == nil {
		t.Fatal("an unusable context window must fail the step")
	}
	if box.calls() != 0 {
		t.Fatalf("nothing should have been sent, got %d calls", box.calls())
	}
}

func TestTruncationNoteReadsHonestly(t *testing.T) {
	got := truncationNote(180_000, 1_400_000)
	for _, want := range []string{"180k", "1.4M", "(12%)"} {
		if !strings.Contains(got, want) {
			t.Fatalf("note %q missing %q", got, want)
		}
	}
}

func TestLoadChunkStateIgnoresAnotherStepsState(t *testing.T) {
	other := `{"phase":"map","kind":"extract_list_items","chunks":3,"next":1}`
	st, err := loadChunkState(other, kindLLMSummarize)
	if err != nil || st != nil {
		t.Fatalf("state of another kind must read as absent, got %+v (%v)", st, err)
	}
	if st, err := loadChunkState(`{"cursor":4}`, kindLLMSummarize); err != nil || st != nil {
		t.Fatalf("unrelated state must read as absent, got %+v (%v)", st, err)
	}
	if st, err := loadChunkState("", kindLLMSummarize); err != nil || st != nil {
		t.Fatalf("empty state must read as absent, got %+v (%v)", st, err)
	}
}
