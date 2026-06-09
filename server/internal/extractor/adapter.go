package extractor

import "context"

// FeedAdapter discovers article URLs from a feed source.
type FeedAdapter interface {
	// Kind returns the adapter type string.
	Kind() string

	// Discover returns a list of canonical URLs found at feedURL using the
	// provided config. htmlContent is the pre-rendered HTML string for
	// html_links adapters (pass empty string for rss/js_script adapters).
	Discover(ctx context.Context, feedURL string, cfg ExtractorConfig, htmlContent string) ([]string, error)
}

// AdapterFor returns the appropriate FeedAdapter for the given kind.
func AdapterFor(kind string) FeedAdapter {
	switch kind {
	case "rss", "atom":
		return &RSSAdapter{}
	case "html_links":
		return &HTMLLinksAdapter{}
	case "js_script":
		return &JSScriptAdapter{}
	default:
		return nil
	}
}
