package extractor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// substackAPIBase is the origin of Substack's public reader API. Overridden in tests.
var substackAPIBase = "https://substack.com"

var substackHandleRe = regexp.MustCompile(`^/@([A-Za-z0-9_.-]+)`)

// SubstackNotesAdapter discovers a writer's Notes from a profile URL
// (https://substack.com/@<handle>/notes).
//
// Substack publishes RSS for posts but not for Notes, and the rendered profile
// page hard-gates anonymous visitors after two items ("Log in for more"), so
// browser-scraping it silently truncates an active writer's feed. The reader API
// below needs no auth, returns the full activity page, and costs a plain GET
// instead of a headless Chrome render per poll. Individual note permalinks do
// render fine anonymously, so only discovery needs this detour.
type SubstackNotesAdapter struct{}

func (a *SubstackNotesAdapter) Kind() string { return "substack_notes" }

// Discover resolves the profile handle to a numeric user id, then lists that
// user's notes. Restacks of other writers appear in the same activity feed, so
// items are filtered back down to the profile's own handle.
func (a *SubstackNotesAdapter) Discover(ctx context.Context, feedURL string, cfg ExtractorConfig, _ string) ([]string, error) {
	handle, err := substackHandle(feedURL)
	if err != nil {
		return nil, err
	}

	client := &http.Client{Timeout: 20 * time.Second}

	var profile struct {
		ID int64 `json:"id"`
	}
	profileURL := fmt.Sprintf("%s/api/v1/user/%s/public_profile", substackAPIBase, url.PathEscape(handle))
	if err := substackGetJSON(ctx, client, profileURL, &profile); err != nil {
		return nil, fmt.Errorf("resolve handle %q: %w", handle, err)
	}
	if profile.ID == 0 {
		return nil, fmt.Errorf("no user id for handle %q", handle)
	}

	var feed struct {
		Items []struct {
			EntityKey string `json:"entity_key"`
			Type      string `json:"type"`
			Context   struct {
				Type string `json:"type"`
			} `json:"context"`
			Comment struct {
				Handle string `json:"handle"`
			} `json:"comment"`
		} `json:"items"`
	}
	notesURL := fmt.Sprintf("%s/api/v1/reader/feed/profile/%d?types%%5B%%5D=note", substackAPIBase, profile.ID)
	if err := substackGetJSON(ctx, client, notesURL, &feed); err != nil {
		return nil, fmt.Errorf("list notes for %q: %w", handle, err)
	}

	seen := map[string]struct{}{}
	var urls []string
	for _, item := range feed.Items {
		if item.Context.Type != "note" || item.EntityKey == "" {
			continue
		}
		if !strings.EqualFold(item.Comment.Handle, handle) {
			continue // restack of somebody else's note
		}
		u := fmt.Sprintf("%s/@%s/note/%s", substackAPIBase, handle, item.EntityKey)
		if _, dup := seen[u]; dup {
			continue
		}
		seen[u] = struct{}{}
		urls = append(urls, u)
	}

	// The API ignores a limit parameter, so cap here.
	if cfg.MaxURLs > 0 && len(urls) > cfg.MaxURLs {
		urls = urls[:cfg.MaxURLs]
	}
	return urls, nil
}

// substackHandle pulls the @handle out of a profile URL.
func substackHandle(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse URL %q: %w", rawURL, err)
	}
	m := substackHandleRe.FindStringSubmatch(u.Path)
	if m == nil {
		return "", fmt.Errorf("not a Substack profile URL (want https://substack.com/@<handle>/notes): %s", rawURL)
	}
	return m[1], nil
}

func substackGetJSON(ctx context.Context, client *http.Client, target string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", "Samizdat/1 (+https://github.com/symunona/samizdat)")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", target, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("http %d fetching %s", resp.StatusCode, target)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s: %w", target, err)
	}
	return nil
}
