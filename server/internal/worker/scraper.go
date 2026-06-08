package worker

import (
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

	result, err := trafilatura.Extract(resp.Body, trafilatura.Options{
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
