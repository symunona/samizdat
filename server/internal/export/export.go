// Package export mirrors the SQLite index out to a plain-markdown Obsidian
// vault on disk. One-way (DB → markdown): files carrying our frontmatter id are
// created/overwritten; foreign files are never touched. This is a
// backup/observation view, distinct from the design-rule source-of-truth vault.
//
// Layout (all under the configured export dir):
//
//	documents/<slug>.md      one note per Document (marker `samizdat: export`)
//	annotations/<slug>.md    one note per Annotation (marker `samizdat: export-annotation`)
//	                         export.grouping inserts a date subfolder: documents
//	                         by published (else created), annotations by their own
//	                         created — the two can differ.
//	assets/<id>.<ext>        copied image assets, embedded as ![[<id>.<ext>]]
//	                         (export.image_links = "relative" → ../assets/… instead)
//	_index.md                MOC of all documents (marker `samizdat: export-index`)
package export

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/symunona/samizdat/server/internal/logger"
	"github.com/symunona/samizdat/server/internal/store"
)

const (
	epoch     = "1970-01-01T00:00:00Z"
	tickEvery = 15 * time.Second
	indexName = "_index.md"
	docsSub   = "documents"
	annsSub   = "annotations"
	assetsSub = "assets"
	docMark   = "samizdat: export"            // frontmatter line on every doc note
	annMark   = "samizdat: export-annotation" // frontmatter line on every annotation note
	indexMark = "samizdat: export-index"      // frontmatter line on the index note

	linkWikilink = "wikilink" // ![[<file>]] — Obsidian resolves by name, path-free
	linkRelative = "relative" // ![alt](../assets/<file>) — plain-markdown portable
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
	q          *store.Queries
	dir        string
	cacheDir   string // image assets live under cacheDir/<MediaAsset.LocalPath>
	imageLinks string // wikilink|relative — see renderImage
	log        *logger.Logger

	sweepMu  sync.Mutex // serializes sweeps (ticker vs on-demand Refresh)
	mu       sync.Mutex
	cursor   string            // last exported updated_at
	docFiles map[string]string // doc id → path relative to dir (e.g. documents/2026-W31/x.md)
	annFiles map[string]string // annotation id → path relative to dir
	grouping string            // none|daily|weekly|monthly
	lastRun  string
	lastErr  string
}

// New builds an Exporter. Caller starts it with Run.
func New(q *store.Queries, dir, cacheDir, grouping, imageLinks string) *Exporter {
	if imageLinks != linkRelative {
		imageLinks = linkWikilink // default; config.Load rejects anything else
	}
	return &Exporter{
		q:          q,
		dir:        dir,
		cacheDir:   cacheDir,
		grouping:   grouping,
		imageLinks: imageLinks,
		log:        logger.New("export"),
		cursor:     epoch,
		docFiles:   map[string]string{},
		annFiles:   map[string]string{},
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
	// After the boot sweep has moved whatever regrouped: pruneGroupDir only fires
	// on a note leaving, so folders emptied by an older build (or by a grouping
	// change made while the server was down) need this one pass to disappear.
	e.pruneEmptyGroups()

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

// loadIndex scans documents/ and annotations/ (recursively, for grouping
// subfolders) for notes we own (by frontmatter marker + id), so re-runs
// overwrite the same files and foreign files are skipped. Runs once at startup.
func (e *Exporter) loadIndex() {
	scan := func(sub, marker string, dst map[string]string) {
		root := filepath.Join(e.dir, sub)
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr // aborts the walk; caller ignores the result
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			if id := ourFileID(path, marker); id != "" {
				rel, err := filepath.Rel(e.dir, path)
				if err == nil {
					dst[id] = filepath.ToSlash(rel)
				}
			}
			return nil
		})
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
		if a.UpdatedAt > maxTs {
			maxTs = a.UpdatedAt
		}
		// A tombstoned annotation's own note must be removed here — exportDoc
		// only writes live annotations, it won't delete a stale note.
		if a.DeletedAt != nil {
			if err := e.removeAnnotation(a.ID); err != nil {
				e.log.Warnf("remove annotation %s: %v", a.ID, err)
			}
			continue
		}
		if a.DocumentID != nil {
			// Anchored annotation: re-export its parent doc (whose note lists it).
			dirty[*a.DocumentID] = struct{}{}
		} else {
			// Standalone note: no parent doc to group under — write its note directly.
			if err := e.exportStandaloneNote(a); err != nil {
				e.log.Warnf("export standalone note %s: %v", a.ID, err)
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

	// Cursor is the newest timestamp seen, NOT one second before it: the query
	// filters on `updated_at >= cursor`, so a row committed in that same
	// (second-resolution) timestamp is re-selected anyway. Rolling the cursor
	// back made every sweep re-select — and rewrite — the newest notes forever,
	// i.e. a file-change event on every tick for anything watching the vault.
	e.mu.Lock()
	e.cursor = maxTs
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

	annos, err := e.q.ListAnnotationsByDocument(ctx, &id)
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

	// An annotation is grouped by when IT was written, not by the parent doc's
	// date: a highlight made this week belongs in this week's folder even on a
	// ten-year-old article. So an annotation note can sit at a different depth
	// than its doc note (unparseable doc date → flat) — hence atDepth below.
	docRel := e.docRelPath(doc, e.groupDir(docDate(doc)))
	annRels := make([]string, len(live))
	for i, a := range live {
		annRels[i] = e.annRelPath(a, e.groupDir(a.CreatedAt))
	}

	// Copy image assets into assets/ and map every URL they appear under in the
	// markdown → the copied file name.
	links := e.assetLinks(assets, docRel)

	body := renderDoc(doc, live, relBaseNames(annRels), tags, links)
	if err := writeNote(e.dir, docRel, body); err != nil {
		return fmt.Errorf("write doc note %s: %w", docRel, err)
	}
	e.mu.Lock()
	oldDocRel := e.docFiles[id]
	e.docFiles[id] = docRel
	e.mu.Unlock()
	removeIfMoved(e.dir, oldDocRel, docRel)

	for i, a := range live {
		note := renderAnnotation(a, relBase(docRel), atDepth(links, annRels[i]))
		if err := writeNote(e.dir, annRels[i], note); err != nil {
			return fmt.Errorf("write annotation note %s: %w", annRels[i], err)
		}
		e.mu.Lock()
		oldAnnRel := e.annFiles[a.ID]
		e.annFiles[a.ID] = annRels[i]
		e.mu.Unlock()
		removeIfMoved(e.dir, oldAnnRel, annRels[i])
	}
	return nil
}

// writeNote writes body to dir/rel, creating grouping subfolders as needed.
// A byte-identical file is left alone: rewriting it would bump its mtime and
// wake every file watcher on the vault (Syncthing, Obsidian) for no change.
func writeNote(dir, rel string, body []byte) error {
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", filepath.Dir(path), err)
	}
	if unchanged(path, body) {
		return nil
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// unchanged reports whether path already holds exactly body.
func unchanged(path string, body []byte) bool {
	old, err := os.ReadFile(path)
	return err == nil && bytes.Equal(old, body)
}

// removeIfMoved deletes the note at its previous path when grouping (or a
// filename change) relocated it.
func removeIfMoved(dir, oldRel, newRel string) {
	if oldRel != "" && oldRel != newRel {
		_ = os.Remove(filepath.Join(dir, oldRel))
		pruneGroupDir(dir, oldRel)
	}
}

// pruneEmptyGroups removes every empty grouping subfolder under documents/ and
// annotations/. Grouping is exactly one level deep, so a shallow ReadDir is the
// whole job. os.Remove refuses a non-empty dir — nothing is ever read to decide.
func (e *Exporter) pruneEmptyGroups() {
	for _, sub := range []string{docsSub, annsSub} {
		entries, err := os.ReadDir(filepath.Join(e.dir, sub))
		if err != nil {
			continue
		}
		for _, ent := range entries {
			if ent.IsDir() {
				_ = os.Remove(filepath.Join(e.dir, sub, ent.Name()))
			}
		}
	}
}

// pruneGroupDir removes the grouping subfolder a departing note left empty
// (documents/2019-W10), so a regrouping doesn't litter the vault with empty
// dirs Obsidian still shows. os.Remove refuses a non-empty directory, so it
// doubles as the emptiness check; documents/, annotations/ and assets/ are never
// candidates because they sit directly under dir (no separator in their parent).
func pruneGroupDir(dir, rel string) {
	i := strings.LastIndex(rel, "/")
	if i < 0 {
		return
	}
	if sub := rel[:i]; strings.Contains(sub, "/") {
		_ = os.Remove(filepath.Join(dir, sub))
	}
}

// relBase returns the basename of a slash-separated vault-relative path.
func relBase(rel string) string {
	return rel[strings.LastIndex(rel, "/")+1:]
}

func relBaseNames(rels []string) []string {
	out := make([]string, len(rels))
	for i, r := range rels {
		out[i] = relBase(r)
	}
	return out
}

// upPrefix returns "../" per folder the note sits below the export dir, so
// asset links resolve back to dir/assets/.
func upPrefix(rel string) string {
	return strings.Repeat("../", strings.Count(rel, "/"))
}

// groupDir maps a timestamp to the configured date subfolder ("" = flat).
func (e *Exporter) groupDir(ts string) string {
	if e.grouping == "" || e.grouping == "none" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return ""
	}
	switch e.grouping {
	case "daily":
		return t.Format("2006-01-02")
	case "weekly":
		y, w := t.ISOWeek()
		return fmt.Sprintf("%04d-W%02d", y, w)
	case "monthly":
		return t.Format("2006-01")
	}
	return ""
}

// docDate picks the date a doc is grouped by: published when known, else created.
func docDate(doc store.Document) string {
	if doc.PublishedAt != nil && *doc.PublishedAt != "" {
		return *doc.PublishedAt
	}
	return doc.CreatedAt
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
	rel := e.docFiles[id]
	delete(e.docFiles, id)
	e.mu.Unlock()
	return removeIfPresent(e.dir, rel)
}

// removeAnnotation deletes our note for a tombstoned annotation.
func (e *Exporter) removeAnnotation(id string) error {
	e.mu.Lock()
	rel := e.annFiles[id]
	delete(e.annFiles, id)
	e.mu.Unlock()
	return removeIfPresent(e.dir, rel)
}

// removeIfPresent deletes dir/rel and prunes the grouping folder it emptied.
func removeIfPresent(dir, rel string) error {
	if rel == "" {
		return nil
	}
	err := os.Remove(filepath.Join(dir, rel))
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove note %s: %w", rel, err)
	}
	pruneGroupDir(dir, rel)
	return nil
}

// docRelPath returns a stable vault-relative path for a doc note: reuse the
// existing one if still in the right grouping folder, else a slug of the title
// under documents/<group>/, avoiding collisions.
func (e *Exporter) docRelPath(doc store.Document, group string) string {
	dir := docsSub
	if group != "" {
		dir += "/" + group
	}
	e.mu.Lock()
	if rel, ok := e.docFiles[doc.ID]; ok && filepath.Dir(rel) == filepath.FromSlash(dir) {
		e.mu.Unlock()
		return rel
	}
	e.mu.Unlock()

	base := slug(doc.Title)
	if base == "" {
		base = slug(doc.ID)
	}
	name := base + ".md"
	if e.docNameFree(dir, name, doc.ID) {
		return dir + "/" + name
	}
	return dir + "/" + base + "-" + short(doc.ID) + ".md"
}

// annRelPath returns a stable vault-relative path for an annotation note.
// Annotations have no title, so the id suffix guarantees uniqueness without
// collision handling.
func (e *Exporter) annRelPath(a store.Annotation, group string) string {
	dir := annsSub
	if group != "" {
		dir += "/" + group
	}
	e.mu.Lock()
	if rel, ok := e.annFiles[a.ID]; ok && filepath.Dir(rel) == filepath.FromSlash(dir) {
		e.mu.Unlock()
		return rel
	}
	e.mu.Unlock()

	base := slug(firstLine(a.Note))
	if base == "" {
		base = slug(a.Exact)
	}
	if base == "" {
		base = "annotation"
	}
	return dir + "/" + base + "-" + short(a.ID) + ".md"
}

// docNameFree reports whether name is unclaimed by another doc and not a foreign
// file already in dir.
func (e *Exporter) docNameFree(dir, name, id string) bool {
	e.mu.Lock()
	for oid, rel := range e.docFiles {
		if rel == dir+"/"+name && oid != id {
			e.mu.Unlock()
			return false
		}
	}
	e.mu.Unlock()
	_, err := os.Stat(filepath.Join(e.dir, dir, name))
	return os.IsNotExist(err)
}

// writeIndex regenerates the _index.md MOC linking every owned doc note.
func (e *Exporter) writeIndex() {
	e.mu.Lock()
	rels := make([]string, 0, len(e.docFiles))
	for _, rel := range e.docFiles {
		rels = append(rels, rel)
	}
	e.mu.Unlock()
	sort.Strings(rels)

	var b strings.Builder
	b.WriteString("---\n" + indexMark + "\ntitle: Samizdat Export\n---\n\n# Samizdat Export\n\n")
	fmt.Fprintf(&b, "%d documents.\n\n", len(rels))
	for _, rel := range rels {
		// Obsidian wikilinks resolve by basename across folders.
		fmt.Fprintf(&b, "- [[%s]]\n", strings.TrimSuffix(relBase(rel), ".md"))
	}
	path := filepath.Join(e.dir, indexName)
	if body := []byte(b.String()); !unchanged(path, body) {
		_ = os.WriteFile(path, body, 0o644)
	}
}

func (e *Exporter) setErr(err error) {
	e.mu.Lock()
	e.lastErr = err.Error()
	e.mu.Unlock()
}

// --- rendering ---

func renderDoc(doc store.Document, annos []store.Annotation, annNames []string, tags []store.Tag, links map[string]assetLink) []byte {
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
	hero, hasHero := links[doc.HeroImageUrl]
	if hasHero {
		fmt.Fprintf(&b, "hero: %s\n", yamlStr(hero.path()))
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
	if hasHero {
		fmt.Fprintf(&b, "%s\n\n", hero.embed(""))
	}
	b.WriteString(strings.TrimRight(rewriteImages(doc.Markdown, links), "\n"))
	b.WriteString("\n")

	if len(annos) > 0 {
		b.WriteString("\n## Annotations\n\n")
		for i := range annos {
			fmt.Fprintf(&b, "- [[%s]]\n", strings.TrimSuffix(annNames[i], ".md"))
		}
	}
	return []byte(b.String())
}

// renderAnnotation renders an annotation note. When docName is empty the
// annotation is a standalone note (no parent Document): the `document:` backlink
// and the "From [[doc]]" quote header are omitted.
func renderAnnotation(a store.Annotation, docName string, links map[string]assetLink) []byte {
	standalone := strings.TrimSuffix(docName, ".md") == ""
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", a.ID)
	b.WriteString(annMark + "\n")
	if !standalone {
		fmt.Fprintf(&b, "document: %s\n", yamlStr("[["+strings.TrimSuffix(docName, ".md")+"]]"))
	}
	if a.Color != "" {
		fmt.Fprintf(&b, "color: %s\n", yamlStr(a.Color))
	}
	if a.MediaTsMs > 0 {
		fmt.Fprintf(&b, "media_ts: %s\n", yamlStr(msToTS(a.MediaTsMs)))
	}
	fmt.Fprintf(&b, "pos: %s\n", yamlStr(fmt.Sprintf("%d-%d", a.PosStart, a.PosEnd)))
	fmt.Fprintf(&b, "created: %s\n", yamlStr(a.CreatedAt))
	b.WriteString("---\n\n")

	if standalone {
		b.WriteString("> [!note]\n")
	} else {
		fmt.Fprintf(&b, "> [!quote] From [[%s]]\n", strings.TrimSuffix(docName, ".md"))
	}
	if strings.TrimSpace(a.Exact) != "" {
		for _, ln := range strings.Split(rewriteImages(a.Exact, links), "\n") {
			b.WriteString("> " + ln + "\n")
		}
	}
	if strings.TrimSpace(a.Note) != "" {
		b.WriteString("\n" + strings.TrimRight(rewriteImages(a.Note, links), "\n") + "\n")
	}
	return []byte(b.String())
}

// exportStandaloneNote writes a document-less annotation (a standalone note) as
// its own note file, with no parent-doc backlink.
func (e *Exporter) exportStandaloneNote(a store.Annotation) error {
	rel := e.annRelPath(a, e.groupDir(a.CreatedAt))
	note := renderAnnotation(a, "", nil)
	if err := writeNote(e.dir, rel, note); err != nil {
		return fmt.Errorf("write standalone note %s: %w", rel, err)
	}
	e.mu.Lock()
	old := e.annFiles[a.ID]
	e.annFiles[a.ID] = rel
	e.mu.Unlock()
	removeIfMoved(e.dir, old, rel)
	return nil
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

// assetLink is one copied image, as referenced from a note at a known depth.
type assetLink struct {
	file  string // basename under assets/, e.g. "<uuid>.jpg"
	style string // wikilink|relative
	up    string // "../" per folder the note sits below the export dir
}

// embed renders the markdown for this asset. Wikilink style drops the path
// entirely — Obsidian resolves `![[<file>]]` by name, so the note keeps working
// when it (or assets/) is moved inside the vault. Alt text rides along as the
// wikilink alias (`|`), which Obsidian renders as the image's alt; a numeric-only
// alias would be read as a width, and `|`/`]` would break the link, so those are
// dropped.
func (a assetLink) embed(alt string) string {
	if a.style != linkWikilink {
		return "![" + alt + "](" + a.path() + ")"
	}
	if alt = wikiAlias(alt); alt != "" {
		return "![[" + a.file + "|" + alt + "]]"
	}
	return "![[" + a.file + "]]"
}

// wikiAlias sanitizes alt text for use as a wikilink alias, returning "" when
// nothing usable is left.
func wikiAlias(alt string) string {
	alt = strings.NewReplacer("|", " ", "[", " ", "]", " ", "\n", " ").Replace(alt)
	alt = strings.Join(strings.Fields(alt), " ")
	if _, err := strconv.Atoi(alt); err == nil {
		return "" // a bare number is a width directive, not a caption
	}
	return alt
}

// path is the vault-relative path to the copied file (used for frontmatter,
// which cannot carry an embed).
func (a assetLink) path() string {
	return a.up + assetsSub + "/" + a.file
}

// atDepth re-bases links for a note whose folder depth differs from the doc note
// they were built for (an annotation groups by its own created date). Only the
// relative embed style reads `up`, but a wrong prefix there is a dead image.
func atDepth(links map[string]assetLink, rel string) map[string]assetLink {
	up := upPrefix(rel)
	out := make(map[string]assetLink, len(links))
	for k, l := range links {
		l.up = up
		out[k] = l
	}
	return out
}

// assetLinks copies a document's images into assets/ and maps every URL they can
// appear under in the markdown → the copied file. Two keys per asset: the source
// URL (web scrapes keep the original http URL) and `/api/v1/media/<id>` (PDF
// figures and pipeline-injected hero images are written as server media routes,
// whose original_url is a synthetic `pdf://…` that appears nowhere in the body).
func (e *Exporter) assetLinks(assets []store.MediaAsset, docRel string) map[string]assetLink {
	up := upPrefix(docRel)
	links := map[string]assetLink{}
	for _, a := range assets {
		if a.DeletedAt != nil || a.Kind == "audio" || a.LocalPath == "" {
			continue
		}
		fname := filepath.Base(a.LocalPath)
		if err := e.copyAsset(a.LocalPath, fname); err != nil {
			e.log.Warnf("copy asset %s: %v", fname, err)
			continue
		}
		l := assetLink{file: fname, style: e.imageLinks, up: up}
		if a.OriginalUrl != "" {
			links[a.OriginalUrl] = l
		}
		links[mediaRoute+a.ID] = l
	}
	return links
}

// mediaRoute is the server route images are rewritten to in stored markdown.
const mediaRoute = "/api/v1/media/"

// mdImageRe matches a markdown image embed, capturing alt and target.
var mdImageRe = regexp.MustCompile(`!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)

// rewriteImages swaps every markdown image whose target is a known asset for the
// configured embed style. Images with no copied asset (download skipped or
// failed) are left as they were — a broken link beats a dangling embed.
func rewriteImages(s string, links map[string]assetLink) string {
	if len(links) == 0 {
		return s
	}
	return mdImageRe.ReplaceAllStringFunc(s, func(m string) string {
		g := mdImageRe.FindStringSubmatch(m)
		l, ok := links[g[2]]
		if !ok {
			return m
		}
		return l.embed(g[1])
	})
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
