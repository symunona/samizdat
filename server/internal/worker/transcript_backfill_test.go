package worker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/transcript"
)

// rollupVTT is the shape yt-dlp writes for auto-captions: paint-on cue, settle cue,
// carry-over line. Every spoken line arrives three times.
const rollupVTT = `WEBVTT
Kind: captions
Language: en

00:00:00.160 --> 00:00:01.990 align:start position:0%

How<00:00:00.400><c> do</c><00:00:01.600><c> I</c><00:00:01.700><c> know</c><00:00:01.800><c> when</c><00:00:01.900><c> to</c>

00:00:01.990 --> 00:00:02.000 align:start position:0%
How do I know when to


00:00:02.000 --> 00:00:04.390 align:start position:0%
How do I know when to
quit<00:00:02.240><c> something?</c>
`

func TestBackfillTranscriptsRewritesRollupBody(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	cacheDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cacheDir, "media"), 0755); err != nil {
		t.Fatal(err)
	}
	canonical := "https://www.youtube.com/watch?v=g7AxxkywiFI"
	base := filepath.Join(cacheDir, "media", IDFromURL(canonical+"#audio"))
	if err := os.WriteFile(base+".en.vtt", []byte(rollupVTT), 0644); err != nil {
		t.Fatal(err)
	}

	meta, _ := json.Marshal(ytMediaMetadata{
		Provider: "youtube", ExternalID: "g7AxxkywiFI",
		TranscriptStatus: "auto", OrigLang: "en", TranscriptLangs: []string{"en"},
	})
	const tripled = "How do I know when to\nHow do I know when to\nHow do I know when to quit something?"
	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: IDFromURL(canonical), CanonicalUrl: canonical, Title: "quit",
		Markdown: tripled, MediaType: "video", MediaMetadata: string(meta),
		Transcript:  `{"en":[{"start_ms":0,"end_ms":1990,"text":"How do I know when to"}]}`,
		ContentHash: "stale", FetchedAt: "2026-08-13T00:00:00Z",
		CreatedAt: "2026-08-13T00:00:00Z", UpdatedAt: "2026-08-13T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := BackfillTranscripts(ctx, q, cacheDir); err != nil {
		t.Fatal(err)
	}
	got, err := q.GetDocumentByID(ctx, doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if want := "How do I know when to quit something?"; got.Markdown != want {
		t.Errorf("markdown = %q, want %q", got.Markdown, want)
	}
	if got.Rev <= doc.Rev {
		t.Errorf("rev = %d, want > %d (phones must re-pull)", got.Rev, doc.Rev)
	}
	if got.ContentHash == "stale" {
		t.Error("content_hash was not rewritten")
	}
	var segs map[string][]transcript.Segment
	if err := json.Unmarshal([]byte(got.Transcript), &segs); err != nil {
		t.Fatal(err)
	}
	if len(segs["en"]) != 1 {
		t.Errorf("want 1 sentence segment, got %d: %+v", len(segs["en"]), segs["en"])
	}

	// Guard is one-shot: a second run must not touch the row again.
	revAfter := got.Rev
	if err := BackfillTranscripts(ctx, q, cacheDir); err != nil {
		t.Fatal(err)
	}
	again, _ := q.GetDocumentByID(ctx, doc.ID)
	if again.Rev != revAfter {
		t.Errorf("second run bumped rev %d → %d; the backfill must be one-shot", revAfter, again.Rev)
	}
}

// A row from before per-language ingest: transcript is a bare array, no
// transcript_langs, and the .vtt files were never kept. Repairable from the row.
func TestBackfillTranscriptsRepairsLegacyRowWithoutVTT(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	const stored = `[{"start_ms":0,"end_ms":1630,"text":"What advice do you give for the average"},` +
		`{"start_ms":1640,"end_ms":2950,"text":"What advice do you give for the average person looking to invest their"},` +
		`{"start_ms":2950,"end_ms":2960,"text":"person looking to invest their"},` +
		`{"start_ms":2960,"end_ms":4310,"text":"person looking to invest their wages?"}]`
	canonical := "https://www.youtube.com/watch?v=32u5T6lO8qk"
	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: IDFromURL(canonical), CanonicalUrl: canonical, Title: "legacy",
		Markdown:      "What advice do you give for the average\nWhat advice do you give for the average person looking to invest their",
		MediaType:     "video",
		MediaMetadata: `{"provider":"youtube","external_id":"32u5T6lO8qk","transcript_status":"auto"}`,
		Transcript:    stored, FetchedAt: "2026-08-13T00:00:00Z",
		CreatedAt: "2026-08-13T00:00:00Z", UpdatedAt: "2026-08-13T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Empty cache dir: nothing on disk to re-parse.
	if err := BackfillTranscripts(ctx, q, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	got, _ := q.GetDocumentByID(ctx, doc.ID)
	if want := "What advice do you give for the average person looking to invest their wages?"; got.Markdown != want {
		t.Errorf("markdown = %q, want %q", got.Markdown, want)
	}
	// The bare-array shape must survive — the app keys a legacy row off orig_lang.
	if !strings.HasPrefix(got.Transcript, "[") {
		t.Errorf("transcript = %.40q, want the legacy array shape", got.Transcript)
	}
}

func TestBackfillTranscriptsSkipsMissingSubtitles(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	meta, _ := json.Marshal(ytMediaMetadata{Provider: "youtube", TranscriptLangs: []string{"en"}})
	canonical := "https://www.youtube.com/watch?v=missingvtt"
	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: IDFromURL(canonical), CanonicalUrl: canonical, Title: "no subs",
		Markdown: "the description", MediaType: "video", MediaMetadata: string(meta),
		FetchedAt: "2026-08-13T00:00:00Z",
		CreatedAt: "2026-08-13T00:00:00Z", UpdatedAt: "2026-08-13T00:00:00Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	// Cache dir with no .vtt at all — a body must never be replaced with nothing.
	if err := BackfillTranscripts(ctx, q, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	got, _ := q.GetDocumentByID(ctx, doc.ID)
	if !strings.Contains(got.Markdown, "the description") {
		t.Errorf("markdown = %q, want the untouched fallback body", got.Markdown)
	}
	if got.Rev != doc.Rev {
		t.Errorf("rev moved %d → %d with nothing to re-parse", doc.Rev, got.Rev)
	}
}
