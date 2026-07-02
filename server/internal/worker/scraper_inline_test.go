package worker

import (
	"bytes"
	"regexp"
	"strings"
	"testing"

	"github.com/JohannesKaufmann/html-to-markdown/v2/converter"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/base"
	"github.com/JohannesKaufmann/html-to-markdown/v2/plugin/commonmark"
	trafilatura "github.com/markusmobius/go-trafilatura"
)

// Regression for the "bold/link jammed against neighbouring words" bug: real
// pages wrap words in <span>s and go-trafilatura strips the boundary space,
// leaving `to**remove…**` / `mixed.[htihle](url)reported`. fixInlineSpacing must
// restore the space at word-char↔inline-tag boundaries.

// Mirrors the span/blockquote structure of latent.space / AINews content.
const jammedFixtureHTML = `<html><head><title>Loopcraft</title></head><body><article>
<blockquote><p><span>To get the most out of the tools that have become available now you have to </span><strong>remove yourself as the bottleneck</strong><span>. You want to </span><strong>arrange things such that autonomous</strong><span> and </span><strong>not be in the loop</strong><span>. Andrej on </span><a href="https://x.com/andrej">Autoresearch</a><span> reported this at length here.</span></p></blockquote>
<p>This is a second paragraph carrying enough ordinary prose that the extractor is confident this really is the main article body worth keeping around for the reader.</p>
</article></body></html>`

func pipelineMarkdown(t *testing.T, rawHTML string, fix bool) string {
	t.Helper()
	ext, err := trafilatura.Extract(strings.NewReader(rawHTML), trafilatura.Options{
		OriginalURL:     mustParseURL("https://www.latent.space/p/loopcraft"),
		ExcludeComments: true,
		EnableFallback:  true,
		IncludeImages:   true,
		IncludeLinks:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if ext.ContentNode != nil {
		if err := renderNode(&buf, ext.ContentNode); err != nil {
			t.Fatal(err)
		}
	}
	src := buf.String()
	if fix {
		src = fixInlineSpacing(src)
	}
	conv := converter.NewConverter(
		converter.WithPlugins(base.NewBasePlugin(), commonmark.NewCommonmarkPlugin()),
	)
	md, err := conv.ConvertString(src)
	if err != nil {
		t.Fatal(err)
	}
	return md
}

var reJam = regexp.MustCompile(`\w\*\*\w|\*\*\w[^*]*\*\*\w|\)\w`)

func TestFixInlineSpacing_RealStructure(t *testing.T) {
	// Sanity: without the fix trafilatura jams the boundaries (documents the bug).
	if jams := reJam.FindAllString(pipelineMarkdown(t, jammedFixtureHTML, false), -1); len(jams) == 0 {
		t.Skip("trafilatura no longer jams this fixture; nothing to guard")
	}

	md := pipelineMarkdown(t, jammedFixtureHTML, true)
	if jams := reJam.FindAllString(md, -1); len(jams) != 0 {
		t.Errorf("inline jams remain after fix: %v\nMD: %q", jams, md)
	}
	// Spot-check restored boundaries (mid-sentence, unaffected by trafilatura's
	// blockquote paragraph splitting).
	for _, want := range []string{"want to **arrange things", "autonomous** and **not", ") reported"} {
		if !strings.Contains(md, want) {
			t.Errorf("missing restored boundary %q in: %q", want, md)
		}
	}
}

func TestFixInlineSpacing_LeavesCleanTextAndCode(t *testing.T) {
	// Already-spaced prose and inline code with ** in it must be untouched.
	in := `<p>Use <strong>bold</strong> here and <code>a**b</code> stays literal.</p>`
	got := fixInlineSpacing(in)
	if got != in {
		t.Errorf("fixInlineSpacing altered clean HTML:\n in: %q\nout: %q", in, got)
	}
}
