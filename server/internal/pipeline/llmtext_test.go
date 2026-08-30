package pipeline

import (
	"os"
	"strings"
	"testing"
)

func TestCompactForLLM(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{
			"inline link collapses to text",
			"Read the [full article](https://example.com/track/abc123) today.",
			"Read the full article today.",
		},
		{
			"bare URL removed, punctuation preserved",
			"See https://example.com/x for details.",
			"See for details.",
		},
		{
			"bare URL glued to sentence punctuation",
			"Check this out: https://example.com/y.",
			"Check this out:.",
		},
		{
			"image with http target untouched",
			"![a photo](https://cdn.example.com/img/1.png)",
			"![a photo](https://cdn.example.com/img/1.png)",
		},
		{
			"image with relative media target untouched",
			"![](/api/v1/media/9f3c2e1a)",
			"![](/api/v1/media/9f3c2e1a)",
		},
		{
			"image wrapped in tracking link unwraps to bare image",
			"[![alt](https://cdn.example.com/i.png)](https://track.example.com/click/abc)",
			"![alt](https://cdn.example.com/i.png)",
		},
		{
			"image and link adjacent on one line",
			"![](https://cdn.example.com/i.png)[Buy now](https://track.example.com/buy)",
			"![](https://cdn.example.com/i.png)Buy now",
		},
		{
			"link then image adjacent, both survive correctly",
			"[Read more](https://track.example.com/x) ![](https://cdn.example.com/i.png)",
			"Read more ![](https://cdn.example.com/i.png)",
		},
		{
			"bare URL inside fenced code block survives untouched",
			"before\n\n```\ncurl https://api.example.com/v1/thing\n```\n\nafter",
			"before\n\n```\ncurl https://api.example.com/v1/thing\n```\n\nafter",
		},
		{
			"link inside fenced code block survives untouched",
			"```\n[text](https://example.com)\n```",
			"```\n[text](https://example.com)\n```",
		},
		{
			"reference-style link and definition left alone",
			"See [the docs][ref] for more.\n\n[ref]: https://example.com/docs",
			"See [the docs][ref] for more.\n\n[ref]: https://example.com/docs",
		},
		{
			"mailto link untouched (no http scheme)",
			"Email [me](mailto:a@example.com) anytime.",
			"Email [me](mailto:a@example.com) anytime.",
		},
		{
			"relative link untouched",
			"See [the page](/docs/intro) here.",
			"See [the page](/docs/intro) here.",
		},
		{
			"anchor link untouched",
			"Jump to [section two](#section-two).",
			"Jump to [section two](#section-two).",
		},
		{
			"bare URL alone on its own line disappears cleanly",
			"para one\n\nhttps://example.com/tracking/pixel\n\npara two",
			"para one\n\n\n\npara two",
		},
		{
			"leading list indentation preserved around a stripped link",
			"  - see [this](https://example.com/a) for more",
			"  - see this for more",
		},
		{
			"no URLs at all: byte-identical passthrough",
			"# Heading\n\nJust plain **prose** with no links at all.\n- one\n- two",
			"# Heading\n\nJust plain **prose** with no links at all.\n- one\n- two",
		},
		{
			"empty string",
			"",
			"",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := CompactForLLM(c.in); got != c.want {
				t.Errorf("CompactForLLM(%q)\n  got:  %q\n  want: %q", c.in, got, c.want)
			}
		})
	}
}

// TestCompactForLLMIdempotent guards the property callers rely on: running the
// compactor on its own output must be a no-op, since a step could plausibly be
// fed already-compacted text (e.g. a Highlight body derived from another
// Highlight body).
func TestCompactForLLMIdempotent(t *testing.T) {
	inputs := []string{
		"Read the [full article](https://example.com/track/abc123) today.",
		"See https://example.com/x for details, and https://example.com/y.",
		"[![alt](https://cdn.example.com/i.png)](https://track.example.com/click/abc)",
		"![](https://cdn.example.com/i.png)[Buy now](https://track.example.com/buy)",
		"before\n\n```\ncurl https://api.example.com/v1/thing\n```\n\nafter",
		"See [the docs][ref] for more.\n\n[ref]: https://example.com/docs",
		"# Heading\n\nplain prose, no links",
	}
	for _, in := range inputs {
		once := CompactForLLM(in)
		twice := CompactForLLM(once)
		if once != twice {
			t.Errorf("not idempotent for %q:\n  once:  %q\n  twice: %q", in, once, twice)
		}
	}
}

// TestCompactForLLMRealDocument uses the actual scraped James Clear 3-2-1
// newsletter (23238 runes, ~76% ConvertKit tracking URLs) that motivated this
// function: chunk.go's EstimateTokens under-counts a link-heavy document badly
// enough to push it over chunk_above and into the chunking path. This asserts
// the regression that matters, not just unit shapes.
func TestCompactForLLMRealDocument(t *testing.T) {
	const path = "/tmp/claude-1000/-home-symunona-dev-sam/dd1a53c6-a812-49ea-b9b5-971ccccb9c94/scratchpad/doc321.md"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("scratch fixture not present: %v", err)
	}
	original := string(raw)
	compacted := CompactForLLM(original)

	origLen := len([]rune(original))
	compLen := len([]rune(compacted))
	origTok := EstimateTokens(original)
	compTok := EstimateTokens(compacted)
	t.Logf("doc321.md: %d -> %d runes (%.1f%%), %d -> %d estimated tokens",
		origLen, compLen, 100*float64(compLen)/float64(origLen), origTok, compTok)

	if ratio := float64(compLen) / float64(origLen); ratio >= 0.40 {
		t.Errorf("compacted size is %.1f%% of original, want < 40%%", ratio*100)
	}
	const chunkAbove = 4000
	if compTok >= chunkAbove {
		t.Errorf("compacted EstimateTokens = %d, want < chunk_above (%d)", compTok, chunkAbove)
	}

	// The document's images must survive verbatim — this is the load-bearing
	// guarantee (vault export, hero images), not incidental to the size win.
	origImages := imageRe.FindAllString(original, -1)
	compactedStr := compacted
	for _, img := range origImages {
		if !strings.Contains(compactedStr, img) {
			t.Errorf("image %q missing from compacted output", img)
		}
	}
	if len(origImages) == 0 {
		t.Fatal("fixture has no images — test no longer exercises the image-preservation guarantee")
	}
}
