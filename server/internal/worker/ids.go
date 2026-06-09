package worker

import "github.com/google/uuid"

// IDFromURL returns a stable UUID-v5 for any URL string.
// Same input always produces the same output, so re-scraping the same URL
// yields the same document/asset ID rather than creating duplicates.
func IDFromURL(u string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(u)).String()
}
