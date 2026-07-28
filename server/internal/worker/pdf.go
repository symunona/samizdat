package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/ledongthuc/pdf"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

// maxPDFBytes caps a PDF download. The whole file is buffered in memory (the
// reader needs random access) and this box has 4GB — a paper is ~1-5MB, so
// anything past this is a book scan we would not usefully extract anyway.
const maxPDFBytes = 64 << 20

// pdfMediaMetadata is the media_metadata JSON for a media_type='pdf' Document.
type pdfMediaMetadata struct {
	Pages int   `json:"pages"`
	Bytes int64 `json:"bytes"`
}

// isPDFURL reports whether the URL path names a PDF. Cheap pre-check that skips
// the browser entirely — Chromium answers a PDF navigation with "Download is
// starting" and no page, which is what killed these scrapes before.
func isPDFURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.HasSuffix(strings.ToLower(path.Base(u.Path)), ".pdf")
}

// isBrowserDownloadErr reports whether a browser fetch failed because the target
// was a file download rather than a page. Extension-less PDF URLs only reveal
// themselves this way, so this is the trigger for the content-type retry.
func isBrowserDownloadErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Download is starting")
}

// handlePDF ingests a PDF URL into a media_type='pdf' Document: plain HTTP GET
// (no browser), pure-Go text extraction, then the shared Document finalize.
func handlePDF(ctx context.Context, q *store.Queries, job store.Job, canonical string, feedID *string, manual bool) (string, error) {
	logScraper.Printf("scraping pdf %s", canonical)

	raw, err := fetchPDF(ctx, canonical)
	if err != nil {
		return "", fmt.Errorf("fetch pdf: %w", err)
	}
	logScraper.Printf("fetched %d bytes PDF from %s", len(raw), canonical)

	doc, err := extractPDF(raw)
	if err != nil {
		return "", fmt.Errorf("extract pdf: %w", err)
	}

	title := doc.title
	if title == "" {
		title = pdfTitleFromURL(canonical)
	}
	md := doc.text

	excerpt := firstRunes(strings.ReplaceAll(md, "\n", " "), 500)

	metaJSON, _ := json.Marshal(pdfMediaMetadata{Pages: doc.pages, Bytes: int64(len(raw))})

	logScraper.Printf("extracted pdf: title=%q author=%q pages=%d md=%d chars", title, doc.author, doc.pages, len(md))

	now := time.Now().UTC().Format(time.RFC3339)
	sum := sha256.Sum256([]byte(md))

	stored, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID:            IDFromURL(canonical),
		CanonicalUrl:  canonical,
		Title:         title,
		Markdown:      md,
		FetchedAt:     now,
		Excerpt:       excerpt,
		Author:        doc.author,
		SourceFeedID:  feedID,
		ContentHash:   hex.EncodeToString(sum[:]),
		MediaType:     "pdf",
		MediaMetadata: string(metaJSON),
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		return "", fmt.Errorf("insert document: %w", err)
	}

	logScraper.Printf("upserted pdf document %s for %s", stored.ID[:8], canonical)

	// A scanned (image-only) PDF has no text layer, so extraction yields nothing
	// usable. Flag the Document and fail permanently rather than retry — the
	// result is deterministic, and an empty body would feed the pipeline junk.
	if fpe := pipeline.DetectFalseParse(title, md); fpe != nil {
		logScraper.Warnf("false parse for %s: %s — flagging document, no pipeline", canonical, fpe.Reason)
		return "", flagFalseParse(ctx, q, stored.ID, fpe)
	}

	finishDocument(ctx, q, job, stored, title, manual)

	res, _ := json.Marshal(map[string]any{
		"document_id": stored.ID, "title": title, "media_type": "pdf", "pages": doc.pages,
	})
	return string(res), nil
}

// fetchPDF downloads the PDF body over plain HTTP, refusing non-PDF responses
// and anything past maxPDFBytes.
func fetchPDF(ctx context.Context, rawURL string) ([]byte, error) {
	body, ct, err := httpGet(ctx, rawURL)
	if err != nil {
		return nil, fmt.Errorf("download: %w", err)
	}
	if !isPDFContentType(ct) && !bytes.HasPrefix(body, []byte("%PDF-")) {
		return nil, fmt.Errorf("not a pdf (content-type %q)", ct)
	}
	return body, nil
}

// httpGet fetches rawURL with the shared Samizdat UA, returning the body (capped
// at maxPDFBytes) and its Content-Type.
func httpGet(ctx context.Context, rawURL string) ([]byte, string, error) {
	client := &http.Client{Timeout: 60 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("get %s: %w", rawURL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxPDFBytes+1))
	if err != nil {
		return nil, "", fmt.Errorf("read body: %w", err)
	}
	if len(body) > maxPDFBytes {
		return nil, "", fmt.Errorf("pdf larger than %d bytes", maxPDFBytes)
	}
	return body, resp.Header.Get("Content-Type"), nil
}

// isPDFContentType reports whether a Content-Type header names a PDF.
func isPDFContentType(ct string) bool {
	return strings.HasPrefix(strings.TrimSpace(strings.ToLower(ct)), "application/pdf")
}

// urlIsPDF probes rawURL and reports whether it actually serves a PDF. Used only
// after the browser refused a URL as a download, so the extra GET is never on the
// happy path.
func urlIsPDF(ctx context.Context, rawURL string) bool {
	body, ct, err := httpGet(ctx, rawURL)
	if err != nil {
		return false
	}
	return isPDFContentType(ct) || bytes.HasPrefix(body, []byte("%PDF-"))
}

// pdfDoc is the outcome of a text extraction pass.
type pdfDoc struct {
	text   string
	title  string
	author string
	pages  int
}

// extractPDF pulls the text layer out of a PDF as markdown-ish plain text.
//
// It works from the raw glyph stream (Page.Content().Text) rather than the
// library's GetPlainText/GetTextByRow helpers: those concatenate glyphs and drop
// the per-glyph geometry, and most typeset PDFs (LaTeX especially) encode word
// breaks as positioning rather than space glyphs — so the helpers return
// "WhyareallLLMs". Rebuilding from coordinates restores the spaces.
func extractPDF(raw []byte) (pdfDoc, error) {
	r, err := pdf.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return pdfDoc{}, fmt.Errorf("read pdf: %w", err)
	}

	out := pdfDoc{pages: r.NumPage()}
	info := r.Trailer().Key("Info")
	out.title = strings.TrimSpace(info.Key("Title").Text())
	out.author = strings.TrimSpace(info.Key("Author").Text())

	// The column gutter is a property of the document, not of a page: a page whose
	// left column happens to run short (a title page, a page ending mid-section)
	// gives too weak a signal on its own. So measure it across every page first,
	// then render with the one boundary. Two passes over the content streams keeps
	// peak memory at one page of glyphs.
	bound := documentGutter(r)

	var sb strings.Builder
	for i := 1; i <= r.NumPage(); i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		if txt := pageText(p.Content().Text, bound); txt != "" {
			sb.WriteString(txt)
			sb.WriteString("\n\n")
		}
	}
	out.text = reflowParagraphs(stripLineMarks(strings.TrimSpace(sb.String())))
	return out, nil
}

// reflowParagraphs joins lines that the typesetter wrapped back into paragraphs.
//
// A PDF has no paragraphs, only positioned lines, so extraction yields one line
// per printed line — which reads as a column of fragments and splits sentences
// mid-clause for anything downstream. A wrapped line is recognisable by running
// (nearly) the full column width; a line that stops short ended its paragraph.
//
// A line-final hyphen joins the halves and is dropped ("tax-\nonomy" →
// "taxonomy") unless the document uses that exact hyphenated compound elsewhere
// ("proof-of-\nwork" where "proof-of-work" appears mid-line), which is the one
// signal available for telling a syllable break from a real compound without a
// dictionary. Typesetters break at an existing hyphen by preference, so this
// case is common enough to be worth the lookup.
func reflowParagraphs(text string) string {
	lines := strings.Split(text, "\n")
	full := fullLineWidth(lines)
	if full == 0 {
		return text
	}
	compounds := hyphenatedCompounds(lines)

	var out []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, ln := range lines {
		if strings.TrimSpace(ln) == "" {
			flush()
			continue
		}
		if cur.Len() > 0 {
			if s := cur.String(); strings.HasSuffix(s, "-") {
				if !compounds[hyphenJoin(s, ln)] {
					cur.Reset()
					cur.WriteString(strings.TrimSuffix(s, "-"))
				}
			} else {
				cur.WriteByte(' ')
			}
		}
		cur.WriteString(ln)
		// A line ending in a hyphen is mid-word, so it cannot end a paragraph
		// however short it looks.
		if len([]rune(ln)) < full && !strings.HasSuffix(ln, "-") {
			flush()
		}
	}
	flush()
	return strings.Join(out, "\n\n")
}

// hyphenatedCompounds collects the hyphenated words a document writes whole on
// one line — the compounds its author actually uses, lowercased.
func hyphenatedCompounds(lines []string) map[string]bool {
	out := map[string]bool{}
	for _, ln := range lines {
		for _, f := range strings.Fields(ln) {
			f = strings.Trim(f, wordPunct)
			if strings.Contains(f, "-") && !strings.HasPrefix(f, "-") && !strings.HasSuffix(f, "-") {
				out[strings.ToLower(f)] = true
			}
		}
	}
	return out
}

// hyphenJoin builds the hyphenated word a line break would split: the trailing
// word of the line ending in "-" plus the leading word of the next.
func hyphenJoin(prev, next string) string {
	fields := strings.Fields(prev)
	if len(fields) == 0 {
		return ""
	}
	head := strings.TrimLeft(fields[len(fields)-1], wordPunct)
	fields = strings.Fields(next)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToLower(head + strings.Trim(fields[0], wordPunct))
}

// fullLineWidth is the width a wrapped line reaches, as a rune count.
//
// Most lines in a body of text ARE wrapped lines, so the commonest width is the
// column width. The *mode* is used rather than the median because a document
// mixes widths — a two-column paper also has full-page headings, tables and
// reference blocks, and their pull drags a median above the body width, which
// then reads every body line as a paragraph end. The result is shaded down a
// fifth so the ragged right edge of justified text still counts as full.
// Returns 0 when there is too little text to judge.
func fullLineWidth(lines []string) int {
	const bucket = 5
	counts := map[int]int{}
	total, mode, best := 0, 0, 0
	for _, ln := range lines {
		w := len([]rune(ln))
		if w == 0 {
			continue
		}
		total++
		b := w / bucket
		counts[b]++
		if counts[b] > best || (counts[b] == best && b < mode) {
			mode, best = b, counts[b]
		}
	}
	if total < 8 {
		return 0
	}
	return mode * bucket * 4 / 5
}

// stripLineMarks removes a per-document line-terminator glyph.
//
// Some producers (OpenOffice is the one seen here — bitcoin.pdf) paint their
// line break as a real, positive-width glyph whose font encoding decodes to an
// ordinary letter, so every line comes out as "Satoshi Nakamotok". There is no
// way to tell it apart from text one line at a time; across a document it gives
// itself away by ending nearly every line. A letter genuinely ending half a
// document's lines does not happen in prose, and line-final punctuation — which
// does repeat legitimately — is never treated as a mark.
// Only the line mark is stripped: such a producer usually paints a rarer second
// glyph for the paragraph break too, but it lands on headings only — too few
// lines to tell from real text, and harmless where it survives.
func stripLineMarks(text string) string {
	lines := strings.Split(text, "\n")
	mark, ok := dominantLineMark(lines)
	if !ok {
		return text
	}
	for i, ln := range lines {
		if r := []rune(strings.TrimRight(ln, " ")); len(r) > 1 && r[len(r)-1] == mark {
			lines[i] = strings.TrimRight(string(r[:len(r)-1]), " ")
		}
	}
	return strings.Join(lines, "\n")
}

// dominantLineMark reports the rune ending the majority of a document's
// candidate lines, if there is one. Candidates exclude lines ending in
// punctuation, which repeats legitimately in prose.
func dominantLineMark(lines []string) (rune, bool) {
	counts := map[rune]int{}
	pool := 0
	for _, ln := range lines {
		r := []rune(strings.TrimRight(ln, " "))
		if len(r) < 2 || strings.ContainsRune(lineFinalPunct, r[len(r)-1]) {
			continue
		}
		counts[r[len(r)-1]]++
		pool++
	}
	mark, best := rune(0), 0
	for r, n := range counts {
		if n > best {
			mark, best = r, n
		}
	}
	return mark, best*2 >= pool && best > 1
}

// documentGutter finds the x where the second column starts, or +Inf when the
// document is single-column. Lines that carry both columns' text on one baseline
// each vote for the gutter they were cut at; a real two-column layout produces a
// steady stream of votes at the same x, while a single-column one produces only
// the odd stray from a wide table or a right-aligned page number.
func documentGutter(r *pdf.Reader) float64 {
	var votes []float64
	lines := 0
	for i := 1; i <= r.NumPage(); i++ {
		p := r.Page(i)
		if p.V.IsNull() {
			continue
		}
		for _, ln := range groupLines(p.Content().Text) {
			lines++
			votes = append(votes, gutterVotes(ln)...)
		}
	}
	if len(votes) < 3 || len(votes)*20 < lines {
		return math.Inf(1)
	}
	sort.Float64s(votes)
	return votes[len(votes)/2] - pdfGutterMargin // median — robust to tables and captions
}

// Layout thresholds, all relative to font size so they hold at any zoom.
const (
	// A horizontal gap wider than this fraction of the font size is a word break.
	// Intra-word glyph gaps are ~0; inter-word gaps run ~0.25em.
	pdfWordGapRatio = 0.15
	// A gap this wide is a column gutter, not a space — the two sides belong to
	// different text blocks and must not be read as one line.
	pdfColumnGapRatio = 2.5
	// Glyph baselines within this fraction of the font size are the same line.
	pdfLineTolRatio = 0.5
	// Whitespace at the gutter, as a fraction of the font size. Comfortably above
	// a justified line's stretched word space and below a real column gap.
	pdfGutterMinGapRatio = 0.75
	// Points to pull the boundary left of the observed column edge, so a line
	// whose first glyph sits a hair left of the usual edge is not split off it.
	pdfGutterMargin = 4
)

// Punctuation that hugs the word beside it, whatever the glyph positions say.
const (
	closingPunct = ",.;:!?)]}"
	openingPunct = "([{"
	// Characters that legitimately end many lines, so they can never be mistaken
	// for a producer's line-terminator glyph.
	lineFinalPunct = ",.;:!?-–—)]}\"'"
	// Punctuation stripped from a token before comparing it as a word.
	wordPunct = ".,;:!?()[]{}\"'"
)

// pdfFrag is one same-column run of text on a line, tagged with the x it starts
// at so fragments can be re-grouped into columns.
type pdfFrag struct {
	x    float64
	text string
}

// pageText reconstructs a page's reading order from positioned glyphs: group by
// baseline into lines, split lines at the column gutter, then emit each column's
// lines top-to-bottom, left column first. A bound of +Inf means single-column,
// which degenerates to plain baseline order.
func pageText(glyphs []pdf.Text, bound float64) string {
	// Split every line at the gutter, so a line carrying both columns becomes two
	// fragments, each tagged with the x it starts at.
	var frags []pdfFrag
	for _, ln := range groupLines(glyphs) {
		for _, seg := range splitAtGutter(ln, bound) {
			if s := renderSegment(seg); s != "" {
				frags = append(frags, pdfFrag{x: seg[0].X, text: s})
			}
		}
	}

	// Order fragments by column, preserving the top-to-bottom order groupLines
	// already established within each column.
	var left, right []string
	for _, f := range frags {
		if f.x < bound {
			left = append(left, f.text)
		} else {
			right = append(right, f.text)
		}
	}
	return strings.Join(append(left, right...), "\n")
}

// groupLines buckets glyphs into lines by baseline (Y), each sorted left to
// right, and the lines themselves ordered top to bottom.
func groupLines(glyphs []pdf.Text) [][]pdf.Text {
	if len(glyphs) == 0 {
		return nil
	}
	sorted := make([]pdf.Text, len(glyphs))
	copy(sorted, glyphs)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Y != sorted[j].Y {
			return sorted[i].Y > sorted[j].Y // PDF origin is bottom-left
		}
		return sorted[i].X < sorted[j].X
	})

	var lines [][]pdf.Text
	cur := []pdf.Text{sorted[0]}
	for _, g := range sorted[1:] {
		tol := pdfLineTolRatio * g.FontSize
		if math.Abs(g.Y-cur[0].Y) > tol {
			lines = append(lines, cur)
			cur = nil
		}
		cur = append(cur, g)
	}
	lines = append(lines, cur)

	for _, ln := range lines {
		sort.SliceStable(ln, func(i, j int) bool { return ln[i].X < ln[j].X })
	}
	return lines
}

// gutterVotes returns the x of every gutter-sized horizontal gap in a line.
//
// Only lines whose left column runs short vote: between two *full-width* column
// lines the gap is barely wider than a stretched word space, far too ambiguous
// to cut on. That is why detection and cutting are separate steps — this pass
// stays conservative and the exact gutter it finds is what does the cutting.
func gutterVotes(line []pdf.Text) []float64 {
	var votes []float64
	for i := 1; i < len(line); i++ {
		if glyphGap(line[i-1], line[i]) > pdfColumnGapRatio*fontSize(line[i-1], line[i]) {
			votes = append(votes, line[i].X)
		}
	}
	return votes
}

// splitAtGutter cuts a line into its per-column runs at the known gutter x.
//
// The cut also has to land on real whitespace: a heading or title that spans the
// full page crosses the gutter x mid-sentence, and there the neighbouring glyphs
// are one word space apart, not a column apart. Such a line stays whole.
func splitAtGutter(line []pdf.Text, bound float64) [][]pdf.Text {
	for i := 1; i < len(line); i++ {
		if line[i].X >= bound &&
			glyphGap(line[i-1], line[i]) > pdfGutterMinGapRatio*fontSize(line[i-1], line[i]) {
			return [][]pdf.Text{line[:i], line[i:]}
		}
	}
	return [][]pdf.Text{line}
}

// renderSegment turns one run of same-line glyphs into text, inserting a space
// wherever the glyphs were positioned apart rather than typed apart.
//
// Whitespace glyphs (content streams emit zero-width "\n" runs between typeset
// blocks) collapse to a single space: they are separators in the stream, not
// line breaks on the page — the page's real lines come from the baselines.
func renderSegment(seg []pdf.Text) string {
	var sb strings.Builder
	pending := false
	for i, g := range seg {
		if strings.TrimSpace(g.S) == "" {
			pending = true
			continue
		}
		if i > 0 && glyphGap(seg[i-1], g) > pdfWordGapRatio*fontSize(seg[i-1], g) {
			pending = true
		}
		// Hyperlinked runs (citations) come through as separately positioned
		// chunks, so the gap test alone strands the trailing comma: "et al. , 2024".
		// Closing punctuation never takes a leading space.
		if pending && sb.Len() > 0 &&
			!strings.ContainsRune(closingPunct, rune(g.S[0])) &&
			!strings.ContainsRune(openingPunct, rune(sb.String()[sb.Len()-1])) {
			sb.WriteByte(' ')
		}
		pending = false
		sb.WriteString(g.S)
	}
	return strings.TrimSpace(sb.String())
}

// glyphGap is the horizontal whitespace between the end of a and the start of b.
func glyphGap(a, b pdf.Text) float64 { return b.X - (a.X + a.W) }

// fontSize picks a usable size from a glyph pair (either may report zero).
func fontSize(a, b pdf.Text) float64 {
	if b.FontSize > 0 {
		return b.FontSize
	}
	if a.FontSize > 0 {
		return a.FontSize
	}
	return 10 // PDF default-ish; only reached when the page declares no size
}

// pdfTitleFromURL falls back to the file name when the PDF declares no title.
func pdfTitleFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	name := path.Base(u.Path)
	if name == "." || name == "/" || name == "" {
		return rawURL
	}
	// Only ever strip ".pdf" — an arXiv id like "2604.21751" is all name, and
	// path.Ext would eat half of it.
	if ext := path.Ext(name); strings.EqualFold(ext, ".pdf") {
		name = strings.TrimSuffix(name, ext)
	}
	return name
}

// firstRunes truncates s to at most n runes (never mid-rune, unlike s[:n]).
func firstRunes(s string, n int) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
