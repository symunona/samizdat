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

// Provenance is derived from the scrape job, so the three ways a Document can
// arrive must come back apart: a feed poll, a pipeline that followed a link out of
// another Document, and a URL a device pushed by hand.
func TestDocumentAddedVia(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := t.Context()
	now := time.Now().UTC().Format(time.RFC3339)

	feedID := "feed-1"
	if _, err := q.UpsertFeed(ctx, store.UpsertFeedParams{
		ID: feedID, Url: "https://a.example/rss", Kind: "rss", Title: "A",
		Config: "{}", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	doc := func(id, url string, feed *string) {
		if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
			ID: id, CanonicalUrl: url, Title: id, Markdown: "x", FetchedAt: now,
			SourceFeedID: feed, MediaType: "article", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	doc("doc-feed", "https://a.example/1", &feedID)
	doc("doc-pipeline", "https://a.example/2", nil)
	doc("doc-manual", "https://a.example/3", nil)
	doc("doc-orphan", "https://a.example/4", nil)

	job := func(id, kind, payload, result string, parent *string) {
		if _, err := q.InsertJob(ctx, store.InsertJobParams{
			ID: id, Kind: kind, Payload: payload, RunAfter: now,
			CreatedAt: now, UpdatedAt: now, ParentJobID: parent,
		}); err != nil {
			t.Fatal(err)
		}
		if err := q.MarkJobDone(ctx, store.MarkJobDoneParams{
			Result: result, DurationMs: 10, UpdatedAt: now, ID: id,
		}); err != nil {
			t.Fatal(err)
		}
	}
	stepJobID := "job-step"
	job(stepJobID, "run_pipeline_step",
		`{"pipeline_name":"Summarizer","document_id":"doc-feed","document_title":"The Linking Doc"}`, "{}", nil)
	job("job-scrape-pipeline", "scrape_url",
		`{"url":"https://a.example/2"}`, `{"document_id":"doc-pipeline"}`, &stepJobID)
	job("job-scrape-manual", "scrape_url",
		`{"url":"https://a.example/3","device_name":"phone"}`, `{"document_id":"doc-manual"}`, nil)

	h := &documentsHandler{q: q}
	get := func(id string) docAddedVia {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/documents/"+id, nil)
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		h.get(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d", id, rec.Code)
		}
		var body struct {
			AddedVia docAddedVia `json:"added_via"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.AddedVia
	}

	if got := get("doc-feed"); got.Kind != "feed" {
		t.Errorf("feed document: kind %q, want feed", got.Kind)
	}
	if got := get("doc-orphan"); got.Kind != "unknown" {
		t.Errorf("document with no scrape job: kind %q, want unknown", got.Kind)
	}
	if got := get("doc-manual"); got.Kind != "manual" || got.DeviceName != "phone" {
		t.Errorf("manual document: %+v, want manual from phone", got)
	}
	got := get("doc-pipeline")
	if got.Kind != "pipeline" || got.PipelineName != "Summarizer" {
		t.Errorf("pipeline document: %+v, want pipeline Summarizer", got)
	}
	// The linking Document is what makes the panel navigable — without it the row
	// is just a label.
	if got.DocumentID != "doc-feed" || got.DocumentTitle != "The Linking Doc" {
		t.Errorf("pipeline document: linking doc %q/%q, want doc-feed/The Linking Doc", got.DocumentID, got.DocumentTitle)
	}
}
