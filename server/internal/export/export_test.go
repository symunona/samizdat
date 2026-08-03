package export

import (
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/store"
)

func wikiLinks() map[string]assetLink {
	return map[string]assetLink{
		"https://ossama.is/images/gg.png": {file: "a1.jpg", style: linkWikilink, up: "../"},
		"/api/v1/media/fig-1":             {file: "b2.jpg", style: linkWikilink, up: "../"},
	}
}

// TestRewriteImagesWikilink: known assets become path-free Obsidian embeds,
// whatever URL shape the stored markdown used (scraped http, or the media route
// a PDF figure carries).
func TestRewriteImagesWikilink(t *testing.T) {
	in := "text\n\n![Lucky](https://ossama.is/images/gg.png)\n\n![Figure 1: x](/api/v1/media/fig-1)\n"
	got := rewriteImages(in, wikiLinks())
	// Alt text survives as the wikilink alias (Obsidian renders it as alt).
	if !strings.Contains(got, "![[a1.jpg|Lucky]]") || !strings.Contains(got, "![[b2.jpg|Figure 1: x]]") {
		t.Errorf("expected wikilink embeds, got:\n%s", got)
	}
	if strings.Contains(got, "ossama.is") || strings.Contains(got, "/api/v1/media/") {
		t.Errorf("source URL survived rewrite:\n%s", got)
	}
}

// TestRewriteImagesRelative keeps alt text and points at ../assets/.
func TestRewriteImagesRelative(t *testing.T) {
	links := map[string]assetLink{
		"https://ossama.is/images/gg.png": {file: "a1.jpg", style: linkRelative, up: "../"},
	}
	got := rewriteImages(`![Lucky](https://ossama.is/images/gg.png)`, links)
	if got != `![Lucky](../assets/a1.jpg)` {
		t.Errorf("got %q", got)
	}
}

// TestRewriteImagesLeavesUnknown: an image with no copied asset (download
// skipped/failed) must stay as-is, and non-image links are never touched.
func TestRewriteImagesLeavesUnknown(t *testing.T) {
	in := "![a](https://other.example/x.png) and [link](https://ossama.is/images/gg.png)"
	if got := rewriteImages(in, wikiLinks()); got != in {
		t.Errorf("expected unchanged, got:\n%s", got)
	}
}

// TestWikiAlias: `|`/brackets would break the link and a bare number reads as a
// width directive, so neither may reach the alias.
func TestWikiAlias(t *testing.T) {
	cases := map[string]string{
		"Figure 1: a plot":  "Figure 1: a plot",
		"a | b [c] ]] d":    "a b c d",
		"100":               "",
		"  spaced   out\n?": "spaced out ?",
		"":                  "",
	}
	for in, want := range cases {
		if got := wikiAlias(in); got != want {
			t.Errorf("wikiAlias(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestRenderDocHero embeds the hero once in the body and keeps the frontmatter
// scalar a path (YAML cannot carry an embed).
func TestRenderDocHero(t *testing.T) {
	doc := store.Document{
		ID:           "doc-1",
		Title:        "T",
		CanonicalUrl: "https://ossama.is/writing/x",
		HeroImageUrl: "https://ossama.is/images/gg.png",
		Markdown:     "body",
		FetchedAt:    "2026-08-03T00:00:00Z",
		CreatedAt:    "2026-08-03T00:00:00Z",
	}
	out := string(renderDoc(doc, nil, nil, nil, wikiLinks()))
	if !strings.Contains(out, `hero: "../assets/a1.jpg"`) {
		t.Errorf("frontmatter hero path missing:\n%s", out)
	}
	if !strings.Contains(out, "![[a1.jpg]]") {
		t.Errorf("hero embed missing:\n%s", out)
	}
}
