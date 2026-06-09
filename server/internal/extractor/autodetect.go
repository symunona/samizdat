package extractor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

var feedCandidatePaths = []string{
	"/feed",
	"/rss",
	"/feed.xml",
	"/atom.xml",
	"/rss.xml",
	"/index.xml",
}

// AutoDetectFeedURL finds an RSS/Atom feed URL for rawURL.
// First tries <link rel="alternate" type="application/rss+xml|atom+xml"> in the page HTML,
// then falls back to probing common feed paths.
func AutoDetectFeedURL(ctx context.Context, rawURL string) (string, error) {
	client := &http.Client{Timeout: 15 * time.Second}

	feedURL, err := detectFeedFromHTML(ctx, client, rawURL)
	if err == nil && feedURL != "" {
		return feedURL, nil
	}

	base, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse URL: %w", err)
	}
	origin := &url.URL{Scheme: base.Scheme, Host: base.Host}

	for _, path := range feedCandidatePaths {
		candidate := origin.String() + path
		if probeFeed(ctx, client, candidate) {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("no RSS/Atom feed found at %s", rawURL)
}

func detectFeedFromHTML(ctx context.Context, client *http.Client, rawURL string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("http %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "html") {
		return "", nil
	}

	doc, err := html.Parse(resp.Body)
	if err != nil {
		return "", err
	}

	base, _ := url.Parse(rawURL)
	var found string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if found != "" {
			return
		}
		if n.Type == html.ElementNode && n.Data == "link" {
			rel := attrVal(n, "rel")
			typ := attrVal(n, "type")
			href := attrVal(n, "href")
			if rel == "alternate" && href != "" &&
				(strings.Contains(typ, "rss") || strings.Contains(typ, "atom")) {
				if u, err := url.Parse(href); err == nil {
					found = base.ResolveReference(u).String()
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return found, nil
}

// probeFeed GETs candidate and checks if the response looks like RSS/Atom.
func probeFeed(ctx context.Context, client *http.Client, candidate string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, candidate, nil)
	if err != nil {
		return false
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, */*")
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode >= 400 {
		if resp != nil {
			resp.Body.Close()
		}
		return false
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "xml") || strings.Contains(ct, "rss") || strings.Contains(ct, "atom") {
		return true
	}

	buf := make([]byte, 512)
	n, _ := io.ReadFull(resp.Body, buf)
	snippet := strings.TrimSpace(string(buf[:n]))
	return strings.HasPrefix(snippet, "<?xml") ||
		strings.HasPrefix(snippet, "<rss") ||
		strings.HasPrefix(snippet, "<feed")
}
