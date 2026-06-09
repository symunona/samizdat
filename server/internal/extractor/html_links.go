package extractor

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// HTMLLinksAdapter extracts links from pre-rendered HTML using a CSS selector
// (approximated via golang.org/x/net/html tree walk) and a URL pattern filter.
type HTMLLinksAdapter struct{}

func (a *HTMLLinksAdapter) Kind() string { return "html_links" }

// Discover parses htmlContent (already fetched by the caller via browser) and
// returns URLs matching cfg.Selector and cfg.URLPattern, resolved against cfg.BaseURL.
func (a *HTMLLinksAdapter) Discover(_ context.Context, feedURL string, cfg ExtractorConfig, htmlContent string) ([]string, error) {
	if htmlContent == "" {
		return nil, fmt.Errorf("html_links adapter requires pre-rendered HTML content")
	}

	baseStr := cfg.BaseURL
	if baseStr == "" {
		baseStr = feedURL
	}
	base, err := url.Parse(baseStr)
	if err != nil {
		return nil, fmt.Errorf("parse base_url %q: %w", baseStr, err)
	}

	var pattern *regexp.Regexp
	if cfg.URLPattern != "" {
		pattern, err = regexp.Compile(cfg.URLPattern)
		if err != nil {
			return nil, fmt.Errorf("compile url_pattern %q: %w", cfg.URLPattern, err)
		}
	}

	root, err := html.Parse(strings.NewReader(htmlContent))
	if err != nil {
		return nil, fmt.Errorf("parse html: %w", err)
	}

	// Parse selector into simple parts we can match.
	matcher := parseSelector(cfg.Selector)

	seen := map[string]struct{}{}
	var urls []string

	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "a" {
			if matcher == nil || matcher(n) {
				href := attrVal(n, "href")
				if href != "" {
					resolved := resolveHref(base, href)
					if resolved != "" {
						if pattern == nil || pattern.MatchString(resolved) {
							if _, dup := seen[resolved]; !dup {
								seen[resolved] = struct{}{}
								urls = append(urls, resolved)
							}
						}
					}
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)

	if cfg.MaxURLs > 0 && len(urls) > cfg.MaxURLs {
		urls = urls[:cfg.MaxURLs]
	}
	return urls, nil
}

// attrVal returns the value of the named attribute on n, or "".
func attrVal(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// resolveHref resolves href relative to base and returns the absolute URL string.
func resolveHref(base *url.URL, href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	abs := base.ResolveReference(u)
	return abs.String()
}

// nodeMatcher is a function that returns true if an <a> element matches a selector part.
type nodeMatcher func(*html.Node) bool

// parseSelector converts a simple CSS selector string into a matcher function.
// Supported forms (comma-separated, each part may be a chain of ancestor/descendant):
//   - "a" — any anchor
//   - "h2 a" — anchor inside h2
//   - "article h2 a" — anchor inside h2 inside article
//   - ".class a" — anchor inside element with class
//   - "tag.class a" — anchor inside element with both tag and class
//
// Returns nil to mean "match all <a>" when selector is empty.
func parseSelector(selector string) nodeMatcher {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return nil
	}

	// Split on commas to get alternative selectors.
	parts := strings.Split(selector, ",")
	var alternatives []nodeMatcher
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		m := parseSingleSelector(p)
		if m != nil {
			alternatives = append(alternatives, m)
		}
	}
	if len(alternatives) == 0 {
		return nil
	}
	return func(n *html.Node) bool {
		for _, m := range alternatives {
			if m(n) {
				return true
			}
		}
		return false
	}
}

// parseSingleSelector handles one non-comma selector like "article h2 a".
// We treat each space-separated token as a descendant requirement walking up the DOM.
func parseSingleSelector(sel string) nodeMatcher {
	tokens := strings.Fields(sel)
	if len(tokens) == 0 {
		return nil
	}
	// Last token should be "a"; build ancestor chain from remaining tokens.
	// We match the <a> node itself against tokens[last], then walk up parents.
	return func(n *html.Node) bool {
		// Walk the token list right-to-left against the ancestor chain.
		node := n
		for i := len(tokens) - 1; i >= 0; i-- {
			if node == nil {
				return false
			}
			if !matchSimple(node, tokens[i]) {
				if i == len(tokens)-1 {
					return false // must match the node itself
				}
				// ancestor not matched — keep looking up
				i++ // retry this token with parent
			}
			node = node.Parent
		}
		return true
	}
}

// matchSimple matches an html.Node against a simple selector token like "article", ".class", "tag.class".
func matchSimple(n *html.Node, token string) bool {
	if n == nil || n.Type != html.ElementNode {
		return false
	}
	// Split tag and classes.
	dotIdx := strings.Index(token, ".")
	var tag, class string
	if dotIdx == -1 {
		tag = token
	} else {
		tag = token[:dotIdx]
		class = token[dotIdx+1:]
	}

	if tag != "" && n.Data != tag {
		return false
	}
	if class != "" {
		classes := strings.Fields(attrVal(n, "class"))
		found := false
		for _, c := range classes {
			if c == class {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
