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

// doSync invokes the sync handler with the given cursor and decodes the response.
func doSync(t *testing.T, h *syncHandler, since string) syncResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sync?since="+since, nil)
	rec := httptest.NewRecorder()
	h.sync(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("sync status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var resp syncResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	return resp
}

func findDoc(docs []store.Document, id string) (store.Document, bool) {
	for _, d := range docs {
		if d.ID == id {
			return d, true
		}
	}
	return store.Document{}, false
}

// A Document updated after a client's last sync must be re-delivered when the
// client pulls again with the cursor that sync returned. This is the core
// server→phone contract for machine data (re-scrape / pipeline updates): the
// returned server_time must be a lower bound, never advancing past an update the
// client hasn't seen. Guards the cursor-race fix in sync.go.
func TestSync_UpdatedDocumentReDelivered(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := t.Context()
	h := &syncHandler{q: q}

	const docID = "doc-1"
	const url = "https://a.example/1"

	upsert := func(markdown, updatedAt string) {
		if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
			ID: docID, CanonicalUrl: url, Title: "Doc", Markdown: markdown,
			FetchedAt: updatedAt, MediaType: "article", CreatedAt: updatedAt, UpdatedAt: updatedAt,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// First pull from epoch sees the original (truncated) document.
	upsert("old", time.Now().UTC().Format(time.RFC3339))
	first := doSync(t, h, "1970-01-01T00:00:00Z")
	if d, ok := findDoc(first.Documents, docID); !ok || d.Markdown != "old" {
		t.Fatalf("first sync: want doc markdown=old, got present=%v markdown=%q", ok, d.Markdown)
	}
	cursor := first.ServerTime
	if cursor == "" {
		t.Fatal("first sync returned empty server_time")
	}

	// The document is re-scraped to full text (a later updated_at). A client that
	// advanced to `cursor` must still receive the update.
	upsert("new full text", time.Now().UTC().Format(time.RFC3339))
	second := doSync(t, h, cursor)
	d, ok := findDoc(second.Documents, docID)
	if !ok {
		t.Fatalf("update lost: doc not re-delivered on sync since=%s (server would have skipped the phone's update)", cursor)
	}
	if d.Markdown != "new full text" {
		t.Fatalf("stale content re-delivered: markdown=%q, want %q", d.Markdown, "new full text")
	}
}

// A same-second update (the doc's updated_at equals the returned cursor) must
// still be delivered — the `>=` cursor filter covers the second-resolution
// boundary of RFC3339 timestamps.
func TestSync_SameSecondUpdateNotSkipped(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := t.Context()
	h := &syncHandler{q: q}

	const docID = "doc-2"
	ts := "2026-07-04T00:00:07Z"
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: docID, CanonicalUrl: "https://a.example/2", Title: "Doc", Markdown: "v1",
		FetchedAt: ts, MediaType: "article", CreatedAt: ts, UpdatedAt: ts,
	}); err != nil {
		t.Fatal(err)
	}

	// Client pulls with a cursor equal to the row's updated_at second: it must be
	// included, not treated as strictly-before-and-skipped.
	resp := doSync(t, h, ts)
	if _, ok := findDoc(resp.Documents, docID); !ok {
		t.Fatalf("same-second update skipped: doc with updated_at=%s not returned for since=%s", ts, ts)
	}
}
