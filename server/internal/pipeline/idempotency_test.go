package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

// setupRun creates a temp DB with one pipeline, document and pipeline run, and
// returns a tx-aware context (DB injected via WithDB), the queries and the run.
func setupRun(t *testing.T) (context.Context, *store.Queries, store.PipelineRun) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	q := store.New(db)
	ctx := WithDB(context.Background(), db)
	now := time.Now().UTC().Format(time.RFC3339)

	pl, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: uuid.NewString(), Name: "t", Enabled: 1, Trigger: "manual",
		Filter: "{}", Steps: "[]", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("insert pipeline: %v", err)
	}
	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: uuid.NewString(), CanonicalUrl: "https://example.com/a", Title: "A",
		Markdown: "body", FetchedAt: now, ContentHash: "hash", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("upsert document: %v", err)
	}
	run, err := q.InsertPipelineRun(ctx, store.InsertPipelineRunParams{
		ID: uuid.NewString(), PipelineID: pl.ID, DocumentID: doc.ID,
		DocumentContentHash: "hash", CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("insert run: %v", err)
	}
	return ctx, q, run
}

func insertN(ctx context.Context, q *store.Queries, run store.PipelineRun, n int) error {
	now := time.Now().UTC().Format(time.RFC3339)
	for i := 0; i < n; i++ {
		if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
			ID: uuid.NewString(), DocumentID: run.DocumentID, PipelineRunID: run.ID,
			Kind: "item", Body: "h", Metadata: "{}", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			return fmt.Errorf("insert highlight %d: %w", i, err)
		}
	}
	return nil
}

// TestInsertTxRollbackNoDuplicates simulates a step that errors after k inserts:
// the transaction must roll back (leaving zero highlights), so a clean retry of
// the full batch leaves exactly N — not k+N — i.e. no duplicates.
func TestInsertTxRollbackNoDuplicates(t *testing.T) {
	ctx, q, run := setupRun(t)
	const k, total = 3, 5

	// Attempt 1: insert k, then fail → whole batch rolls back.
	errBoom := errors.New("boom")
	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		if err := insertN(ctx, q, run, k); err != nil {
			return err
		}
		return errBoom
	}); !errors.Is(err, errBoom) {
		t.Fatalf("expected boom, got %v", err)
	}
	if got := countHighlights(t, ctx, q, run); got != 0 {
		t.Fatalf("after rolled-back attempt: want 0 highlights, got %d (rollback failed)", got)
	}

	// Attempt 2 (retry): insert the full batch cleanly.
	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		return insertN(ctx, q, run, total)
	}); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if got := countHighlights(t, ctx, q, run); got != total {
		t.Fatalf("after retry: want %d highlights (no dups), got %d", total, got)
	}
}

// TestExtractImagesNoDuplicateURLs verifies the real step dedups repeated image
// URLs and emits one highlight per distinct image.
func TestExtractImagesNoDuplicateURLs(t *testing.T) {
	ctx, q, run := setupRun(t)
	now := time.Now().UTC().Format(time.RFC3339)
	// Same markdown with a repeated image URL.
	md := "![a](https://img/x.png)\n![b](https://img/y.png)\n![a2](https://img/x.png)"
	doc, _ := q.GetDocumentByID(ctx, run.DocumentID)
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: doc.ID, CanonicalUrl: doc.CanonicalUrl, Title: doc.Title, Markdown: md,
		FetchedAt: now, ContentHash: "h2", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("update doc markdown: %v", err)
	}

	cfg, _ := json.Marshal(map[string]int{})
	if _, err := handleExtractImages(ctx, q, run, cfg, nil); err != nil {
		t.Fatalf("extract_images: %v", err)
	}
	if got := countHighlights(t, ctx, q, run); got != 2 {
		t.Fatalf("want 2 distinct image highlights, got %d", got)
	}
}

func countHighlights(t *testing.T, ctx context.Context, q *store.Queries, run store.PipelineRun) int {
	t.Helper()
	hls, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("list highlights: %v", err)
	}
	return len(hls)
}
