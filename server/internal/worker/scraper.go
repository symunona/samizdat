package worker

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
	"github.com/google/uuid"
	trafilatura "github.com/markusmobius/go-trafilatura"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

type scrapePayload struct {
	URL    string  `json:"url"`
	FeedID *string `json:"feed_id,omitempty"`
	Manual bool    `json:"manual,omitempty"`
}

var mdLinkRe = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)

var utmParams = []string{
	"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
	"fbclid", "gclid", "msclkid", "mc_eid",
}

func canonicalize(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}
	u.Fragment = ""
	q := u.Query()
	for _, p := range utmParams {
		q.Del(p)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func handleScrapeURL(ctx context.Context, q *store.Queries, job store.Job, browser *BrowserPool) (string, error) {
	var p scrapePayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}

	canonical, err := canonicalize(p.URL)
	if err != nil {
		return "", err
	}

	logScraper.Printf("scraping %s", canonical)

	htmlStr, err := browser.FetchHTML(canonical)
	if err != nil {
		return "", fmt.Errorf("fetch: %w", err)
	}
	bodyBytes := []byte(htmlStr)
	logScraper.Printf("fetched %d bytes HTML from %s", len(bodyBytes), canonical)

	// Lift <figure>-wrapped images into plain <p><img> so trafilatura keeps them
	// inline at their real position (it discards <figure> but keeps <img> in <p>).
	extractHTML := unwrapFigureImages(bodyBytes)

	extracted, err := trafilatura.Extract(bytes.NewReader(extractHTML), trafilatura.Options{
		OriginalURL:     mustParseURL(canonical),
		ExcludeComments: true,
		EnableFallback:  true,
		IncludeImages:   true,
		IncludeLinks:    true,
	})
	if err != nil {
		return "", fmt.Errorf("trafilatura: %w", err)
	}

	conv := converter.NewConverter(
		converter.WithPlugins(base.NewBasePlugin(), commonmark.NewCommonmarkPlugin()),
	)
	// render content node to HTML first, then convert to markdown
	var htmlBuf strings.Builder
	if extracted.ContentNode != nil {
		if err := renderNode(&htmlBuf, extracted.ContentNode); err != nil {
			return "", fmt.Errorf("render html: %w", err)
		}
	}
	md, err := conv.ConvertString(htmlBuf.String())
	if err != nil {
		return "", fmt.Errorf("html→md: %w", err)
	}
	if strings.TrimSpace(md) == "" {
		md = extracted.ContentText
	}

	// Prepend any lead bullet lists that trafilatura skipped.
	if leadLists := extractLeadLists(bodyBytes, md); leadLists != "" {
		md = leadLists + "\n\n" + md
	}

	title := strings.TrimSpace(extracted.Metadata.Title)

	excerpt := strings.TrimSpace(extracted.Metadata.Description)
	if len(excerpt) > 500 {
		excerpt = excerpt[:500]
	}
	heroImageURL := strings.TrimSpace(extracted.Metadata.Image)
	author := strings.TrimSpace(extracted.Metadata.Author)

	// Original article publish date (nil if the page exposed none).
	var publishedAt *string
	if !extracted.Metadata.Date.IsZero() {
		pa := extracted.Metadata.Date.UTC().Format(time.RFC3339)
		publishedAt = &pa
	}

	logScraper.Printf("extracted: title=%q  author=%q  published=%v  md=%d chars", title, author, publishedAt, len(md))

	now := time.Now().UTC().Format(time.RFC3339)
	docID := IDFromURL(canonical)

	// content_hash = sha256(markdown): lets re-scrapes of unchanged content skip
	// needless pipeline regeneration (see worker/pipeline.go skip guard).
	sum := sha256.Sum256([]byte(md))
	contentHash := hex.EncodeToString(sum[:])

	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID:           docID,
		CanonicalUrl: canonical,
		Title:        title,
		Markdown:     md,
		FetchedAt:    now,
		Excerpt:      excerpt,
		HeroImageUrl: heroImageURL,
		Author:       author,
		PublishedAt:  publishedAt,
		SourceFeedID: p.FeedID,
		ContentHash:  contentHash,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		return "", fmt.Errorf("insert document: %w", err)
	}

	logScraper.Printf("upserted document %s for %s", doc.ID[:8], canonical)

	// Enqueue asset fetching job.
	parentID := job.ID
	assetPayload, _ := json.Marshal(map[string]string{"document_id": doc.ID, "document_title": title})
	_, err = q.InsertJob(ctx, store.InsertJobParams{
		ID:          uuid.NewString(),
		Kind:        "fetch_assets",
		Payload:     string(assetPayload),
		RunAfter:    now,
		CreatedAt:   now,
		UpdatedAt:   now,
		ParentJobID: &parentID,
	})
	if err != nil {
		return "", fmt.Errorf("enqueue fetch_assets: %w", err)
	}

	// Trigger matching pipelines. Hold if the scrape was from a manual poll —
	// the user controls when pipeline jobs run in that case.
	triggerPipelines(ctx, q, doc, now, &parentID, p.Manual)

	jobResult, _ := json.Marshal(map[string]string{"document_id": doc.ID, "title": title})
	return string(jobResult), nil
}

// triggerPipelines checks all enabled on_new_document pipelines and enqueues runs for matches.
// When hold is true the jobs are inserted as paused so the user can review before resuming.
func triggerPipelines(ctx context.Context, q *store.Queries, doc store.Document, now string, parentJobID *string, hold bool) {
	pipelines, err := q.ListEnabledPipelines(ctx)
	if err != nil {
		logScraper.Errorf("pipeline trigger: list pipelines: %v", err)
		return
	}
	if len(pipelines) == 0 {
		return
	}

	// Resolve feed URL if document came from a feed.
	feedURL := ""
	if doc.SourceFeedID != nil {
		if feed, err := q.GetFeed(ctx, *doc.SourceFeedID); err == nil {
			feedURL = feed.Url
		}
	}

	for _, pl := range pipelines {
		if pl.Trigger != "on_new_document" {
			continue
		}
		if !pipelineMatchesDocument(pl, doc, feedURL) {
			logScraper.Printf("pipeline trigger: %s (%s) skipped (no match)", pl.ID[:8], pl.Name)
			continue
		}
		payload, _ := json.Marshal(map[string]string{
			"pipeline_id":    pl.ID,
			"document_id":    doc.ID,
			"pipeline_name":  pl.Name,
			"document_title": doc.Title,
		})
		jobID := uuid.NewString()
		if hold {
			_, err = q.InsertJobPaused(ctx, store.InsertJobPausedParams{
				ID:          jobID,
				Kind:        "run_pipeline",
				Payload:     string(payload),
				RunAfter:    now,
				CreatedAt:   now,
				UpdatedAt:   now,
				ParentJobID: parentJobID,
			})
		} else {
			_, err = q.InsertJob(ctx, store.InsertJobParams{
				ID:          jobID,
				Kind:        "run_pipeline",
				Payload:     string(payload),
				RunAfter:    now,
				CreatedAt:   now,
				UpdatedAt:   now,
				ParentJobID: parentJobID,
			})
		}
		if err != nil {
			logScraper.Errorf("pipeline trigger: enqueue run for pipeline %s: %v", pl.ID, err)
		} else {
			logScraper.Printf("pipeline trigger: enqueued run_pipeline (hold=%v) for pipeline %s (%s)", hold, pl.ID[:8], pl.Name)
		}
	}
}

func mustParseURL(raw string) *url.URL {
	u, _ := url.Parse(raw)
	return u
}

func renderNode(w io.Writer, n *html.Node) error {
	if err := html.Render(w, n); err != nil {
		return fmt.Errorf("html render: %w", err)
	}
	return nil
}

// extractLeadLists recovers link-free bullet/numbered lists from the raw HTML
// that trafilatura skips (e.g. article summary bullets before the body).
// Returns markdown list lines not already present in extractedMD.
func extractLeadLists(rawHTML []byte, extractedMD string) string {
	root, err := html.Parse(bytes.NewReader(rawHTML))
	if err != nil {
		return ""
	}

	var lists []string
	var walk func(*html.Node, bool)
	walk = func(n *html.Node, inExcluded bool) {
		if n.Type == html.ElementNode {
			tag := n.Data
			// Skip structural noise zones entirely.
			if tag == "nav" || tag == "header" || tag == "footer" ||
				tag == "aside" || tag == "script" || tag == "style" ||
				tag == "noscript" || tag == "form" {
				return
			}
			if tag == "ul" || tag == "ol" {
				if md := listToMarkdown(n, tag == "ol"); md != "" {
					lists = append(lists, md)
				}
				return // don't recurse into lists we already processed
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c, inExcluded)
		}
	}
	walk(root, false)

	var kept []string
	for _, list := range lists {
		// Skip if already represented in the trafilatura output.
		firstLine := strings.SplitN(list, "\n", 2)[0]
		firstLine = strings.TrimLeft(firstLine, "-* 0123456789.")
		firstLine = strings.TrimSpace(firstLine)
		// Use text before the first markdown link for dedup — trafilatura
		// sometimes line-breaks between intro text and link, so the full
		// inline `text [link](url)` string won't appear verbatim.
		checkStr := leadListCheckStr(firstLine)
		if checkStr != "" && !strings.Contains(extractedMD, checkStr) {
			kept = append(kept, list)
		}
	}
	return strings.Join(kept, "\n\n")
}

// listToMarkdown converts a <ul>/<ol> node to markdown if it looks like
// content (≥2 items, each item ≥20 chars). Links inside items are converted
// to [text](url) markdown rather than being dropped.
func listToMarkdown(n *html.Node, ordered bool) string {
	var items []string
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "li" {
			continue
		}
		text := strings.TrimSpace(nodeToMarkdown(c))
		if len(text) < 20 {
			return "" // too short = icon/badge label or nav item
		}
		items = append(items, text)
	}
	if len(items) < 2 {
		return ""
	}
	var sb strings.Builder
	for i, item := range items {
		if ordered {
			fmt.Fprintf(&sb, "%d. %s\n", i+1, item)
		} else {
			fmt.Fprintf(&sb, "- %s\n", item)
		}
	}
	return strings.TrimRight(sb.String(), "\n")
}

// nodeToMarkdown converts an HTML node tree to markdown text, preserving http(s) links.
func nodeToMarkdown(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	if n.Type == html.ElementNode && n.Data == "a" {
		var href string
		for _, attr := range n.Attr {
			if attr.Key == "href" {
				href = attr.Val
				break
			}
		}
		inner := nodeToMarkdown_children(n)
		if href != "" && (strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "https://")) {
			return "[" + inner + "](" + href + ")"
		}
		return inner
	}
	return nodeToMarkdown_children(n)
}

func nodeToMarkdown_children(n *html.Node) string {
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		sb.WriteString(nodeToMarkdown(c))
	}
	return sb.String()
}

func hasElement(n *html.Node, tag string) bool {
	if n.Type == html.ElementNode && n.Data == tag {
		return true
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if hasElement(c, tag) {
			return true
		}
	}
	return false
}

func nodeText(n *html.Node) string {
	if n.Type == html.TextNode {
		return n.Data
	}
	var sb strings.Builder
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		sb.WriteString(nodeText(c))
	}
	return sb.String()
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// leadListCheckStr extracts a plain-text snippet from a markdown list-item line
// for deduplication against trafilatura output. Trafilatura sometimes breaks the
// intro text and its link onto separate lines, so checking the full inline string
// would miss a match. Strategy: use text before the first "[" if that prefix is
// ≥10 chars; otherwise strip link syntax and check the link text.
func leadListCheckStr(line string) string {
	const maxLen = 40
	if idx := strings.Index(line, "["); idx >= 10 {
		s := strings.TrimSpace(line[:idx])
		if len(s) > maxLen {
			s = s[:maxLen]
		}
		return s
	}
	// Link is at start — strip [text](url) → text for comparison.
	stripped := mdLinkRe.ReplaceAllString(line, "$1")
	stripped = strings.TrimSpace(stripped)
	if len(stripped) > maxLen {
		stripped = stripped[:maxLen]
	}
	return stripped
}

// figureSkipZones are regions whose figures are boilerplate, never article content.
var figureSkipZones = map[string]struct{}{
	"nav": {}, "header": {}, "footer": {}, "aside": {},
	"script": {}, "style": {}, "noscript": {},
}

// figImg is a content image lifted from a <figure>.
type figImg struct{ src, alt string }

// unwrapFigureImages rewrites <figure>…<img>…</figure> into a plain <p><img></p> at
// the figure's original position. go-trafilatura's text-first extractor discards
// <figure> (an unrecognized container) but keeps <img> children of <p>, so this lets
// content images survive extraction inline at their real position instead of being
// recovered and appended at the document end. Figures in nav/header/footer/aside are
// left untouched (trafilatura drops those regions anyway). Returns rawHTML unchanged
// when there is nothing to rewrite.
func unwrapFigureImages(rawHTML []byte) []byte {
	root, err := html.Parse(bytes.NewReader(rawHTML))
	if err != nil {
		return rawHTML
	}

	// Collect figures first; mutating the tree mid-walk invalidates sibling links.
	var figures []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			if _, skip := figureSkipZones[n.Data]; skip {
				return
			}
			if n.Data == "figure" {
				figures = append(figures, n)
				return // nested figures are exotic; don't recurse
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)

	changed := false
	for _, fig := range figures {
		if fig.Parent == nil {
			continue
		}
		imgs := figureContentImages(fig)
		if len(imgs) == 0 {
			continue // no usable image: leave figure for trafilatura to drop
		}
		p := &html.Node{Type: html.ElementNode, Data: "p", DataAtom: atom.P}
		for _, im := range imgs {
			img := &html.Node{Type: html.ElementNode, Data: "img", DataAtom: atom.Img}
			img.Attr = []html.Attribute{{Key: "src", Val: im.src}}
			if im.alt != "" {
				img.Attr = append(img.Attr, html.Attribute{Key: "alt", Val: im.alt})
			}
			p.AppendChild(img)
		}
		fig.Parent.InsertBefore(p, fig)
		fig.Parent.RemoveChild(fig)
		changed = true
	}

	if !changed {
		return rawHTML
	}
	var buf bytes.Buffer
	if err := html.Render(&buf, root); err != nil {
		return rawHTML
	}
	return buf.Bytes()
}

// figureContentImages returns deduped content images inside a figure that pass the
// download heuristic, resolving lazy-loaded data-src.
func figureContentImages(fig *html.Node) []figImg {
	seen := map[string]struct{}{}
	var imgs []figImg
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "img" {
			src := attrVal(n, "src")
			if src == "" {
				src = attrVal(n, "data-src")
			}
			if strings.HasPrefix(src, "http") && shouldDownload(src, attrVal(n, "alt")) {
				if _, dup := seen[src]; !dup {
					seen[src] = struct{}{}
					imgs = append(imgs, figImg{src: src, alt: attrVal(n, "alt")})
				}
			}
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(fig)
	return imgs
}

func attrVal(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func pipelineMatchesDocument(pl store.Pipeline, doc store.Document, feedURL string) bool {
	return pipeline.MatchesDocument(pl, doc, feedURL)
}
