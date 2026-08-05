package pipeline

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

// newPipelineDB creates a temp DB holding one pipeline with the given steps JSON.
func newPipelineDB(t *testing.T, steps string) (context.Context, *store.Queries, store.Pipeline) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	q := store.New(db)
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339)
	pl, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: uuid.NewString(), Name: "p", Enabled: 1, Trigger: "on_new_document",
		Filter: "{}", Steps: steps, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("insert pipeline: %v", err)
	}
	return ctx, q, pl
}

func stepPrompt(t *testing.T, stepsJSON string, idx int) string {
	t.Helper()
	var steps []struct {
		Config struct {
			Prompt string `json:"prompt"`
		} `json:"config"`
	}
	if err := json.Unmarshal([]byte(stepsJSON), &steps); err != nil {
		t.Fatalf("parse steps %q: %v", stepsJSON, err)
	}
	if idx >= len(steps) {
		t.Fatalf("step %d missing in %q", idx, stepsJSON)
	}
	return steps[idx].Config.Prompt
}

// TestBackfillStepPromptsIdempotent: the first pass writes the catalog default
// into a step that has none; a second pass (and a re-run after a hand edit) must
// change nothing.
func TestBackfillStepPromptsIdempotent(t *testing.T) {
	ctx, q, pl := newPipelineDB(t, `[{"kind":"llm_topics","config":{"model":"m"}},{"kind":"extract_images","config":{}}]`)

	if err := BackfillStepPrompts(ctx, q); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	after, _ := q.GetPipeline(ctx, pl.ID)
	if got := stepPrompt(t, after.Steps, 0); got != defaultPrompt(kindLLMTopics) {
		t.Fatalf("prompt not backfilled, got %q", got)
	}
	if after.Rev <= pl.Rev {
		t.Fatalf("rev not bumped: %d → %d", pl.Rev, after.Rev)
	}
	if strings.Contains(after.Steps, `"kind":"extract_images","config":{"prompt"`) {
		t.Fatalf("promptless kind got a prompt: %s", after.Steps)
	}

	// Second pass: guarded by the server_settings flag → no write at all.
	if err := BackfillStepPrompts(ctx, q); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	again, _ := q.GetPipeline(ctx, pl.ID)
	if again.Rev != after.Rev || again.Steps != after.Steps {
		t.Fatalf("second pass wrote: rev %d→%d", after.Rev, again.Rev)
	}
}

// TestBackfillKeepsUserPrompt: a step that already carries a prompt is never
// overwritten, even on the very first pass.
func TestBackfillKeepsUserPrompt(t *testing.T) {
	ctx, q, pl := newPipelineDB(t, `[{"kind":"llm_summarize","config":{"prompt":"mine"}}]`)
	if err := BackfillStepPrompts(ctx, q); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	after, _ := q.GetPipeline(ctx, pl.ID)
	if got := stepPrompt(t, after.Steps, 0); got != "mine" {
		t.Fatalf("user prompt overwritten with %q", got)
	}
	if after.Rev != pl.Rev {
		t.Fatalf("no-op backfill still bumped rev %d → %d", pl.Rev, after.Rev)
	}
}

// TestBackfillMalformedStepsUntouched: unparseable steps JSON must survive.
func TestBackfillMalformedStepsUntouched(t *testing.T) {
	ctx, q, pl := newPipelineDB(t, `not json`)
	if err := BackfillStepPrompts(ctx, q); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	after, _ := q.GetPipeline(ctx, pl.ID)
	if after.Steps != `not json` {
		t.Fatalf("malformed steps rewritten to %q", after.Steps)
	}
}
