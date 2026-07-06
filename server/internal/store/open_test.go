package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// relaxAnnotationDocumentID must turn an old NOT-NULL document_id into a nullable
// one WITHOUT losing rows, and must be idempotent.
func TestRelaxAnnotationDocumentID(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	for _, p := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON"} {
		if _, err := db.Exec(p); err != nil {
			t.Fatal(err)
		}
	}

	// Build the OLD schema: annotations.document_id is NOT NULL.
	must := func(q string) {
		t.Helper()
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	must(`CREATE TABLE documents (id TEXT PRIMARY KEY)`)
	must(`CREATE TABLE annotations (
		id TEXT PRIMARY KEY,
		document_id TEXT NOT NULL REFERENCES documents(id),
		highlight_id TEXT, exact TEXT NOT NULL, prefix TEXT NOT NULL DEFAULT '',
		suffix TEXT NOT NULL DEFAULT '', pos_start INTEGER NOT NULL DEFAULT 0,
		pos_end INTEGER NOT NULL DEFAULT 0, media_ts_ms INTEGER NOT NULL DEFAULT 0,
		color TEXT NOT NULL DEFAULT 'yellow', note TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
		deleted_at TEXT)`)
	must(`CREATE TABLE annotation_tags (id TEXT PRIMARY KEY, annotation_id TEXT NOT NULL REFERENCES annotations(id), tag_id TEXT NOT NULL)`)
	must(`INSERT INTO documents (id) VALUES ('doc1')`)
	must(`INSERT INTO annotations (id, document_id, exact, note, created_at, updated_at, rev) VALUES ('a1','doc1','anchored','body one','t1','t1',3)`)
	must(`INSERT INTO annotation_tags (id, annotation_id, tag_id) VALUES ('at1','a1','tag1')`)

	// Before migration a NULL document_id must be rejected.
	if _, err := db.Exec(`INSERT INTO annotations (id, exact, note, created_at, updated_at) VALUES ('a2','','n','t','t')`); err == nil {
		t.Fatal("expected NOT NULL rejection before migration")
	}

	if err := relaxAnnotationDocumentID(db); err != nil {
		t.Fatalf("migration: %v", err)
	}

	// Row data preserved, including rev and the FK-referencing junction row.
	var docID *string
	var note string
	var rev int
	if err := db.QueryRow(`SELECT document_id, note, rev FROM annotations WHERE id='a1'`).Scan(&docID, &note, &rev); err != nil {
		t.Fatal(err)
	}
	if docID == nil || *docID != "doc1" || note != "body one" || rev != 3 {
		t.Fatalf("data not preserved: docID=%v note=%q rev=%d", docID, note, rev)
	}
	var tagCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM annotation_tags WHERE annotation_id='a1'`).Scan(&tagCount); err != nil {
		t.Fatal(err)
	}
	if tagCount != 1 {
		t.Fatalf("annotation_tags lost: count=%d", tagCount)
	}

	// After migration a standalone (NULL document_id) note is accepted.
	if _, err := db.Exec(`INSERT INTO annotations (id, exact, note, created_at, updated_at) VALUES ('a3','','standalone','t','t')`); err != nil {
		t.Fatalf("null-doc insert should work after migration: %v", err)
	}

	// Idempotent: a second run is a no-op and doesn't error.
	if err := relaxAnnotationDocumentID(db); err != nil {
		t.Fatalf("second migration run: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM annotations`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("row count after idempotent re-run = %d, want 2", n)
	}
}
