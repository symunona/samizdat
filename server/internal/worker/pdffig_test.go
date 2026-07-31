package worker

import (
	"image"
	"strings"
	"testing"
)

func TestClusterBoxesMergesTransitively(t *testing.T) {
	// A touches B, B touches C, but A is far from C — one pass would leave two.
	boxes := []pdfBox{
		{l: 0, b: 0, r: 50, t: 50},
		{l: 55, b: 0, r: 100, t: 50},
		{l: 105, b: 0, r: 150, t: 50},
	}
	got := clusterBoxes(boxes, pdfFigMergeGap)
	if len(got) != 1 {
		t.Fatalf("want 1 cluster, got %d: %+v", len(got), got)
	}
	if got[0].l != 0 || got[0].r != 150 {
		t.Errorf("cluster should span 0..150, got %+v", got[0])
	}
}

func TestFigureBoxesDropsFurniture(t *testing.T) {
	got := figureBoxes([]pdfBox{
		{l: 72, b: 700, r: 540, t: 702},  // a horizontal rule
		{l: 100, b: 300, r: 400, t: 500}, // a real figure
	})
	if len(got) != 1 {
		t.Fatalf("want 1 figure, got %d: %+v", len(got), got)
	}
	if got[0].height() != 200 {
		t.Errorf("kept the wrong box: %+v", got[0])
	}
}

func TestDropRepeatingRemovesRunningHeader(t *testing.T) {
	header := pdfBox{l: 72, b: 730, r: 200, t: 780}
	figure := pdfBox{l: 100, b: 300, r: 400, t: 500}

	pages := make([][]pdfBox, 6)
	for i := range pages {
		pages[i] = []pdfBox{header}
	}
	pages[2] = append(pages[2], figure)

	got := dropRepeating(pages)
	for i, page := range got {
		for _, b := range page {
			if b == header {
				t.Fatalf("page %d kept the running header", i)
			}
		}
	}
	if len(got[2]) != 1 || got[2][0] != figure {
		t.Errorf("page 3 should keep its figure, got %+v", got[2])
	}
}

func TestFormBBoxThroughCTM(t *testing.T) {
	// A form whose own space is 0..100 square, placed at (200,400) at half scale.
	ctm := pdfMatrix{0.5, 0, 0, 0.5, 200, 400}
	got := ctm.boxOfRect(0, 0, 100, 100)
	want := pdfBox{l: 200, b: 400, r: 250, t: 450}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestImageUnitSquareThroughFlippedCTM(t *testing.T) {
	// Images are commonly drawn with a negative d to flip the raster; the box
	// must come out the right way up regardless.
	ctm := pdfMatrix{219, 0, 0, -322, 197, 720}
	got := ctm.boxOfUnitSquare()
	want := pdfBox{l: 197, b: 398, r: 416, t: 720}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestPixelRectMapsBoxOntoBitmap(t *testing.T) {
	fig := pdfFigure{
		box:     pdfBox{l: 98, b: 638, r: 231, t: 712},
		pageBox: pdfBox{l: 0, b: 0, r: 612, t: 792},
	}
	// 150dpi render of a letter page.
	got := fig.pixelRect(image.Rect(0, 0, 1275, 1651))

	// x scales by 1275/612, y is measured down from the top of the page.
	if got.Min.X != 204 || got.Max.X != 481 {
		t.Errorf("x range %d..%d, want 204..481", got.Min.X, got.Max.X)
	}
	if got.Min.Y != 166 || got.Max.Y != 321 {
		t.Errorf("y range %d..%d, want 166..321", got.Min.Y, got.Max.Y)
	}
}

func TestPixelRectClipsToPage(t *testing.T) {
	fig := pdfFigure{
		box:     pdfBox{l: -50, b: -20, r: 700, t: 900},
		pageBox: pdfBox{l: 0, b: 0, r: 612, t: 792},
	}
	bounds := image.Rect(0, 0, 1275, 1651)
	if got := fig.pixelRect(bounds); got != bounds {
		t.Errorf("an oversized box should clip to the page, got %+v", got)
	}
}

func TestCaptionPrefersLineBelowFigure(t *testing.T) {
	b := pdfBox{l: 100, b: 400, r: 400, t: 600}
	lines := []pdfTextLine{
		{y: 620, text: "Figure 1: the one above"},
		{y: 385, text: "Figure 2: Residual learning: a building block."},
		{y: 500, text: "Figure 9: an axis label inside the box"},
	}
	if got := captionFor(b, lines); got != "Figure 2: Residual learning: a building block." {
		t.Errorf("got %q", got)
	}
}

func TestCaptionIgnoresOrdinaryProse(t *testing.T) {
	b := pdfBox{l: 100, b: 400, r: 400, t: 600}
	lines := []pdfTextLine{{y: 390, text: "are comparably good or better than the constructed solution"}}
	if got := captionFor(b, lines); got != "" {
		t.Errorf("want no caption, got %q", got)
	}
}

func TestResolveFiguresSwapsTokensForURLs(t *testing.T) {
	md := "intro\n\n![Figure 1: a plot](sam-figure:0)\n\nbody"
	got := resolveFigures(md, map[string]string{"sam-figure:0": "/api/v1/media/abc"})
	if !strings.Contains(got, "![Figure 1: a plot](/api/v1/media/abc)") {
		t.Errorf("token not resolved: %q", got)
	}
}

func TestResolveFiguresDropsUnmappedTokens(t *testing.T) {
	md := "intro\n\n![Figure 1](sam-figure:0)\n\nbody"
	got := resolveFigures(md, nil)
	if strings.Contains(got, "sam-figure") || strings.Contains(got, "![") {
		t.Errorf("placeholder survived: %q", got)
	}
	if got != "intro\n\nbody" {
		t.Errorf("blank lines not collapsed: %q", got)
	}
}

func TestSpliceFiguresPlacesFigureByHeight(t *testing.T) {
	frags := []pdfFrag{
		{x: 100, y: 700, text: "above the figure"},
		{x: 100, y: 300, text: "below the figure"},
	}
	boxes := []pdfBox{{l: 100, b: 400, r: 400, t: 600}}
	media := pdfBox{r: 612, t: 792}

	got, figs := spliceFigures(frags, boxes, 3, 0, pdfSingleColumn, media)
	if len(figs) != 1 || figs[0].page != 3 {
		t.Fatalf("want one figure on page 3, got %+v", figs)
	}
	want := []string{"above the figure", figs[0].markdown(), "below the figure"}
	for i, w := range want {
		if got[i].text != w {
			t.Errorf("line %d = %q, want %q", i, got[i].text, w)
		}
	}
}

// A table's cells are drawn inside the figure box. Left in the prose stream they
// reflow into one unreadable blob of numbers; they belong under the picture.
func TestSpliceFiguresCollapsesInteriorText(t *testing.T) {
	frags := []pdfFrag{
		{x: 100, y: 700, text: "body text above"},
		{x: 110, y: 560, text: "Model Own"},
		{x: 110, y: 540, text: "GPT 24,763"},
		{x: 110, y: 520, text: "Gemini 20,172"},
		{x: 100, y: 380, text: "Table 1: frontier model outputs"},
		{x: 100, y: 300, text: "body text below"},
	}
	boxes := []pdfBox{{l: 100, b: 400, r: 400, t: 600}}
	media := pdfBox{r: 612, t: 792}

	got, figs := spliceFigures(frags, boxes, 3, 0, pdfSingleColumn, media)

	var joined []string
	for _, f := range got {
		joined = append(joined, f.text)
	}
	all := strings.Join(joined, "\n")

	for _, cell := range []string{"GPT 24,763", "Gemini 20,172", "Model Own"} {
		if !strings.Contains(all, cell) {
			t.Errorf("interior text %q was dropped — it must stay searchable", cell)
		}
		if strings.Contains(joined[0], cell) || strings.Contains(joined[len(joined)-1], cell) {
			t.Errorf("interior text %q still sits in the prose stream", cell)
		}
	}

	figLine := joined[1]
	if !strings.HasPrefix(figLine, figs[0].markdown()) {
		t.Fatalf("figure line does not open with the image: %q", figLine)
	}
	if !strings.Contains(figLine, "<details><summary>Table 1 — text</summary><pre>") {
		t.Errorf("no captioned collapsible under the figure: %q", figLine)
	}
	// Rows must survive as rows, not be glued together.
	if !strings.Contains(figLine, "GPT 24,763<br>Gemini 20,172") {
		t.Errorf("printed rows were glued: %q", figLine)
	}
	// One line, or joinFrags + reflowParagraphs would treat each row as prose.
	if strings.Contains(strings.TrimPrefix(figLine, figs[0].markdown()+"\n"), "\n") {
		t.Errorf("the block must be a single line: %q", figLine)
	}
}

// A mis-detected box can cover most of a page. Collapsing that would hide the
// article behind a "show text" toggle.
func TestSpliceFiguresKeepsProseWhenBoxSwallowsThePage(t *testing.T) {
	var frags []pdfFrag
	for i := 0; i < 10; i++ {
		frags = append(frags, pdfFrag{x: 100, y: float64(600 - i*20), text: "a line of ordinary body prose"})
	}
	boxes := []pdfBox{{l: 50, b: 100, r: 500, t: 700}}

	got, _ := spliceFigures(frags, boxes, 1, 0, pdfSingleColumn, pdfBox{r: 612, t: 792})
	for _, f := range got {
		if strings.Contains(f.text, "<details>") {
			t.Fatalf("a page-sized box swallowed the body: %q", f.text)
		}
	}
	if len(got) != len(frags)+1 { // every line kept, plus the image
		t.Errorf("got %d fragments, want %d", len(got), len(frags)+1)
	}
}

// A stray axis label reads fine where it is; a collapsible for it is noise.
func TestSpliceFiguresLeavesTinyInteriorTextAlone(t *testing.T) {
	frags := []pdfFrag{
		{x: 100, y: 700, text: "body text above"},
		{x: 110, y: 500, text: "accuracy"},
	}
	boxes := []pdfBox{{l: 100, b: 400, r: 400, t: 600}}

	got, _ := spliceFigures(frags, boxes, 1, 0, pdfSingleColumn, pdfBox{r: 612, t: 792})
	for _, f := range got {
		if strings.Contains(f.text, "<details>") {
			t.Fatalf("one axis label was collapsed: %q", f.text)
		}
	}
}

func TestReflowKeepsInteriorTextBlockIntact(t *testing.T) {
	block := "<details><summary>Table 1 — text</summary><pre>a<br>b</pre></details>"
	text := strings.Join([]string{
		"a wrapped line of body text that runs the full column width here",
		"a wrapped line of body text that runs the full column width here",
		block,
		"a wrapped line of body text that runs the full column width here",
		"short tail.",
		"a wrapped line of body text that runs the full column width here",
		"a wrapped line of body text that runs the full column width here",
		"another line of body text that runs the full column width in here",
		"one more line of body text that runs the full column width in here",
	}, "\n")

	for _, para := range strings.Split(reflowParagraphs(text), "\n\n") {
		if strings.Contains(para, "<details>") && para != block {
			t.Fatalf("interior-text block merged into a paragraph: %q", para)
		}
	}
}

func TestInteriorBlockEscapesMarkup(t *testing.T) {
	got := interiorBlock([]pdfFrag{
		{x: 1, y: 3, text: "p < 0.05 & rising"},
		{x: 1, y: 2, text: "n > 10"},
		{x: 1, y: 1, text: "ok"},
	}, "")
	if strings.Contains(got, "p < 0.05") || strings.Contains(got, "n > 10") {
		t.Errorf("raw markup reached the HTML block: %q", got)
	}
	if !strings.Contains(got, "p &lt; 0.05 &amp; rising") {
		t.Errorf("escaping is wrong: %q", got)
	}
	if !strings.Contains(got, "<summary>Text in this figure</summary>") {
		t.Errorf("uncaptioned figure lost its fallback label: %q", got)
	}
}

func TestReflowKeepsFigureOnItsOwnLine(t *testing.T) {
	// The line above runs the full column width, so without the figure guard it
	// would swallow the image into its paragraph.
	text := strings.Join([]string{
		"a wrapped line of body text that runs the full column width here",
		"a wrapped line of body text that runs the full column width here",
		"![Figure 1](sam-figure:0)",
		"a wrapped line of body text that runs the full column width here",
		"short tail.",
		"a wrapped line of body text that runs the full column width here",
		"a wrapped line of body text that runs the full column width here",
		"another line of body text that runs the full column width in here",
		"one more line of body text that runs the full column width in here",
	}, "\n")

	got := reflowParagraphs(text)
	for _, para := range strings.Split(got, "\n\n") {
		if strings.Contains(para, "sam-figure") && para != "![Figure 1](sam-figure:0)" {
			t.Fatalf("figure merged into a paragraph: %q", para)
		}
	}
}
