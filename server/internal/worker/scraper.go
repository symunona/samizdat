package worker

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
	"github.com/google/uuid"
	trafilatura "github.com/markusmobius/go-trafilatura"
	"github.com/symunona/samizdat/server/internal/store"
	"golang.org/x/net/html"
)

type scrapePayload struct {
	URL string `json:"url"`
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

func handleScrapeURL(ctx context.Context, q *store.Queries, job store.Job) error {
	var p scrapePayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return fmt.Errorf("bad payload: %w", err)
	}

	canonical, err := canonicalize(p.URL)
	if err != nil {
		return err
	}

	_, err = q.GetDocumentByCanonicalURL(ctx, canonical)
	if err == nil {
		return nil // already scraped
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("db lookup: %w", err)
	}

	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, canonical, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("http %d", resp.StatusCode)
	}

	// Buffer body so we can parse it twice: once for trafilatura, once for
	// lead list extraction (trafilatura drops link-free summary bullets).
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}

	result, err := trafilatura.Extract(bytes.NewReader(bodyBytes), trafilatura.Options{
		OriginalURL:     mustParseURL(canonical),
		ExcludeComments: true,
		EnableFallback:  true,
	})
	if err != nil {
		return fmt.Errorf("trafilatura: %w", err)
	}

	conv := converter.NewConverter(
		converter.WithPlugins(base.NewBasePlugin(), commonmark.NewCommonmarkPlugin()),
	)
	// render content node to HTML first, then convert to markdown
	var htmlBuf strings.Builder
	if result.ContentNode != nil {
		if err := renderNode(&htmlBuf, result.ContentNode); err != nil {
			return fmt.Errorf("render html: %w", err)
		}
	}
	md, err := conv.ConvertString(htmlBuf.String())
	if err != nil {
		return fmt.Errorf("html→md: %w", err)
	}
	if strings.TrimSpace(md) == "" {
		md = result.ContentText
	}

	// Prepend any lead bullet lists that trafilatura skipped.
	if leadLists := extractLeadLists(bodyBytes, md); leadLists != "" {
		md = leadLists + "\n\n" + md
	}

	title := strings.TrimSpace(result.Metadata.Title)

	excerpt := strings.TrimSpace(result.Metadata.Description)
	if len(excerpt) > 500 {
		excerpt = excerpt[:500]
	}
	heroImageURL := strings.TrimSpace(result.Metadata.Image)
	author := strings.TrimSpace(result.Metadata.Author)

	now := time.Now().UTC().Format(time.RFC3339)
	docID := uuid.NewString()

	doc, err := q.InsertDocument(ctx, store.InsertDocumentParams{
		ID:           docID,
		CanonicalUrl: canonical,
		Title:        title,
		Markdown:     md,
		FetchedAt:    now,
		Excerpt:      excerpt,
		HeroImageUrl: heroImageURL,
		Author:       author,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		return fmt.Errorf("insert document: %w", err)
	}

	// Enqueue asset fetching job.
	payload, _ := json.Marshal(map[string]string{"document_id": doc.ID})
	_, err = q.InsertJob(ctx, store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      "fetch_assets",
		Payload:   string(payload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return fmt.Errorf("enqueue fetch_assets: %w", err)
	}
	return nil
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
// content (no links, ≥2 items, each item ≥20 chars).
func listToMarkdown(n *html.Node, ordered bool) string {
	var items []string
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if c.Type != html.ElementNode || c.Data != "li" {
			continue
		}
		// Skip if any <a> inside (link-list = navigation, not content).
		if hasElement(c, "a") {
			return ""
		}
		text := strings.TrimSpace(nodeText(c))
		if len(text) < 20 {
			return "" // too short = icon/badge label
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
