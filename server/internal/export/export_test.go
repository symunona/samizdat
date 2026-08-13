package export

import (
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

func wikiLinks() map[string]assetLink {
	return map[string]assetLink{
		"https://ossama.is/images/gg.png": {file: "a1.jpg", style: linkWikilink, up: "../"},
		"/api/v1/media/fig-1":             {file: "b2.jpg", style: linkWikilink, up: "../"},
	}
}

// TestRewriteImagesWikilink: known assets become path-free Obsidian embeds,
// whatever URL shape the stored markdown used (scraped http, or the media route
// a PDF figure carries).
func TestRewriteImagesWikilink(t *testing.T) {
	in := "text\n\n![Lucky](https://ossama.is/images/gg.png)\n\n![Figure 1: x](/api/v1/media/fig-1)\n"
	got := rewriteImages(in, wikiLinks())
	// Alt text survives as the wikilink alias (Obsidian renders it as alt).
	if !strings.Contains(got, "![[a1.jpg|Lucky]]") || !strings.Contains(got, "![[b2.jpg|Figure 1: x]]") {
		t.Errorf("expected wikilink embeds, got:\n%s", got)
	}
	if strings.Contains(got, "ossama.is") || strings.Contains(got, "/api/v1/media/") {
		t.Errorf("source URL survived rewrite:\n%s", got)
	}
}

// TestRewriteImagesRelative keeps alt text and points at ../assets/.
func TestRewriteImagesRelative(t *testing.T) {
	links := map[string]assetLink{
		"https://ossama.is/images/gg.png": {file: "a1.jpg", style: linkRelative, up: "../"},
	}
	got := rewriteImages(`![Lucky](https://ossama.is/images/gg.png)`, links)
	if got != `![Lucky](../assets/a1.jpg)` {
		t.Errorf("got %q", got)
	}
}

// TestRewriteImagesLeavesUnknown: an image with no copied asset (download
// skipped/failed) must stay as-is, and non-image links are never touched.
func TestRewriteImagesLeavesUnknown(t *testing.T) {
	in := "![a](https://other.example/x.png) and [link](https://ossama.is/images/gg.png)"
	if got := rewriteImages(in, wikiLinks()); got != in {
		t.Errorf("expected unchanged, got:\n%s", got)
	}
}

// TestWikiAlias: `|`/brackets would break the link and a bare number reads as a
// width directive, so neither may reach the alias.
func TestWikiAlias(t *testing.T) {
	cases := map[string]string{
		"Figure 1: a plot":  "Figure 1: a plot",
		"a | b [c] ]] d":    "a b c d",
		"100":               "",
		"  spaced   out\n?": "spaced out ?",
		"":                  "",
	}
	for in, want := range cases {
		if got := wikiAlias(in); got != want {
			t.Errorf("wikiAlias(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRenderDocHero embeds the hero once in the body and keeps the frontmatter
// scalar a path (YAML cannot carry an embed).
func TestRenderDocHero(t *testing.T) {
	doc := store.Document{
		ID:           "doc-1",
		Title:        "T",
		CanonicalUrl: "https://ossama.is/writing/x",
		HeroImageUrl: "https://ossama.is/images/gg.png",
		Markdown:     "body",
		FetchedAt:    "2026-08-03T00:00:00Z",
		CreatedAt:    "2026-08-03T00:00:00Z",
	}
	out := string(renderDoc(doc, nil, nil, nil, wikiLinks()))
	if !strings.Contains(out, `hero: "../assets/a1.jpg"`) {
		t.Errorf("frontmatter hero path missing:\n%s", out)
	}
	if !strings.Contains(out, "![[a1.jpg]]") {
		t.Errorf("hero embed missing:\n%s", out)
	}
}

// TestSweepIsQuietWhenNothingChanged is the regression guard for the export
// churn bug: the cursor used to be rolled one second BEFORE the newest row, so
// `updated_at >= cursor` re-selected and rewrote the newest notes on every
// 15s tick — a file-change event for Syncthing/Obsidian forever, on an idle DB.
// A second sweep with no DB change must touch nothing on disk.
func TestSweepIsQuietWhenNothingChanged(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: "doc-1", CanonicalUrl: "https://a.example/1", Title: "Doc One",
		Markdown: "hello", FetchedAt: now, MediaType: "article",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	e := New(q, dir, t.TempDir(), "none", linkWikilink)
	for _, sub := range []string{docsSub, annsSub, assetsSub} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	e.sweep(ctx)

	before := mtimes(t, dir)
	if len(before) == 0 {
		t.Fatal("first sweep wrote nothing")
	}
	// mtime has second resolution on some filesystems; make a rewrite visible.
	past := time.Now().Add(-2 * time.Hour)
	for path := range before {
		if err := os.Chtimes(path, past, past); err != nil {
			t.Fatal(err)
		}
	}
	before = mtimes(t, dir)

	// The cursor must sit AT the newest row, not one second before it: with the
	// `>=` filter, a rolled-back cursor re-selects that row on every tick.
	if e.cursor != now {
		t.Errorf("cursor = %q, want %q (the newest updated_at)", e.cursor, now)
	}

	e.sweep(ctx)

	for path, ts := range mtimes(t, dir) {
		if old, ok := before[path]; !ok {
			t.Errorf("second sweep created %s", path)
		} else if !ts.Equal(old) {
			t.Errorf("second sweep rewrote %s (mtime %v → %v) with no DB change", path, old, ts)
		}
	}
}

// TestAnnotationGroupsByOwnCreatedAt: an annotation goes in the folder of the
// week it was WRITTEN, not the week its (possibly ancient) document was
// published — so the two notes can land in different grouping folders.
func TestAnnotationGroupsByOwnCreatedAt(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	now := time.Now().UTC()
	nowTS := now.Format(time.RFC3339)
	published := "2019-03-04T00:00:00Z"
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: "doc-1", CanonicalUrl: "https://a.example/1", Title: "Old Post",
		Markdown: "hello", FetchedAt: nowTS, MediaType: "article",
		PublishedAt: &published, CreatedAt: nowTS, UpdatedAt: nowTS,
	}); err != nil {
		t.Fatal(err)
	}
	docID := "doc-1"
	if _, err := q.InsertAnnotation(ctx, store.InsertAnnotationParams{
		ID: "ann-1", DocumentID: &docID, Exact: "hello", Note: "fresh take",
		CreatedAt: nowTS, UpdatedAt: nowTS,
	}); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	e := New(q, dir, t.TempDir(), "weekly", linkWikilink)
	for _, sub := range []string{docsSub, annsSub, assetsSub} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	e.sweep(ctx)

	y, w := now.ISOWeek()
	wantAnnDir := fmt.Sprintf("%s/%04d-W%02d", annsSub, y, w)
	if got := filepath.Dir(e.annFiles["ann-1"]); got != wantAnnDir {
		t.Errorf("annotation folder = %q, want %q (its own created_at)", got, wantAnnDir)
	}
	if got, want := filepath.Dir(e.docFiles["doc-1"]), docsSub+"/2019-W10"; got != want {
		t.Errorf("doc folder = %q, want %q (its published_at)", got, want)
	}
	if _, err := os.Stat(filepath.Join(dir, e.annFiles["ann-1"])); err != nil {
		t.Errorf("annotation note not on disk: %v", err)
	}
}

// mtimes maps every file under root to its modification time.
func mtimes(t *testing.T, root string) map[string]time.Time {
	t.Helper()
	out := map[string]time.Time{}
	if err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return fmt.Errorf("stat %s: %w", path, err)
		}
		out[path] = info.ModTime()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}
