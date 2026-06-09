package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/url"
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
)

type scrapePayload struct {
	URL    string  `json:"url"`
	FeedID *string `json:"feed_id,omitempty"`
}

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

	htmlStr, err := browser.FetchHTML(canonical)
	if err != nil {
		return "", fmt.Errorf("fetch: %w", err)
	}
	bodyBytes := []byte(htmlStr)

	extracted, err := trafilatura.Extract(bytes.NewReader(bodyBytes), trafilatura.Options{
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

	// Append content images from <figure> tags that trafilatura skips.
	if figureImgs := extractFigureImages(bodyBytes, md); figureImgs != "" {
		md = md + "\n\n" + figureImgs
	}

	title := strings.TrimSpace(extracted.Metadata.Title)

	excerpt := strings.TrimSpace(extracted.Metadata.Description)
	if len(excerpt) > 500 {
		excerpt = excerpt[:500]
	}
	heroImageURL := strings.TrimSpace(extracted.Metadata.Image)
	author := strings.TrimSpace(extracted.Metadata.Author)

	now := time.Now().UTC().Format(time.RFC3339)
	docID := IDFromURL(canonical)

	doc, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID:           docID,
		CanonicalUrl: canonical,
		Title:        title,
		Markdown:     md,
		FetchedAt:    now,
		Excerpt:      excerpt,
		HeroImageUrl: heroImageURL,
		Author:       author,
		SourceFeedID: p.FeedID,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		return "", fmt.Errorf("insert document: %w", err)
	}

	// Enqueue asset fetching job.
	assetPayload, _ := json.Marshal(map[string]string{"document_id": doc.ID})
	_, err = q.InsertJob(ctx, store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      "fetch_assets",
		Payload:   string(assetPayload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return "", fmt.Errorf("enqueue fetch_assets: %w", err)
	}

	// Trigger matching pipelines.
	triggerPipelines(ctx, q, doc, now)

	jobResult, _ := json.Marshal(map[string]string{"document_id": doc.ID, "title": title})
	return string(jobResult), nil
}

// triggerPipelines checks all enabled on_new_document pipelines and enqueues runs for matches.
func triggerPipelines(ctx context.Context, q *store.Queries, doc store.Document, now string) {
	pipelines, err := q.ListEnabledPipelines(ctx)
	if err != nil {
		log.Printf("pipeline trigger: list pipelines: %v", err)
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
			continue
		}
		payload, _ := json.Marshal(map[string]string{
			"pipeline_id": pl.ID,
			"document_id": doc.ID,
		})
		_, err := q.InsertJob(ctx, store.InsertJobParams{
			ID:        uuid.NewString(),
			Kind:      "run_pipeline",
			Payload:   string(payload),
			RunAfter:  now,
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			log.Printf("pipeline trigger: enqueue run for pipeline %s: %v", pl.ID, err)
		} else {
			log.Printf("pipeline trigger: enqueued run_pipeline for pipeline %s (%s)", pl.ID, pl.Name)
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
		if firstLine != "" && !strings.Contains(extractedMD, firstLine[:min(40, len(firstLine))]) {
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

// extractFigureImages scans raw HTML for <figure> elements containing <img src="...">
// and returns them as markdown image lines not already present in extractedMD.
// This recovers content images that trafilatura skips when they're wrapped in figures.
func extractFigureImages(rawHTML []byte, extractedMD string) string {
	root, err := html.Parse(bytes.NewReader(rawHTML))
	if err != nil {
		return ""
	}

	seen := map[string]struct{}{}
	var srcs []string

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode {
			tag := n.Data
			if tag == "nav" || tag == "header" || tag == "footer" ||
				tag == "aside" || tag == "script" || tag == "style" || tag == "noscript" {
				return
			}
			if tag == "figure" {
				// collect first meaningful <img> inside this figure
				var figWalk func(*html.Node)
				figWalk = func(fn *html.Node) {
					if fn.Type == html.ElementNode && fn.Data == "img" {
						src := attrVal(fn, "src")
						if src == "" {
							src = attrVal(fn, "data-src")
						}
						if src != "" && strings.HasPrefix(src, "http") && shouldDownload(src, "") {
							if _, dup := seen[src]; !dup && !strings.Contains(extractedMD, src) {
								seen[src] = struct{}{}
								srcs = append(srcs, src)
							}
						}
						return
					}
					for c := fn.FirstChild; c != nil; c = c.NextSibling {
						figWalk(c)
					}
				}
				figWalk(n)
				return // don't recurse into figure again
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)

	if len(srcs) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, src := range srcs {
		fmt.Fprintf(&sb, "![](%s)\n", src)
	}
	return strings.TrimRight(sb.String(), "\n")
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
