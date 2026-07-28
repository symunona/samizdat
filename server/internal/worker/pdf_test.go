package worker

import (
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/ledongthuc/pdf"
)

// glyphs lays out one line of text starting at x, advancing by the given
// per-glyph widths. A gap is expressed by passing an explicit advance larger
// than the glyph width — see the helpers below.
func glyph(s string, x, w, y, size float64) pdf.Text {
	return pdf.Text{S: s, X: x, Y: y, W: w, FontSize: size}
}

// line builds a run of single-character glyphs from words separated by the given
// inter-word gap, all on baseline y. Within a word glyphs abut exactly, which is
// what a real typeset PDF emits.
func line(y, x, size, gap float64, words ...string) []pdf.Text {
	const w = 5.0
	var out []pdf.Text
	for i, word := range words {
		if i > 0 {
			x += gap
		}
		for _, r := range word {
			out = append(out, glyph(string(r), x, w, y, size))
			x += w
		}
	}
	return out
}

func TestRenderSegmentRestoresWordSpaces(t *testing.T) {
	// Typeset PDFs encode word breaks as positioning, not space glyphs: the naive
	// concat this replaces produced "WhyareallLLMs".
	seg := line(700, 100, 10, 3.5, "Why", "are", "all", "LLMs")
	if got, want := renderSegment(seg), "Why are all LLMs"; got != want {
		t.Errorf("renderSegment = %q, want %q", got, want)
	}
}

func TestRenderSegmentKeepsWordsWhole(t *testing.T) {
	// Kerned pairs inside a word sit fractionally apart — not a word break.
	seg := line(700, 100, 10, 0.4, "Ja", "pan")
	if got, want := renderSegment(seg), "Japan"; got != want {
		t.Errorf("renderSegment = %q, want %q", got, want)
	}
}

func TestRenderSegmentCollapsesWhitespaceGlyphs(t *testing.T) {
	// Content streams emit zero-width "\n" runs between typeset blocks. They are
	// separators, not line breaks — the page's real lines come from baselines.
	seg := []pdf.Text{
		glyph("a", 100, 5, 700, 10),
		glyph("\n", 105, 0, 700, 10),
		glyph("\n", 105, 0, 700, 10),
		glyph("b", 130, 5, 700, 10),
	}
	if got, want := renderSegment(seg), "a b"; got != want {
		t.Errorf("renderSegment = %q, want %q", got, want)
	}
}

func TestRenderSegmentHugsPunctuation(t *testing.T) {
	// Hyperlinked citations arrive as separately positioned chunks, so the gap
	// test alone yields "et al. , 2024 )".
	seg := []pdf.Text{
		glyph("(", 100, 5, 700, 10),
		glyph("\n", 105, 0, 700, 10),
		glyph("L", 112, 5, 700, 10),
		glyph("i", 117, 5, 700, 10),
		glyph("\n", 122, 0, 700, 10),
		glyph(",", 130, 5, 700, 10),
		glyph("\n", 135, 0, 700, 10),
		glyph(")", 145, 5, 700, 10),
	}
	if got, want := renderSegment(seg), "(Li,)"; got != want {
		t.Errorf("renderSegment = %q, want %q", got, want)
	}
}

func TestGroupLinesOrdersTopToBottomThenLeftToRight(t *testing.T) {
	// PDF origin is bottom-left, so a higher Y is an earlier line. Glyphs arrive
	// in content-stream order, which need not be reading order.
	glyphs := []pdf.Text{
		glyph("b", 200, 5, 700, 10),
		glyph("c", 100, 5, 680, 10),
		glyph("a", 100, 5, 700, 10),
	}
	lines := groupLines(glyphs)
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2", len(lines))
	}
	if got := renderSegment(lines[0]); got != "a b" {
		t.Errorf("line 0 = %q, want %q", got, "a b")
	}
	if got := renderSegment(lines[1]); got != "c" {
		t.Errorf("line 1 = %q, want %q", got, "c")
	}
}

func TestSplitAtGutterKeepsFullWidthHeadings(t *testing.T) {
	// A title spans the page and crosses the gutter x mid-sentence. Its glyphs
	// there are one word space apart, not a column apart, so it must stay whole.
	heading := line(700, 100, 14, 3.5, "Why", "are", "all", "LLMs", "Obsessed", "with", "Japan")
	segs := splitAtGutter(heading, 150)
	if len(segs) != 1 {
		t.Fatalf("split a full-width heading into %d segments, want 1", len(segs))
	}
}

func TestSplitAtGutterCutsTwoColumnLine(t *testing.T) {
	// Two body lines sharing a baseline, separated by a real gutter.
	left := line(700, 100, 10, 3.5, "left", "text")
	right := line(700, 306, 10, 3.5, "right", "text")
	segs := splitAtGutter(append(left, right...), 302)
	if len(segs) != 2 {
		t.Fatalf("got %d segments, want 2", len(segs))
	}
	if got, want := renderSegment(segs[0]), "left text"; got != want {
		t.Errorf("left = %q, want %q", got, want)
	}
	if got, want := renderSegment(segs[1]), "right text"; got != want {
		t.Errorf("right = %q, want %q", got, want)
	}
}

func TestPageTextReadsColumnsInOrder(t *testing.T) {
	// Left column top-to-bottom, then right column — not zig-zagged by baseline.
	var glyphs []pdf.Text
	glyphs = append(glyphs, line(700, 100, 10, 3.5, "one")...)
	glyphs = append(glyphs, line(700, 306, 10, 3.5, "three")...)
	glyphs = append(glyphs, line(688, 100, 10, 3.5, "two")...)
	glyphs = append(glyphs, line(688, 306, 10, 3.5, "four")...)

	want := "one\ntwo\nthree\nfour"
	if got := pageText(glyphs, 302); got != want {
		t.Errorf("pageText =\n%q\nwant\n%q", got, want)
	}
}

func TestPageTextSingleColumnKeepsReadingOrder(t *testing.T) {
	// +Inf boundary means no columns were detected; everything reads in baseline
	// order, including text that happens to sit far right.
	var glyphs []pdf.Text
	glyphs = append(glyphs, line(700, 100, 10, 3.5, "first")...)
	glyphs = append(glyphs, line(688, 400, 10, 3.5, "second")...)

	want := "first\nsecond"
	if got := pageText(glyphs, math.Inf(1)); got != want {
		t.Errorf("pageText = %q, want %q", got, want)
	}
}

func TestStripLineMarksRemovesPaintedTerminator(t *testing.T) {
	// bitcoin.pdf paints its line break as a positive-width glyph that decodes to
	// "k", so every line arrives as "Satoshi Nakamotok".
	in := strings.Join([]string{
		"Satoshi Nakamotok",
		"A purely peer-to-peer version of electronic cashk",
		"would allow online payments to be sent directlyk",
		"from one party to another. k", // the mark can trail a space
	}, "\n")
	want := strings.Join([]string{
		"Satoshi Nakamoto",
		"A purely peer-to-peer version of electronic cash",
		"would allow online payments to be sent directly",
		"from one party to another.",
	}, "\n")
	if got := stripLineMarks(in); got != want {
		t.Errorf("stripLineMarks =\n%q\nwant\n%q", got, want)
	}
}

func TestStripLineMarksLeavesRealText(t *testing.T) {
	// Ordinary prose has no single letter ending most of its lines. Stripping one
	// here would silently eat a character off the end of real sentences.
	in := strings.Join([]string{
		"LLMs have been showing limitations when it",
		"comes to cultural coverage and competence,",
		"and in some cases show regional biases such",
		"as amplifying Western and Anglocentric view-",
		"points. While there have been works analysing",
	}, "\n")
	if got := stripLineMarks(in); got != in {
		t.Errorf("stripLineMarks altered real text:\n%q", got)
	}
}

// wrapped renders text as a PDF would: hard-broken at a fixed column width.
func wrapped(width int, paragraphs ...string) string {
	var lines []string
	for _, p := range paragraphs {
		col := ""
		for _, word := range strings.Fields(p) {
			if col != "" && len(col)+1+len(word) > width {
				lines = append(lines, col)
				col = ""
			}
			if col != "" {
				col += " "
			}
			col += word
		}
		lines = append(lines, col)
	}
	return strings.Join(lines, "\n")
}

func TestReflowJoinsWrappedLines(t *testing.T) {
	// A PDF has no paragraphs, only printed lines. Left as-is, every wrapped line
	// reads as its own paragraph and sentences arrive split mid-clause.
	const p1 = "The network timestamps transactions by hashing them into an ongoing chain of hash based proof of work, forming a record that cannot be changed without redoing the work."
	const p2 = "The longest chain serves as proof of the sequence of events witnessed, and proof that it came from the largest pool of CPU power available."
	got := reflowParagraphs(wrapped(48, p1, p2))
	if want := p1 + "\n\n" + p2; got != want {
		t.Errorf("reflowParagraphs =\n%q\nwant\n%q", got, want)
	}
}

func TestReflowDeHyphenates(t *testing.T) {
	// Justification breaks words across lines; joining without dropping the hyphen
	// leaves "tax-onomy" in the text.
	in := "a new dataset based on a comprehensive tax-\nonomy of Culture-Related Open Questions that\nwe release."
	want := "a new dataset based on a comprehensive taxonomy of Culture-Related Open Questions that we release."
	if got := reflowParagraphs(in + "\n" + strings.Repeat("filler line of about the same width here\n", 8)); !strings.HasPrefix(got, want) {
		t.Errorf("reflowParagraphs =\n%q\nwant prefix\n%q", got, want)
	}
}

func TestReflowKeepsHyphenOfKnownCompound(t *testing.T) {
	// Typesetters break at an existing hyphen by preference, so a compound the
	// document uses elsewhere must survive the join — "highresource" is a typo,
	// while "prompting" is the correct repair of a syllable break.
	in := "ing in languages such as English or other high-\n" +
		"resource ones, LLMs tend to provide more diverse\n" +
		"outputs when prompt-\n" +
		"ing the model in high-resource languages, and\n" +
		strings.Repeat("filler line to establish the column width ok\n", 8)
	got := reflowParagraphs(in)
	if !strings.Contains(got, "high-resource ones") {
		t.Errorf("dropped the hyphen of a compound the document uses:\n%q", got)
	}
	if !strings.Contains(got, "prompting the model") {
		t.Errorf("kept the hyphen of a syllable break:\n%q", got)
	}
}

func TestReflowLeavesShortTextAlone(t *testing.T) {
	// Too few lines to infer a column width — joining would be guesswork.
	in := "Title\nAuthor\nemail@example.com"
	if got := reflowParagraphs(in); got != in {
		t.Errorf("reflowParagraphs = %q, want it unchanged", got)
	}
}

func TestIsPDFURL(t *testing.T) {
	cases := map[string]bool{
		"https://arxiv.org/pdf/2604.21751.pdf":     true,
		"https://example.com/paper.PDF":            true,
		"https://example.com/a.pdf?download=1":     true,
		"https://arxiv.org/pdf/2604.21751":         false, // no extension — caught by the content-type retry
		"https://example.com/pdf/viewer":           false,
		"https://example.com/notes.pdf.html":       false,
		"https://example.com/":                     false,
		"https://www.youtube.com/watch?v=abc12345": false,
	}
	for raw, want := range cases {
		if got := isPDFURL(raw); got != want {
			t.Errorf("isPDFURL(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestIsPDFContentType(t *testing.T) {
	cases := map[string]bool{
		"application/pdf":               true,
		"application/pdf; charset=utf8": true,
		" Application/PDF":              true,
		"text/html":                     false,
		"":                              false,
	}
	for ct, want := range cases {
		if got := isPDFContentType(ct); got != want {
			t.Errorf("isPDFContentType(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestIsBrowserDownloadErr(t *testing.T) {
	// The exact error that killed every PDF scrape before this path existed.
	err := errors.New("goto https://arxiv.org/pdf/2604.21751: Frame.Goto: playwright: Download is starting")
	if !isBrowserDownloadErr(err) {
		t.Error("did not recognise the browser download error")
	}
	if isBrowserDownloadErr(errors.New("playwright: timeout: Timeout 30000ms exceeded")) {
		t.Error("treated a timeout as a download")
	}
	if isBrowserDownloadErr(nil) {
		t.Error("treated nil as a download")
	}
}

func TestPDFTitleFromURL(t *testing.T) {
	cases := map[string]string{
		"https://example.com/papers/attention-is-all-you-need.pdf": "attention-is-all-you-need",
		"https://arxiv.org/pdf/2604.21751":                         "2604.21751",
		"https://example.com/":                                     "https://example.com/",
	}
	for raw, want := range cases {
		if got := pdfTitleFromURL(raw); got != want {
			t.Errorf("pdfTitleFromURL(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestFirstRunesDoesNotSplitRunes(t *testing.T) {
	if got, want := firstRunes("  árvíztűrő  ", 5), "árvíz"; got != want {
		t.Errorf("firstRunes = %q, want %q", got, want)
	}
	if got, want := firstRunes("short", 50), "short"; got != want {
		t.Errorf("firstRunes = %q, want %q", got, want)
	}
	if strings.ContainsRune(firstRunes("ő", 1), '�') {
		t.Error("split a multi-byte rune")
	}
}
