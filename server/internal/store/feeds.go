package store

import (
	"net/url"
	"strings"
)

// FeedTitle is what a Feed is called wherever it is shown or handed to a model:
// its title, or — when the title was never set, which is most scraped and
// discovered Feeds — its URL's host without a leading "www.". Without the
// fallback a Digest's prompt lines read "[3]  · headline" and the model cannot
// tell two newsletters apart.
func FeedTitle(title, rawURL string) string {
	if title != "" {
		return title
	}
	if u, err := url.Parse(rawURL); err == nil && u.Hostname() != "" {
		return strings.TrimPrefix(u.Hostname(), "www.")
	}
	return rawURL
}
