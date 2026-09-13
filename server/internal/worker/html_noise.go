package worker

import (
	"bytes"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Article extraction has ONE definition of "not article content", in two tiers.
//
// Tier A — stripInvisible: chrome the reader never sees. Consent dialogs, modals,
// <template> payloads, aria-hidden decoration. It is removed from the DOM once,
// right after the fetch, so every downstream reader (trafilatura, extractLeadLists,
// unwrapFigureImages) sees the same tree and needs no rule of its own. This tier
// exists because a CMP banner is script-injected: it is absent from the served HTML
// and present only in the rendered DOM — exactly what we hand the extractors. The
// Works in Progress scrape prepended 6.8KB of Cookiebot cookie declaration (26% of
// the body) that way: trafilatura dropped it, extractLeadLists recovered it as a
// "list trafilatura missed".
//
// Tier B — regionSkip: visible page furniture (nav, header, footer, aside, form).
// It STAYS in the tree, because trafilatura mines those regions for author/date
// metadata; only the recovery walks skip it, locally. Matching is by tag AND by the
// ARIA role twin — a <div role="navigation"> is a nav to everything except a tag
// name comparison.
var (
	// invisibleRoles mark an overlay: dialogs are not the document.
	invisibleRoles = map[string]struct{}{"dialog": {}, "alertdialog": {}}

	regionSkipTags = map[string]struct{}{
		"nav": {}, "header": {}, "footer": {}, "aside": {}, "form": {},
		"script": {}, "style": {}, "noscript": {},
	}
	regionSkipRoles = map[string]struct{}{
		"navigation": {}, "banner": {}, "contentinfo": {},
		"complementary": {}, "search": {}, "form": {},
	}
)

// isRegionSkip reports whether n opens a tier-B furniture region.
func isRegionSkip(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	if _, ok := regionSkipTags[n.Data]; ok {
		return true
	}
	_, ok := regionSkipRoles[strings.ToLower(strings.TrimSpace(attrVal(n, "role")))]
	return ok
}

// isInvisible reports whether n is tier-A chrome: hidden from the accessibility
// tree, hidden by inline style, an overlay dialog, or an inert <template>. The
// a11y attributes are the reliable signal — every consent vendor sets them
// because screen readers require it, so no vendor list needs maintaining.
func isInvisible(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	switch n.Data {
	case "template", "dialog":
		return true
	}
	if strings.EqualFold(attrVal(n, "aria-hidden"), "true") {
		return true
	}
	for _, a := range n.Attr {
		if a.Key == "hidden" {
			return true
		}
	}
	if _, ok := invisibleRoles[strings.ToLower(strings.TrimSpace(attrVal(n, "role")))]; ok {
		return true
	}
	style := strings.ToLower(strings.ReplaceAll(attrVal(n, "style"), " ", ""))
	return strings.Contains(style, "display:none") || strings.Contains(style, "visibility:hidden")
}

// holdsMainContent reports whether n contains the page's main content landmark.
// It is the one case where "invisible" means the opposite of noise: an open modal
// sets aria-hidden="true" on the page BEHIND it, so a consent banner the dismiss
// step failed to close makes the whole article invisible by this test. A subtree
// wrapping <main>/<article>/role="main" is never chrome — skip it and keep the
// banner instead. Proportional guards cannot see this: on a short post a cookie
// declaration outweighs the article, and on a long one the hidden article
// outweighs everything.
func holdsMainContent(n *html.Node) bool {
	if n.Type == html.ElementNode {
		switch n.Data {
		case "main", "article":
			return true
		}
		if strings.EqualFold(strings.TrimSpace(attrVal(n, "role")), "main") {
			return true
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if holdsMainContent(c) {
			return true
		}
	}
	return false
}

// stripInvisible removes every tier-A subtree from rawHTML. It returns rawHTML
// unchanged when nothing matched, when parsing fails, or when the strip would empty
// the body — losing real content silently is worse than keeping visible noise, so
// both guards bias to keeping the page.
func stripInvisible(rawHTML []byte) []byte {
	root, err := html.Parse(bytes.NewReader(rawHTML))
	if err != nil {
		return rawHTML
	}
	body := findBody(root)
	if body == nil {
		return rawHTML
	}

	// Collect first; mutating the tree mid-walk invalidates sibling links.
	var doomed []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n != root && n != body && isInvisible(n) && !holdsMainContent(n) {
			doomed = append(doomed, n)
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	if len(doomed) == 0 {
		return rawHTML
	}

	before := len(textContent(body))
	for _, n := range doomed {
		if n.Parent != nil {
			n.Parent.RemoveChild(n)
		}
	}
	if after := len(textContent(body)); after == 0 && before > 0 {
		logScraper.Warnf("invisible-chrome strip would empty the body (%d chars) — leaving HTML unstripped", before)
		return rawHTML
	}

	var buf bytes.Buffer
	if err := html.Render(&buf, root); err != nil {
		return rawHTML
	}
	return buf.Bytes()
}

func findBody(root *html.Node) *html.Node {
	var body *html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.DataAtom == atom.Body {
			body = n
			return
		}
		for c := n.FirstChild; c != nil && body == nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(root)
	return body
}

func textContent(n *html.Node) string {
	var sb strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			sb.WriteString(n.Data)
			return
		}
		if n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style") {
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(sb.String()), " ")
}
