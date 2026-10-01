package pipeline

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/progress"
)

// recordProgress returns a Reporter and the list every write lands in, decoded.
func recordProgress(t *testing.T) (*progress.Reporter, *[]progress.State) {
	t.Helper()
	var states []progress.State
	rep := progress.New("", func(raw string) {
		var s progress.State
		if err := json.Unmarshal([]byte(raw), &s); err != nil {
			t.Errorf("progress %q: %v", raw, err)
		}
		states = append(states, s)
	})
	return rep, &states
}

// A job watching a model must say which endpoint it is asking, which try this
// is, and that it gave up on the first endpoint — while the call is in flight.
func TestProgressNamesEndpointTryAndEscalation(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, "Short body about foxes.")
	rep, states := recordProgress(t)
	ctx = progress.With(ctx, rep)

	lim := testLimits()
	lim.MaxTries = 2
	lim.Big.Model = "big"
	_, url := newFakeBox(t, func(_ int, model, _ string) (string, int) {
		if model != "big" {
			return "", http.StatusInternalServerError
		}
		return "- **foxes** run fast", 200
	})
	if _, err := driveSteps(t, ctx, q, run, bandRouter(url, lim), 5); err != nil {
		t.Fatalf("summarize: %v", err)
	}

	// A state naming an endpoint is the Router's hook: one per call, in order.
	host := strings.TrimSuffix(strings.TrimPrefix(url, "http://"), "/v1")
	type call struct {
		try      int
		model    string
		fallback bool
	}
	want := []call{{1, "stub", false}, {2, "stub", false}, {1, "big", true}}
	var got []call
	for _, s := range *states {
		if s.Provider == "" {
			continue
		}
		if s.Phase != progress.PhaseLLM || s.Step != kindLLMSummarize || s.Provider != host || s.Tries != 2 {
			t.Fatalf("state %+v, want phase llm, step %s, provider %s, tries 2", s, kindLLMSummarize, host)
		}
		got = append(got, call{s.Try, s.Model, s.Fallback})
	}
	if len(got) != len(want) {
		t.Fatalf("calls = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("call %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// A chunked run counts its chunks up and ends on n/n for the fold.
func TestProgressCountsChunks(t *testing.T) {
	ctx, q, run := setupRun(t)
	setMarkdown(t, ctx, q, run, strings.Repeat("Foxes run fast across the field. ", 150))
	rep, states := recordProgress(t)
	ctx = progress.With(ctx, rep)

	_, url := newFakeBox(t, func(int, string, string) (string, int) { return "- fact", 200 })
	ticks, err := driveSteps(t, ctx, q, run, bandRouter(url, testLimits()), 30)
	if err != nil {
		t.Fatalf("summarize: %v", err)
	}

	chunks := ticks - 1 // every tick maps one chunk, the last folds
	seen := 0
	for _, s := range *states {
		if s.Chunks != chunks {
			t.Fatalf("state %+v, want chunks=%d", s, chunks)
		}
		if s.Chunk < seen || s.Chunk > chunks {
			t.Fatalf("chunk went %d → %d of %d", seen, s.Chunk, chunks)
		}
		seen = s.Chunk
	}
	if seen != chunks {
		t.Fatalf("last reported chunk %d, want %d", seen, chunks)
	}
}
