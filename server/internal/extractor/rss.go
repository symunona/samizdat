package extractor

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"time"
)

// RSSAdapter fetches and parses RSS/Atom feeds via plain HTTP GET.
type RSSAdapter struct{}

func (a *RSSAdapter) Kind() string { return "rss" }

// Discover fetches the RSS/Atom feed at cfg.FeedURL (or feedURL if FeedURL is empty)
// and returns the list of item/entry links.
func (a *RSSAdapter) Discover(ctx context.Context, feedURL string, cfg ExtractorConfig, _ string) ([]string, error) {
	target := cfg.FeedURL
	if target == "" {
		target = feedURL
	}

	client := &http.Client{Timeout: 20 * time.Second}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")
	req.Header.Set("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, */*")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch feed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("http %d fetching %s", resp.StatusCode, target)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	urls, err := parseRSSOrAtom(body)
	if err != nil {
		return nil, fmt.Errorf("parse feed: %w", err)
	}
	if cfg.MaxURLs > 0 && len(urls) > cfg.MaxURLs {
		urls = urls[:cfg.MaxURLs]
	}
	return urls, nil
}

// rssRoot is a flexible struct that handles both RSS 2.0 and Atom 1.0.
type rssRoot struct {
	XMLName xml.Name    `xml:""`
	Channel *rssChannel `xml:"channel"`
	Entries []atomEntry `xml:"entry"` // Atom
}

type rssChannel struct {
	Items []rssItem `xml:"item"`
}

type rssItem struct {
	Link string `xml:"link"`
	GUID string `xml:"guid"`
}

type atomEntry struct {
	Links []atomLink `xml:"link"`
}

type atomLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
}

func parseRSSOrAtom(data []byte) ([]string, error) {
	var root rssRoot
	if err := xml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("xml unmarshal: %w", err)
	}

	seen := map[string]struct{}{}
	var urls []string

	add := func(u string) {
		if u != "" {
			if _, dup := seen[u]; !dup {
				seen[u] = struct{}{}
				urls = append(urls, u)
			}
		}
	}

	// RSS 2.0
	if root.Channel != nil {
		for _, item := range root.Channel.Items {
			if item.Link != "" {
				add(item.Link)
			} else {
				add(item.GUID)
			}
		}
	}

	// Atom 1.0
	for _, entry := range root.Entries {
		for _, link := range entry.Links {
			if link.Rel == "alternate" || link.Rel == "" {
				add(link.Href)
				break
			}
		}
	}

	return urls, nil
}
