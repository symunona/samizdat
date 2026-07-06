package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

func newTestStore(t *testing.T) (*Queries, context.Context) {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(db), context.Background()
}

func mkRun(t *testing.T, q *Queries, ctx context.Context) (Pipeline, Document, PipelineRun) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	pl, err := q.InsertPipeline(ctx, InsertPipelineParams{
		ID: uuid.NewString(), Name: "p", Enabled: 1, Trigger: "manual",
		Filter: "{}", Steps: "[]", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("pipeline: %v", err)
	}
	doc, err := q.UpsertDocument(ctx, UpsertDocumentParams{
		ID: uuid.NewString(), CanonicalUrl: "https://e/" + uuid.NewString(), Title: "T",
		Markdown: "m", FetchedAt: now, ContentHash: "h", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("doc: %v", err)
	}
	jid := uuid.NewString()
	run, err := q.InsertPipelineRun(ctx, InsertPipelineRunParams{
		ID: uuid.NewString(), PipelineID: pl.ID, DocumentID: doc.ID, JobID: &jid,
		DocumentContentHash: "h", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	return pl, doc, run
}

func mkHighlight(t *testing.T, q *Queries, ctx context.Context, run PipelineRun, kind string) Highlight {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339)
	h, err := q.InsertHighlight(ctx, InsertHighlightParams{
		ID: uuid.NewString(), DocumentID: run.DocumentID, PipelineRunID: run.ID,
		Kind: kind, Body: "b", Metadata: "{}", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("highlight: %v", err)
	}
	return h
}

// TestRegenerateCascadePreservesInteracted verifies the shared interacted rule:
// pinned / archived / annotated / tagged highlights survive; plain ones are
// tombstoned; the run is superseded and stays alive while it keeps a highlight.
func TestRegenerateCascadePreservesInteracted(t *testing.T) {
	q, ctx := newTestStore(t)
	_, doc, run := mkRun(t, q, ctx)
	now := time.Now().UTC().Format(time.RFC3339)

	plain := mkHighlight(t, q, ctx, run, "plain")
	pinned := mkHighlight(t, q, ctx, run, "pinned")
	archived := mkHighlight(t, q, ctx, run, "archived")
	annotated := mkHighlight(t, q, ctx, run, "annotated")
	tagged := mkHighlight(t, q, ctx, run, "tagged")

	if err := q.UpdateHighlightPinned(ctx, UpdateHighlightPinnedParams{Pinned: 1, UpdatedAt: now, ID: pinned.ID}); err != nil {
		t.Fatal(err)
	}
	if err := q.ArchiveHighlight(ctx, ArchiveHighlightParams{ArchivedAt: &now, UpdatedAt: now, ID: archived.ID}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertAnnotation(ctx, InsertAnnotationParams{
		ID: uuid.NewString(), DocumentID: &doc.ID, HighlightID: &annotated.ID,
		Exact: "x", Color: "yellow", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	tag, err := q.InsertTag(ctx, InsertTagParams{ID: uuid.NewString(), Name: "t", Color: "default", CreatedAt: now, UpdatedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertHighlightTag(ctx, InsertHighlightTagParams{
		ID: uuid.NewString(), HighlightID: tagged.ID, TagID: tag.ID, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	n, err := SoftDeleteRegenerableHighlights(ctx, q.db, []string{run.ID}, now)
	if err != nil {
		t.Fatalf("cascade delete: %v", err)
	}
	if n != 1 {
		t.Fatalf("want 1 regenerable highlight deleted, got %d", n)
	}
	if err := SupersedeRuns(ctx, q.db, []string{run.ID}, now); err != nil {
		t.Fatal(err)
	}
	if err := TombstoneEmptyRuns(ctx, q.db, []string{run.ID}, now); err != nil {
		t.Fatal(err)
	}

	// Surviving (non-deleted) highlights: the 4 interacted ones.
	surviving, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(surviving) != 4 {
		t.Fatalf("want 4 surviving interacted highlights, got %d", len(surviving))
	}
	for _, h := range surviving {
		if h.ID == plain.ID {
			t.Fatalf("plain highlight should have been tombstoned")
		}
	}

	// Run kept alive (still has interacted highlights) but marked superseded.
	got, err := q.GetPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.DeletedAt != nil {
		t.Fatalf("run with surviving highlights must not be tombstoned")
	}
	if got.SupersededAt == nil {
		t.Fatalf("run must be marked superseded")
	}
}

// TestRegenerateCascadeTombstonesEmptyRun verifies a run whose highlights are all
// regenerable gets tombstoned once they are removed.
func TestRegenerateCascadeTombstonesEmptyRun(t *testing.T) {
	q, ctx := newTestStore(t)
	_, _, run := mkRun(t, q, ctx)
	now := time.Now().UTC().Format(time.RFC3339)
	mkHighlight(t, q, ctx, run, "plain")
	mkHighlight(t, q, ctx, run, "plain")

	if err := RegenerateCascade(ctx, q.db, []string{run.ID}, now); err != nil {
		t.Fatalf("cascade: %v", err)
	}
	got, err := q.GetPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.DeletedAt == nil {
		t.Fatalf("empty run must be tombstoned")
	}
}
