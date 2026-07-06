package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/store"
)

// A standalone note is created with no parent Document (document_id NULL), rides
// the annotation sync feed, and rejects an empty body.
func TestStandaloneNote_Create(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	h := &annotationsHandler{q: q}

	// Empty note → 400.
	empty := httptest.NewRequest(http.MethodPost, "/api/v1/annotations", strings.NewReader(`{"note":""}`))
	emptyRec := httptest.NewRecorder()
	h.createStandalone(emptyRec, empty)
	if emptyRec.Code != http.StatusBadRequest {
		t.Fatalf("empty note: status = %d, want 400", emptyRec.Code)
	}

	// Valid note → 201 with a null document_id.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/annotations",
		strings.NewReader(`{"note":"random thought","color":"blue","exact":"should be cleared","document_id":"ignored"}`))
	rec := httptest.NewRecorder()
	h.createStandalone(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var ann store.Annotation
	if err := json.Unmarshal(rec.Body.Bytes(), &ann); err != nil {
		t.Fatal(err)
	}
	if ann.DocumentID != nil {
		t.Fatalf("standalone note has a document_id: %q", *ann.DocumentID)
	}
	if ann.Note != "random thought" || ann.Color != "blue" {
		t.Fatalf("bad note/color: %q %q", ann.Note, ann.Color)
	}
	if ann.Exact != "" {
		t.Fatalf("anchor not cleared: exact=%q", ann.Exact)
	}

	// It rides the annotation sync feed (two-way like any annotation).
	syncH := &syncHandler{q: q}
	resp := doSync(t, syncH, "1970-01-01T00:00:00Z")
	if _, ok := findDoc(resp.Documents, "any"); ok {
		t.Fatal("no documents expected")
	}
	found := false
	for _, a := range resp.Annotations {
		if a.ID == ann.ID && a.DocumentID == nil {
			found = true
		}
	}
	if !found {
		t.Fatal("standalone note not delivered in sync feed")
	}
}
