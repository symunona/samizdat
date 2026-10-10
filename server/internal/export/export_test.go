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

	"github.com/symunona/samizdat/server/internal/digest"
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

	seedDigestIssue(ctx, t, q, now)

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
	if e.issueFiles["issue-1"] == "" {
		t.Fatal("first sweep wrote no DigestIssue note; the idle check below would not cover one")
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

// seedDigestIssue gives doc-1 (which the caller made) a Highlight of two bullets
// and a done issue of Digest "AI Weekly" whose one topic cites the second, once
// as the news and once as the earlier text its diff rests on. Every row is
// stamped at.
func seedDigestIssue(ctx context.Context, t *testing.T, q *store.Queries, at string) {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: "pipe-1", Name: "p", Enabled: 1, Trigger: "manual", Filter: "{}", Steps: "[]", CreatedAt: at, UpdatedAt: at,
	})
	must(err)
	_, err = q.InsertPipelineRun(ctx, store.InsertPipelineRunParams{
		ID: "run-1", PipelineID: "pipe-1", DocumentID: "doc-1", CreatedAt: at, UpdatedAt: at,
	})
	must(err)
	_, err = q.InsertHighlight(ctx, store.InsertHighlightParams{
		ID: "hl-1", DocumentID: "doc-1", PipelineRunID: "run-1", Kind: "summary", Title: "Summary",
		Body: "- first thing\n- a [new tool](https://tool.example) shipped", Metadata: "{}", CreatedAt: at, UpdatedAt: at,
	})
	must(err)
	_, err = q.InsertDigest(ctx, store.InsertDigestParams{
		ID: "digest-1", Name: "AI Weekly", Enabled: 1, Period: digest.PeriodDaily, Weekdays: "[]", Hour: 7,
		SourceFeedIds: "[]", Questions: "[]", NextRunAt: at, CreatedAt: at, UpdatedAt: at,
	})
	must(err)
	_, err = q.UpsertDigestIssue(ctx, store.UpsertDigestIssueParams{
		ID: "issue-1", DigestID: "digest-1", WindowStart: at, WindowEnd: at, CreatedAt: at, UpdatedAt: at,
	})
	must(err)
	must(q.FinishDigestIssue(ctx, store.FinishDigestIssueParams{
		Status: digest.StatusDone, UpdatedAt: at, ID: "issue-1",
		Topics: `[{"question_id":"tools","question_title":"Cool tools","rank":1,"title":"A new tool",` +
			`"why":"Two newsletters\ncovered it.","previous":"The old tool","diff":"Now twice\nas fast.",` +
			`"refs":[{"highlight_id":"hl-1","bullet":1},{"highlight_id":"hl-1","bullet":1,"history":true}]}]`,
		Metadata: `{"questions":[{"question_id":"tools","truncated":true,"candidates":9,"candidates_sent":4}]}`,
	}))
}

// TestDigestIssueNote: a done issue is one note under its Digest's folder —
// question, topic, why, and the STORED bullet linking to its Document's note. A
// rename moves it; deleting the Digest removes it.
func TestDigestIssueNote(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	now := time.Now().UTC()
	at := now.Format(time.RFC3339)
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: "doc-1", CanonicalUrl: "https://a.example/1", Title: "Doc One",
		Markdown: "hello", FetchedAt: at, MediaType: "article", CreatedAt: at, UpdatedAt: at,
	}); err != nil {
		t.Fatal(err)
	}
	seedDigestIssue(ctx, t, q, at)
	// A run still in flight has nothing to export.
	if _, err := q.UpsertDigestIssue(ctx, store.UpsertDigestIssueParams{
		ID: "issue-running", DigestID: "digest-1", WindowStart: at, WindowEnd: at, CreatedAt: at, UpdatedAt: at,
	}); err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	e := New(q, dir, t.TempDir(), "none", linkWikilink)
	e.sweep(ctx)

	rel := digestSub + "/ai-weekly/" + now.In(time.Local).Format("2006-01-02") + ".md"
	if got := e.issueFiles["issue-1"]; got != rel {
		t.Fatalf("issue note at %q, want %q", got, rel)
	}
	if _, ok := e.issueFiles["issue-running"]; ok {
		t.Error("an issue that is not done got a note")
	}
	note, err := os.ReadFile(filepath.Join(dir, rel))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"id: issue-1\n" + issueMark + "\n",
		"\n## Cool tools\n",
		"> [!warning] Only the newest 4 of 9 items fit",
		"\n### 1. A new tool\n\nTwo newsletters covered it.\n\n**vs The old tool:** Now twice as fast.\n",
		"\n- *Earlier, " + at[:10] + ":* a [new tool](https://tool.example) shipped — [[doc-one|Doc One]]\n",
		"\n- a [new tool](https://tool.example) shipped — [[doc-one|Doc One]]\n",
	} {
		if !strings.Contains(string(note), want) {
			t.Errorf("issue note lacks %q:\n%s", want, note)
		}
	}
	if strings.Contains(string(note), "first thing") {
		t.Errorf("a bullet the topic does not cite was exported:\n%s", note)
	}

	// A fresh Exporter over the same vault finds the note it owns.
	reopened := New(q, dir, t.TempDir(), "none", linkWikilink)
	reopened.loadIndex()
	if got := reopened.issueFiles["issue-1"]; got != rel {
		t.Errorf("reloaded index has the issue at %q, want %q", got, rel)
	}

	later := now.Add(time.Second).Format(time.RFC3339)
	if _, err := q.UpdateDigest(ctx, store.UpdateDigestParams{
		Name: "Local models", Enabled: 1, Period: digest.PeriodDaily, Weekdays: "[]", Hour: 7,
		SourceFeedIds: "[]", Questions: "[]", NextRunAt: at, UpdatedAt: later, ID: "digest-1",
	}); err != nil {
		t.Fatal(err)
	}
	e.sweep(ctx)
	moved := digestSub + "/local-models/" + relBase(rel)
	if got := e.issueFiles["issue-1"]; got != moved {
		t.Errorf("after a rename the note is at %q, want %q", got, moved)
	}
	if _, err := os.Stat(filepath.Join(dir, digestSub, "ai-weekly")); !os.IsNotExist(err) {
		t.Errorf("the renamed Digest's old folder survived (err=%v)", err)
	}

	gone := now.Add(2 * time.Second).Format(time.RFC3339)
	if err := q.SoftDeleteDigestIssuesByDigest(ctx, store.SoftDeleteDigestIssuesByDigestParams{
		DeletedAt: &gone, UpdatedAt: gone, DigestID: "digest-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := q.SoftDeleteDigest(ctx, store.SoftDeleteDigestParams{DeletedAt: &gone, UpdatedAt: gone, ID: "digest-1"}); err != nil {
		t.Fatal(err)
	}
	e.sweep(ctx)
	if _, err := os.Stat(filepath.Join(dir, moved)); !os.IsNotExist(err) {
		t.Errorf("the note of a deleted Digest's issue survived (err=%v)", err)
	}
	if _, ok := e.issueFiles["issue-1"]; ok {
		t.Error("a deleted issue is still in the export index")
	}
	if got := e.Snapshot().LastError; got != "" {
		t.Errorf("export reported an error: %q", got)
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

	// Deleting the only note in a week folder must take the folder with it —
	// an empty grouping dir still shows up in Obsidian's file tree.
	annDir := filepath.Join(dir, wantAnnDir)
	later := now.Add(time.Second).Format(time.RFC3339)
	if err := q.SoftDeleteAnnotation(ctx, store.SoftDeleteAnnotationParams{
		DeletedAt: &later, UpdatedAt: later, ID: "ann-1",
	}); err != nil {
		t.Fatal(err)
	}
	e.sweep(ctx)

	if _, err := os.Stat(annDir); !os.IsNotExist(err) {
		t.Errorf("empty grouping dir %s survived (err=%v)", wantAnnDir, err)
	}
	// ...but never the top-level folder itself.
	if _, err := os.Stat(filepath.Join(dir, annsSub)); err != nil {
		t.Errorf("annotations/ root was pruned: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, e.docFiles["doc-1"])); err != nil {
		t.Errorf("doc note lost: %v", err)
	}
}

// TestPruneGroupDirKeepsSharedFolder: pruning is opportunistic — a folder that
// still holds another note must survive the removal of its neighbour.
func TestPruneGroupDirKeepsSharedFolder(t *testing.T) {
	dir := t.TempDir()
	group := filepath.Join(dir, annsSub, "2026-W33")
	if err := os.MkdirAll(group, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a.md", "b.md"} {
		if err := os.WriteFile(filepath.Join(group, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := &Exporter{dir: dir}
	e.track(map[string]string{"a": annsSub + "/2026-W33/a.md"}, "a", annsSub+"/2026-W34/a.md")
	if _, err := os.Stat(group); err != nil {
		t.Errorf("folder with a remaining note was pruned: %v", err)
	}
	// The boot pass clears folders emptied by an older build; a populated
	// neighbour and the top-level folders are left alone.
	stale := filepath.Join(dir, docsSub, "2025-W01")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	e.pruneEmptyGroups()
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale empty grouping dir survived the boot pass (err=%v)", err)
	}
	if _, err := os.Stat(group); err != nil {
		t.Errorf("boot pass removed a populated folder: %v", err)
	}

	// Flat layout: the top-level folder is not a grouping dir, never a candidate.
	if err := os.WriteFile(filepath.Join(dir, annsSub, "c.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := removeIfPresent(dir, annsSub+"/c.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, annsSub)); err != nil {
		t.Errorf("annotations/ root pruned on a flat-layout delete: %v", err)
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

// TestTombstonedDocRemovesNote: deleting a document must take its vault note
// with it. GetDocumentByID filters tombstones, so the sweep sees "no rows" —
// treating that as a failure left the note behind and warned on every sweep.
func TestTombstonedDocRemovesNote(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()

	now := time.Now().UTC()
	nowTS := now.Format(time.RFC3339)
	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: "doc-1", CanonicalUrl: "https://a.example/1", Title: "Doomed",
		Markdown: "hello", FetchedAt: nowTS, MediaType: "article",
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

	rel := e.docFiles["doc-1"]
	if rel == "" {
		t.Fatal("doc note was never written")
	}
	note := filepath.Join(dir, rel)
	if _, err := os.Stat(note); err != nil {
		t.Fatalf("doc note not on disk: %v", err)
	}

	later := now.Add(time.Second).Format(time.RFC3339)
	if err := q.SoftDeleteDocument(ctx, store.SoftDeleteDocumentParams{
		DeletedAt: &later, UpdatedAt: later, ID: "doc-1",
	}); err != nil {
		t.Fatal(err)
	}
	e.sweep(ctx)

	if _, err := os.Stat(note); !os.IsNotExist(err) {
		t.Errorf("note of tombstoned doc survived (err=%v)", err)
	}
	if _, ok := e.docFiles["doc-1"]; ok {
		t.Error("tombstoned doc still in the export index")
	}
	if got := e.Snapshot().LastError; got != "" {
		t.Errorf("removal reported as an export error: %q", got)
	}
}
