// Package export mirrors the SQLite index out to a plain-markdown Obsidian
// vault on disk. One-way (DB → markdown): files carrying our frontmatter id are
// created/overwritten; foreign files are never touched. This is a
// backup/observation view, distinct from the design-rule source-of-truth vault.
//
// Layout (all under the configured export dir):
//
//	documents/<slug>.md      one note per Document (marker `samizdat: export`)
//	annotations/<slug>.md    one note per Annotation (marker `samizdat: export-annotation`)
//	assets/<id>.<ext>        copied image assets, referenced ../assets/… from notes
//	_index.md                MOC of all documents (marker `samizdat: export-index`)
package export

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/symunona/samizdat/server/internal/logger"
	"github.com/symunona/samizdat/server/internal/store"
)

const (
	epoch      = "1970-01-01T00:00:00Z"
	tickEvery  = 15 * time.Second
	indexName  = "_index.md"
	docsSub    = "documents"
	annsSub    = "annotations"
	assetsSub  = "assets"
	docMark    = "samizdat: export"            // frontmatter line on every doc note
	annMark    = "samizdat: export-annotation" // frontmatter line on every annotation note
	indexMark  = "samizdat: export-index"      // frontmatter line on the index note
	overlapSec = 1                             // re-query window; RFC3339 is second-resolution
)

// Stats is the snapshot surfaced by GET /api/v1/export/stats.
type Stats struct {
	Enabled         bool   `json:"enabled"`
	Dir             string `json:"dir"`
	DocCount        int    `json:"doc_count"`
	AnnotationCount int    `json:"annotation_count"`
	LastExportAt    string `json:"last_export_at"`
	LastError       string `json:"last_error"`
}

// Exporter runs a background loop that keeps the vault folder in sync with the DB.
type Exporter struct {
	q        *store.Queries
	dir      string
	cacheDir string // image assets live under cacheDir/<MediaAsset.LocalPath>
	log      *logger.Logger

	sweepMu  sync.Mutex // serializes sweeps (ticker vs on-demand Refresh)
	mu       sync.Mutex
	cursor   string            // last exported updated_at
	docFiles map[string]string // doc id → filename under documents/
	annFiles map[string]string // annotation id → filename under annotations/
	lastRun  string
	lastErr  string
}

// New builds an Exporter. Caller starts it with Run.
func New(q *store.Queries, dir, cacheDir string) *Exporter {
	return &Exporter{
		q:        q,
		dir:      dir,
		cacheDir: cacheDir,
		log:      logger.New("export"),
		cursor:   epoch,
		docFiles: map[string]string{},
		annFiles: map[string]string{},
	}
}

// Run does an initial full sweep (builds the index) then ticks forever.
// Blocks until ctx is cancelled; intended to run in its own goroutine.
func (e *Exporter) Run(ctx context.Context) {
	for _, sub := range []string{docsSub, annsSub, assetsSub} {
		if err := os.MkdirAll(filepath.Join(e.dir, sub), 0o755); err != nil {
			e.log.Warnf("cannot create export dir %q: %v", filepath.Join(e.dir, sub), err)
			e.setErr(err)
			return
		}
	}
	e.loadIndex()
	e.log.Printf("auto-export → %s (%d docs, %d annotations)", e.dir, len(e.docFiles), len(e.annFiles))
	e.sweep(ctx)

	t := time.NewTicker(tickEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			e.sweep(ctx)
		}
	}
}

// Refresh runs one sweep on demand (e.g. from the stats endpoint) so the vault
// reflects the latest DB state without waiting for the next tick.
func (e *Exporter) Refresh(ctx context.Context) {
	e.sweep(ctx)
}

// Snapshot returns the current stats.
func (e *Exporter) Snapshot() Stats {
	e.mu.Lock()
	defer e.mu.Unlock()
	return Stats{
		Enabled:         true,
		Dir:             e.dir,
		DocCount:        len(e.docFiles),
		AnnotationCount: len(e.annFiles),
		LastExportAt:    e.lastRun,
		LastError:       e.lastErr,
	}
}

// loadIndex scans documents/ and annotations/ for notes we own (by frontmatter
// marker + id), so re-runs overwrite the same files and foreign files are
// skipped. Runs once at startup.
func (e *Exporter) loadIndex() {
	scan := func(sub, marker string, dst map[string]string) {
		entries, err := os.ReadDir(filepath.Join(e.dir, sub))
		if err != nil {
			return
		}
		for _, ent := range entries {
			if ent.IsDir() || !strings.HasSuffix(ent.Name(), ".md") {
				continue
			}
			if id := ourFileID(filepath.Join(e.dir, sub, ent.Name()), marker); id != "" {
				dst[id] = ent.Name()
			}
		}
	}
	scan(docsSub, docMark, e.docFiles)
	scan(annsSub, annMark, e.annFiles)
}

// sweep exports every doc that (or whose annotations) changed since the cursor.
// Serialized so the ticker and on-demand Refresh can't write the same file at once.
func (e *Exporter) sweep(ctx context.Context) {
	e.sweepMu.Lock()
	defer e.sweepMu.Unlock()

	e.mu.Lock()
	cursor := e.cursor
	e.mu.Unlock()

	docs, err := e.q.ListDocumentsSince(ctx, cursor)
	if err != nil {
		e.setErr(fmt.Errorf("list documents: %w", err))
		return
	}
	annos, err := e.q.ListAnnotationsSince(ctx, cursor)
	if err != nil {
		e.setErr(fmt.Errorf("list annotations: %w", err))
		return
	}
	if len(docs) == 0 && len(annos) == 0 {
		return
	}

	// Affected doc ids (their notes list annotation links, so an annotation
	// change re-exports the parent doc too) + the max timestamp seen.
	maxTs := cursor
	dirty := map[string]struct{}{}
	for _, d := range docs {
		dirty[d.ID] = struct{}{}
		if d.UpdatedAt > maxTs {
			maxTs = d.UpdatedAt
		}
	}
	for _, a := range annos {
		dirty[a.DocumentID] = struct{}{}
		if a.UpdatedAt > maxTs {
			maxTs = a.UpdatedAt
		}
		// A tombstoned annotation's own note must be removed here — exportDoc
		// only writes live annotations, it won't delete a stale note.
		if a.DeletedAt != nil {
			if err := e.removeAnnotation(a.ID); err != nil {
				e.log.Warnf("remove annotation %s: %v", a.ID, err)
			}
		}
	}

	var failed bool
	for id := range dirty {
		if err := e.exportDoc(ctx, id); err != nil {
			e.log.Warnf("export doc %s: %v", id, err)
			e.setErr(err)
			failed = true
		}
	}

	e.writeIndex()

	e.mu.Lock()
	e.cursor = overlap(maxTs)
	e.lastRun = time.Now().UTC().Format(time.RFC3339)
	if !failed {
		e.lastErr = ""
	}
	e.mu.Unlock()
}

// exportDoc writes (or, if tombstoned, removes) a document's note, its image
// assets, and one note per live annotation.
func (e *Exporter) exportDoc(ctx context.Context, id string) error {
	doc, err := e.q.GetDocumentByID(ctx, id)
	if err != nil {
		return fmt.Errorf("get document %s: %w", id, err)
	}
	if doc.DeletedAt != nil {
		return e.removeDoc(id)
	}

	annos, err := e.q.ListAnnotationsByDocument(ctx, id)
	if err != nil {
		return fmt.Errorf("list annotations for %s: %w", id, err)
	}
	live := annos[:0]
	for _, a := range annos {
		if a.DeletedAt == nil {
			live = append(live, a)
		}
	}
	tags, err := e.q.ListTagsByDocument(ctx, id)
	if err != nil {
		return fmt.Errorf("list tags for %s: %w", id, err)
	}
	assets, err := e.q.ListMediaAssetsByDocument(ctx, id)
	if err != nil {
		return fmt.Errorf("list assets for %s: %w", id, err)
	}

	// Copy image assets into assets/ and map their source URL → vault-relative
	// path (notes sit one folder deep, so reference ../assets/…).
	urlRewrite := map[string]string{}
	for _, a := range assets {
		if a.DeletedAt != nil || a.Kind == "audio" || a.LocalPath == "" {
			continue
		}
		fname := filepath.Base(a.LocalPath)
		if err := e.copyAsset(a.LocalPath, fname); err != nil {
			e.log.Warnf("copy asset %s: %v", fname, err)
			continue
		}
		if a.OriginalUrl != "" {
			urlRewrite[a.OriginalUrl] = "../" + assetsSub + "/" + fname
		}
	}

	docName := e.docFilename(doc)
	annNames := make([]string, len(live))
	for i, a := range live {
		annNames[i] = e.annFilename(a)
	}

	body := renderDoc(doc, live, annNames, tags, urlRewrite)
	if err := os.WriteFile(filepath.Join(e.dir, docsSub, docName), body, 0o644); err != nil {
		return fmt.Errorf("write doc note %s: %w", docName, err)
	}
	e.mu.Lock()
	e.docFiles[id] = docName
	e.mu.Unlock()

	for i, a := range live {
		note := renderAnnotation(a, docName, urlRewrite)
		if err := os.WriteFile(filepath.Join(e.dir, annsSub, annNames[i]), note, 0o644); err != nil {
			return fmt.Errorf("write annotation note %s: %w", annNames[i], err)
		}
		e.mu.Lock()
		e.annFiles[a.ID] = annNames[i]
		e.mu.Unlock()
	}
	return nil
}

// copyAsset copies cacheDir/<localPath> → dir/assets/<fname> (skips if the dest
// is already up to date by size).
func (e *Exporter) copyAsset(localPath, fname string) error {
	src := filepath.Join(e.cacheDir, localPath)
	dst := filepath.Join(e.dir, assetsSub, fname)
	si, err := os.Stat(src)
	if err != nil {
		return fmt.Errorf("stat asset: %w", err)
	}
	if di, err := os.Stat(dst); err == nil && di.Size() == si.Size() {
		return nil // already copied
	}
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open asset: %w", err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("create asset: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("copy asset: %w", err)
	}
	if err := out.Close(); err != nil {
		return fmt.Errorf("close asset: %w", err)
	}
	return nil
}

// removeDoc deletes our note for a tombstoned document (its annotations are
// cascade-tombstoned and removed via the annotation path).
func (e *Exporter) removeDoc(id string) error {
	e.mu.Lock()
	name := e.docFiles[id]
	delete(e.docFiles, id)
	e.mu.Unlock()
	return removeIfPresent(filepath.Join(e.dir, docsSub, name), name)
}

// removeAnnotation deletes our note for a tombstoned annotation.
func (e *Exporter) removeAnnotation(id string) error {
	e.mu.Lock()
	name := e.annFiles[id]
	delete(e.annFiles, id)
	e.mu.Unlock()
	return removeIfPresent(filepath.Join(e.dir, annsSub, name), name)
}

func removeIfPresent(path, name string) error {
	if name == "" {
		return nil
	}
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove note %s: %w", name, err)
	}
	return nil
}

// docFilename returns a stable filename for a doc note: reuse the existing one
// if we own it, else a slug of the title, avoiding collisions.
func (e *Exporter) docFilename(doc store.Document) string {
	e.mu.Lock()
	if n, ok := e.docFiles[doc.ID]; ok {
		e.mu.Unlock()
		return n
	}
	e.mu.Unlock()

	base := slug(doc.Title)
	if base == "" {
		base = slug(doc.ID)
	}
	name := base + ".md"
	if e.docNameFree(name, doc.ID) {
		return name
	}
	return base + "-" + short(doc.ID) + ".md"
}

// annFilename returns a stable filename for an annotation note. Annotations have
// no title, so the id suffix guarantees uniqueness without collision handling.
func (e *Exporter) annFilename(a store.Annotation) string {
	e.mu.Lock()
	if n, ok := e.annFiles[a.ID]; ok {
		e.mu.Unlock()
		return n
	}
	e.mu.Unlock()

	base := slug(firstLine(a.Note))
	if base == "" {
		base = slug(a.Exact)
	}
	if base == "" {
		base = "annotation"
	}
	return base + "-" + short(a.ID) + ".md"
}

// docNameFree reports whether name is unclaimed by another doc and not a foreign
// file already in documents/.
func (e *Exporter) docNameFree(name, id string) bool {
	e.mu.Lock()
	for oid, n := range e.docFiles {
		if n == name && oid != id {
			e.mu.Unlock()
			return false
		}
	}
	e.mu.Unlock()
	_, err := os.Stat(filepath.Join(e.dir, docsSub, name))
	return os.IsNotExist(err)
}

// writeIndex regenerates the _index.md MOC linking every owned doc note.
func (e *Exporter) writeIndex() {
	e.mu.Lock()
	names := make([]string, 0, len(e.docFiles))
	for _, n := range e.docFiles {
		names = append(names, n)
	}
	e.mu.Unlock()
	sort.Strings(names)

	var b strings.Builder
	b.WriteString("---\n" + indexMark + "\ntitle: Samizdat Export\n---\n\n# Samizdat Export\n\n")
	fmt.Fprintf(&b, "%d documents.\n\n", len(names))
	for _, n := range names {
		fmt.Fprintf(&b, "- [[%s]]\n", strings.TrimSuffix(n, ".md"))
	}
	_ = os.WriteFile(filepath.Join(e.dir, indexName), []byte(b.String()), 0o644)
}

func (e *Exporter) setErr(err error) {
	e.mu.Lock()
	e.lastErr = err.Error()
	e.mu.Unlock()
}

// --- rendering ---

func renderDoc(doc store.Document, annos []store.Annotation, annNames []string, tags []store.Tag, rewrite map[string]string) []byte {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", doc.ID)
	b.WriteString(docMark + "\n")
	fmt.Fprintf(&b, "canonical_url: %s\n", yamlStr(doc.CanonicalUrl))
	fmt.Fprintf(&b, "title: %s\n", yamlStr(doc.Title))
	if doc.Author != "" {
		fmt.Fprintf(&b, "author: %s\n", yamlStr(doc.Author))
	}
	if doc.PublishedAt != nil && *doc.PublishedAt != "" {
		fmt.Fprintf(&b, "published: %s\n", yamlStr(*doc.PublishedAt))
	}
	fmt.Fprintf(&b, "fetched: %s\n", yamlStr(doc.FetchedAt))
	fmt.Fprintf(&b, "media_type: %s\n", yamlStr(doc.MediaType))
	if hero := rewrite[doc.HeroImageUrl]; hero != "" {
		fmt.Fprintf(&b, "hero: %s\n", yamlStr(hero))
	}
	if len(tags) > 0 {
		names := make([]string, len(tags))
		for i, t := range tags {
			names[i] = yamlStr(t.Name)
		}
		fmt.Fprintf(&b, "tags: [%s]\n", strings.Join(names, ", "))
	}
	b.WriteString("---\n\n")

	fmt.Fprintf(&b, "# %s\n\n", firstLine(doc.Title))
	if hero := rewrite[doc.HeroImageUrl]; hero != "" {
		fmt.Fprintf(&b, "![hero](%s)\n\n", hero)
	}
	b.WriteString(strings.TrimRight(rewriteURLs(doc.Markdown, rewrite), "\n"))
	b.WriteString("\n")

	if len(annos) > 0 {
		b.WriteString("\n## Annotations\n\n")
		for i := range annos {
			fmt.Fprintf(&b, "- [[%s]]\n", strings.TrimSuffix(annNames[i], ".md"))
		}
	}
	return []byte(b.String())
}

func renderAnnotation(a store.Annotation, docName string, rewrite map[string]string) []byte {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", a.ID)
	b.WriteString(annMark + "\n")
	fmt.Fprintf(&b, "document: %s\n", yamlStr("[["+strings.TrimSuffix(docName, ".md")+"]]"))
	if a.Color != "" {
		fmt.Fprintf(&b, "color: %s\n", yamlStr(a.Color))
	}
	if a.MediaTsMs > 0 {
		fmt.Fprintf(&b, "media_ts: %s\n", yamlStr(msToTS(a.MediaTsMs)))
	}
	fmt.Fprintf(&b, "pos: %s\n", yamlStr(fmt.Sprintf("%d-%d", a.PosStart, a.PosEnd)))
	fmt.Fprintf(&b, "created: %s\n", yamlStr(a.CreatedAt))
	b.WriteString("---\n\n")

	fmt.Fprintf(&b, "> [!quote] From [[%s]]\n", strings.TrimSuffix(docName, ".md"))
	if strings.TrimSpace(a.Exact) != "" {
		for _, ln := range strings.Split(rewriteURLs(a.Exact, rewrite), "\n") {
			b.WriteString("> " + ln + "\n")
		}
	}
	if strings.TrimSpace(a.Note) != "" {
		b.WriteString("\n" + strings.TrimRight(rewriteURLs(a.Note, rewrite), "\n") + "\n")
	}
	return []byte(b.String())
}

// --- helpers ---

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func slug(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = nonSlug.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 80 {
		s = strings.Trim(s[:80], "-")
	}
	return s
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// rewriteURLs swaps source asset URLs for their vault-relative paths in body text.
func rewriteURLs(s string, rewrite map[string]string) string {
	for url, rel := range rewrite {
		s = strings.ReplaceAll(s, url, rel)
	}
	return s
}

// yamlStr double-quotes and escapes a value for a frontmatter scalar.
func yamlStr(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	s = strings.ReplaceAll(s, "\n", " ")
	return `"` + s + `"`
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

func msToTS(ms int64) string {
	sec := ms / 1000
	h, m, s := sec/3600, (sec%3600)/60, sec%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

// overlap steps the cursor back one second so a row committed in the same
// (second-resolution) timestamp as maxTs isn't skipped; re-export is idempotent.
func overlap(maxTs string) string {
	t, err := time.Parse(time.RFC3339, maxTs)
	if err != nil {
		return maxTs
	}
	return t.Add(-overlapSec * time.Second).UTC().Format(time.RFC3339)
}

// ourFileID reads a .md file's frontmatter and returns its samizdat id, or "" if
// the file lacks the given ownership marker.
func ourFileID(path, marker string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	text := string(data)
	if !strings.HasPrefix(text, "---") {
		return ""
	}
	end := strings.Index(text[3:], "\n---")
	if end < 0 {
		return ""
	}
	fm := text[3 : 3+end]
	if !strings.Contains(fm, marker) {
		return ""
	}
	for _, ln := range strings.Split(fm, "\n") {
		ln = strings.TrimSpace(ln)
		if strings.HasPrefix(ln, "id:") {
			return strings.TrimSpace(strings.TrimPrefix(ln, "id:"))
		}
	}
	return ""
}
