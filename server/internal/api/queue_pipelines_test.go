package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

// A manual "queue pipelines" must honour each pipeline's filter, exactly like the
// auto on_new_document trigger — not queue every pipeline regardless of scope.
func TestQueuePipelines_RespectsFilter(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := t.Context()
	now := time.Now().UTC().Format(time.RFC3339)

	feedA := "feed-a"
	if _, err := q.UpsertFeed(ctx, store.UpsertFeedParams{
		ID: feedA, Url: "https://a.example/rss", Kind: "rss", Title: "A",
		Config: "{}", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	docID := "doc-1"
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: docID, CanonicalUrl: "https://a.example/1", Title: "Doc", Markdown: "x",
		FetchedAt: now, SourceFeedID: &feedA, MediaType: "article", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// P1: no filter → matches every document.
	// P2: scoped to a different feed → must be skipped for this doc.
	// P3: disabled → must be skipped regardless of filter.
	mk := func(id, name, filter string, enabled int64) {
		if _, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
			ID: id, Name: name, Enabled: enabled, Trigger: "on_new_document",
			Filter: filter, Steps: "[]", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	mk("p1", "match-all", "{}", 1)
	mk("p2", "other-feed", `{"source_feed_id":"feed-b"}`, 1)
	mk("p3", "disabled", "{}", 0)

	h := &documentsHandler{q: q}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/documents/"+docID+"/queue-pipelines", nil)
	req.SetPathValue("id", docID)
	rec := httptest.NewRecorder()
	h.queuePipelines(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Exactly one run_pipeline job, and it must be for p1.
	rows, err := db.QueryContext(ctx, "SELECT payload FROM jobs WHERE kind = 'run_pipeline'")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var queuedIDs []string
	for rows.Next() {
		var payload string
		if err := rows.Scan(&payload); err != nil {
			t.Fatal(err)
		}
		var p map[string]string
		if err := json.Unmarshal([]byte(payload), &p); err != nil {
			t.Fatal(err)
		}
		queuedIDs = append(queuedIDs, p["pipeline_id"])
	}
	if len(queuedIDs) != 1 || queuedIDs[0] != "p1" {
		t.Errorf("expected only p1 queued, got %v", queuedIDs)
	}
}
