package worker

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

// The sweep is opt-in and must be surgical: nothing happens while the flag is
// off, and when it is on a pinned highlight survives (pinning is the user's
// explicit keep — a sweep that undoes triage is worse than no sweep).
func TestSweepAutoArchive(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()
	w := &Worker{q: q}

	now := time.Now().UTC().Format(time.RFC3339)
	old := time.Now().UTC().Add(-90 * 24 * time.Hour).Format(time.RFC3339)

	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: "doc-1", CanonicalUrl: "https://a.example/1", Title: "Doc",
		FetchedAt: now, MediaType: "article", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: "pipe-1", Name: "test", Enabled: 1, Trigger: "manual", Filter: "{}", Steps: "[]",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPipelineRun(ctx, store.InsertPipelineRunParams{
		ID: "run-1", PipelineID: "pipe-1", DocumentID: "doc-1",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	add := func(id, createdAt string, pinned bool) {
		if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
			ID: id, DocumentID: "doc-1", PipelineRunID: "run-1", Kind: "note",
			Title: id, Body: "body", Metadata: "{}", CreatedAt: createdAt, UpdatedAt: createdAt,
		}); err != nil {
			t.Fatal(err)
		}
		if pinned {
			if err := q.UpdateHighlightPinned(ctx, store.UpdateHighlightPinnedParams{
				Pinned: 1, UpdatedAt: createdAt, ID: id,
			}); err != nil {
				t.Fatal(err)
			}
		}
	}
	add("hl-old", old, false)
	add("hl-old-pinned", old, true)
	add("hl-fresh", now, false)

	archived := func() map[string]bool {
		t.Helper()
		rows, err := q.ListArchivedHighlights(ctx, 100)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]bool{}
		for _, r := range rows {
			got[r.ID] = true
		}
		return got
	}

	// Flag absent: the sweep is a no-op.
	w.sweepAutoArchive(ctx)
	if len(archived()) != 0 {
		t.Fatalf("sweep archived rows with the flag off: %v", archived())
	}

	if err := q.UpsertSetting(ctx, store.UpsertSettingParams{Key: AutoArchiveSettingKey, Value: "true"}); err != nil {
		t.Fatal(err)
	}
	w.sweepAutoArchive(ctx)
	got := archived()
	if !got["hl-old"] {
		t.Errorf("the old highlight was not archived: %v", got)
	}
	if got["hl-old-pinned"] {
		t.Error("a pinned highlight was archived — pinning must survive the sweep")
	}
	if got["hl-fresh"] {
		t.Error("a highlight younger than the cutoff was archived")
	}
}
