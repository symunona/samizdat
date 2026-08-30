package pipeline

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// driveHandler is driveSteps generalized to any Handler: repeat while the step
// reports progress, carrying the saved state into the next tick. driveSteps
// (step_llm_shape_tolerance_test.go) stays as-is since it is already used by
// several llm_summarize-specific tests; this exists only for the extraction
// steps exercised in this file.
func driveHandler(t *testing.T, ctx context.Context, q *store.Queries, run store.PipelineRun,
	h Handler, router *llm.Router, maxTicks int,
) (int, error) {
	t.Helper()
	ticks := 0
	for ticks < maxTicks {
		ticks++
		res, err := h(ctx, q, run, json.RawMessage(`{}`), router)
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

// partitionTestLimits is testLimits sized for the extraction steps' own
// (longer) prompts: those don't use mapDefaultPrompt, so the chunk budget comes
// from splitForPartition instead of splitForMap — see llm_long.go.
func partitionTestLimits() config.SummarizeLimits {
	lim := testLimits()
	// The extraction prompts (topicsDefaultPrompt, nl321DefaultPrompt) are much
	// longer than mapDefaultPrompt; a small ctx window here would leave no room
	// for content at all (splitForPartition would error "leaves no room").
	lim.Map.CtxTokens = 2500
	return lim
}

// A partition step (llm_topics, the default strategy for anything but
// llm_summarize) sends the STEP's own prompt to every chunk and unions every
// reply — never mapDefaultPrompt, never a fold.
func TestPartitionUnionsEveryChunkNoMapPrompt(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast across the field. ", 150))

	box, url := newFakeBox(t, func(call int, _, _ string) (string, int) {
		body, _ := json.Marshal(map[string]any{"highlights": []map[string]string{
			{"title": "T", "body": "CHUNK-ITEM-" + strconv.Itoa(call)},
		}})
		return string(body), 200
	})
	router := bandRouter(url, partitionTestLimits())

	ticks, err := driveHandler(t, ctx, q, run, handleLLMTopics, router, 30)
	if err != nil {
		t.Fatalf("llm_topics: %v", err)
	}
	if box.calls() < 2 {
		t.Fatalf("test setup did not actually chunk the document, got %d calls", box.calls())
	}
	if ticks != box.calls() {
		t.Fatalf("want one tick per call (partition has no fold), got %d ticks / %d calls", ticks, box.calls())
	}

	// The mapDefaultPrompt tell: it literally renders "chunk N of M" — reused
	// from step_llm_shape_tolerance_test.go's chunkMarker. A partition tick must
	// never send it.
	for _, p := range box.prompts() {
		if chunkMarker.MatchString(p) {
			t.Fatalf("a partition tick sent mapDefaultPrompt, not the step's own prompt: %.200q", p)
		}
		if !strings.Contains(p, "split a newsletter into its distinct topics") {
			t.Fatalf("a partition tick did not send the step's own prompt: %.200q", p)
		}
	}

	hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("list highlights: %v", err)
	}
	if len(hs) != box.calls() {
		t.Fatalf("want one highlight per chunk (every reply unioned), got %d highlights for %d calls", len(hs), box.calls())
	}
	seen := map[string]bool{}
	for _, h := range hs {
		seen[h.Body] = true
	}
	if len(seen) != len(hs) {
		t.Fatalf("want every chunk's item distinct, got duplicates among %+v", hs)
	}
}

// TestPartitionPreservesVerbatimText is the regression test for the fabrication
// bug this whole change fixes: a document big enough to chunk, run through a
// partition step (llm_321_newsletter — the exact step named in the bug report),
// must produce a highlight whose body is the ORIGINAL text, byte-for-byte —
// never a paraphrase invented by a model that only ever saw chunk summaries.
func TestPartitionPreservesVerbatimText(t *testing.T) {
	ctx, q, run := setupRun(t)

	// The bug's own example: James Clear's 3-2-1, verbatim.
	idea := "Long-term thinking changes short-term actions. Spend a little time today doing things that will benefit you in ten years."
	// The fabricated text the old map→reduce path actually produced for it —
	// asserted absent below, so a regression back to folding would fail loudly
	// even if some OTHER paraphrase happened to sneak past the exact-match check.
	const fabricated = "build habits that align with your goals and repeat them consistently"

	filler := strings.Repeat("Padding paragraph to force multiple chunks so the idea sits alone in one of them. ", 100)
	md := filler + "\n\n" + idea + "\n\n" + filler
	setMarkdown(t, ctx, q, run, md)

	box, url := newFakeBox(t, func(_ int, _, prompt string) (string, int) {
		// A correct (non-fabricating) model: if the idea is in ITS chunk, it
		// echoes it verbatim; otherwise it has nothing to report.
		if strings.Contains(prompt, idea) {
			body, _ := json.Marshal(map[string]any{"highlights": []map[string]string{
				{"kind": "idea", "title": "t", "body": idea},
			}})
			return string(body), 200
		}
		return `{"highlights":[]}`, 200
	})
	router := bandRouter(url, partitionTestLimits())

	if _, err := driveHandler(t, ctx, q, run, handleLLM321Newsletter, router, 30); err != nil {
		t.Fatalf("llm_321_newsletter: %v", err)
	}
	if box.calls() < 2 {
		t.Fatalf("test setup did not actually chunk the document, got %d calls", box.calls())
	}

	hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("list highlights: %v", err)
	}
	var found bool
	for _, h := range hs {
		if h.Body == idea {
			found = true
		}
		if strings.Contains(h.Body, fabricated) {
			t.Fatalf("regression: the known-fabricated paraphrase reappeared: %q", h.Body)
		}
	}
	if !found {
		t.Fatalf("want the idea preserved VERBATIM among the highlights, got: %+v", hs)
	}
}

// TestDeadZoneDocumentStaysSmall locks down the "len(chunks) < 2" branch of
// planRun: a document whose ESTIMATED tokens cross chunk_above, but which still
// splits into exactly one chunk, must stay on the small band — the step's own
// config — not escalate to the big role. Sized from config.DefaultSummarize's
// real numbers (chunk_above = 4000 tokens = 12000 runes; the map chunk target
// computes to 12304 runes), so this is the literal window the bug fired in.
func TestDeadZoneDocumentStaysSmall(t *testing.T) {
	ctx, q, run := setupRun(t)
	// 12200 runes: EstimateTokens = 4066, over chunk_above's 4000, but still
	// under the ~12304-rune map budget, so Split returns exactly one chunk.
	setMarkdown(t, ctx, q, run, strings.Repeat("x", 12200))

	box, url := newFakeBox(t, func(int, string, string) (string, int) {
		return "- **foxes** run fast", 200
	})
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: url, DefaultModel: "stub",
		Summarize: config.SummarizeSection{SummarizeLimits: config.DefaultSummarize().SummarizeLimits},
	})

	ticks, err := driveHandler(t, ctx, q, run, handleLLMSummarize, router, 5)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}
	if ticks != 1 || box.calls() != 1 {
		t.Fatalf("a document that fits one chunk must be one call, got %d ticks / %d calls", ticks, box.calls())
	}
	h, p := provenanceOf(t, ctx, q, run)
	if p.Chunks != 0 || p.Calls != 0 {
		t.Fatalf("dead-zone document was routed through the chunked band: %+v", p)
	}
	if p.Truncated {
		t.Fatalf("dead-zone document was clamped by the big role's window instead of using its own config: %+v", p)
	}
	if strings.Contains(h.Body, "Truncated") {
		t.Fatalf("dead-zone document's body discloses a cut it should never have taken: %q", h.Body)
	}
}
