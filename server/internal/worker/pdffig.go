package worker

import (
	"fmt"
	"image"
	"math"
	"regexp"
	"strings"

	"github.com/ledongthuc/pdf"
)

// Figure-detection thresholds, in PDF points (1/72").
const (
	// Boxes this close are one figure: a plot's axes, its curve and its legend
	// arrive as separate drawings that must not become separate assets.
	pdfFigMergeGap = 12
	// Anything smaller is furniture, not a figure: rules, underlines, bullets,
	// the little glyphs a typesetter draws as paths.
	pdfFigMinWidth  = 60
	pdfFigMinHeight = 40
	// A box repeating at the same spot (within this slack) on at least this
	// fraction of pages is a running header/logo, not a figure.
	pdfFigRepeatSlack = 3
	pdfFigRepeatRatio = 0.5
)

// pdfBox is an axis-aligned rectangle in PDF user space (origin bottom-left).
type pdfBox struct{ l, b, r, t float64 }

func (a pdfBox) width() float64  { return a.r - a.l }
func (a pdfBox) height() float64 { return a.t - a.b }

// near reports whether two boxes overlap or sit within pad of each other.
func (a pdfBox) near(c pdfBox, pad float64) bool {
	return a.l-pad < c.r && c.l-pad < a.r && a.b-pad < c.t && c.b-pad < a.t
}

func (a *pdfBox) merge(c pdfBox) {
	a.l = math.Min(a.l, c.l)
	a.b = math.Min(a.b, c.b)
	a.r = math.Max(a.r, c.r)
	a.t = math.Max(a.t, c.t)
}

// pdfMatrix is a PDF transformation matrix [a b c d e f].
type pdfMatrix [6]float64

var pdfIdentity = pdfMatrix{1, 0, 0, 1, 0, 0}

// mul returns m×n, in PDF's row-vector convention.
func (m pdfMatrix) mul(n pdfMatrix) pdfMatrix {
	return pdfMatrix{
		m[0]*n[0] + m[1]*n[2],
		m[0]*n[1] + m[1]*n[3],
		m[2]*n[0] + m[3]*n[2],
		m[2]*n[1] + m[3]*n[3],
		m[4]*n[0] + m[5]*n[2] + n[4],
		m[4]*n[1] + m[5]*n[3] + n[5],
	}
}

// apply maps a point through the matrix.
func (m pdfMatrix) apply(x, y float64) (float64, float64) {
	return m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]
}

// boxOfUnitSquare is the device-space box of the unit square under m — the
// footprint of an image XObject, which PDF always draws into (0,0)-(1,1).
func (m pdfMatrix) boxOfUnitSquare() pdfBox {
	return m.boxOfRect(0, 0, 1, 1)
}

// boxOfRect maps a rectangle's four corners and takes their extent, so rotated
// and flipped transforms still yield a correct axis-aligned box.
func (m pdfMatrix) boxOfRect(x0, y0, x1, y1 float64) pdfBox {
	xa, ya := m.apply(x0, y0)
	xb, yb := m.apply(x1, y0)
	xc, yc := m.apply(x1, y1)
	xd, yd := m.apply(x0, y1)
	return pdfBox{
		l: math.Min(math.Min(xa, xb), math.Min(xc, xd)),
		r: math.Max(math.Max(xa, xb), math.Max(xc, xd)),
		b: math.Min(math.Min(ya, yb), math.Min(yc, yd)),
		t: math.Max(math.Max(ya, yb), math.Max(yc, yd)),
	}
}

// pageDrawings returns the box of every non-text drawing on a page: image and
// form XObjects, plus paths that are actually painted.
//
// This walks the content stream rather than asking the render engine, because
// the render engine (MuPDF) only ever hands back a whole page — it has no
// page-object enumeration. The stream has everything needed: `cm` builds the
// CTM, `Do` names an XObject whose footprint follows from the CTM, and path
// operators carry their own coordinates.
//
// Paths are only counted once *painted*: a clipping path (`W n`) is usually the
// full page or the full column, and counting it would swallow the whole page
// into one "figure".
func pageDrawings(p pdf.Page) []pdfBox {
	res := p.Resources().Key("XObject")

	var (
		out   []pdfBox
		ctm   = pdfIdentity
		stack []pdfMatrix
		cur   *pdfBox // box of the path under construction
		curX  float64 // current point, for operators that omit it
		curY  float64
	)

	addPoint := func(x, y float64) {
		dx, dy := ctm.apply(x, y)
		p := pdfBox{l: dx, b: dy, r: dx, t: dy}
		if cur == nil {
			cur = &p
		} else {
			cur.merge(p)
		}
		curX, curY = x, y
	}
	paint := func() {
		if cur != nil {
			out = append(out, *cur)
		}
		cur = nil
	}

	pdf.Interpret(p.V.Key("Contents"), func(stk *pdf.Stack, op string) {
		n := stk.Len()
		args := make([]pdf.Value, n)
		for i := n - 1; i >= 0; i-- {
			args[i] = stk.Pop()
		}
		f := func(i int) float64 {
			if i < len(args) {
				return args[i].Float64()
			}
			return 0
		}

		switch op {
		case "q":
			stack = append(stack, ctm)
		case "Q":
			if len(stack) > 0 {
				ctm = stack[len(stack)-1]
				stack = stack[:len(stack)-1]
			}
		case "cm":
			if len(args) == 6 {
				ctm = pdfMatrix{f(0), f(1), f(2), f(3), f(4), f(5)}.mul(ctm)
			}
		case "m", "l":
			addPoint(f(0), f(1))
		case "c": // three control points; the extent of all of them bounds the curve
			addPoint(f(0), f(1))
			addPoint(f(2), f(3))
			addPoint(f(4), f(5))
		case "v": // current point is the first control point
			addPoint(curX, curY)
			addPoint(f(0), f(1))
			addPoint(f(2), f(3))
		case "y":
			addPoint(f(0), f(1))
			addPoint(f(2), f(3))
		case "re":
			x, y, w, h := f(0), f(1), f(2), f(3)
			addPoint(x, y)
			addPoint(x+w, y+h)
		case "S", "s", "f", "F", "f*", "B", "B*", "b", "b*":
			paint()
		case "n": // path used for clipping only — never a figure
			cur = nil
		case "Do":
			if len(args) != 1 {
				return
			}
			xo := res.Key(args[0].Name())
			switch xo.Key("Subtype").Name() {
			case "Image":
				out = append(out, ctm.boxOfUnitSquare())
			case "Form":
				// A LaTeX figure is typically one form. Its /BBox is in the form's
				// own space, so the optional /Matrix applies before the CTM.
				bb := xo.Key("BBox")
				if bb.Len() != 4 {
					return
				}
				m := ctm
				if fm := xo.Key("Matrix"); fm.Len() == 6 {
					var v pdfMatrix
					for i := 0; i < 6; i++ {
						v[i] = fm.Index(i).Float64()
					}
					m = v.mul(ctm)
				}
				out = append(out, m.boxOfRect(
					bb.Index(0).Float64(), bb.Index(1).Float64(),
					bb.Index(2).Float64(), bb.Index(3).Float64()))
			}
		}
	})

	return out
}

// clusterBoxes merges boxes that overlap or nearly touch, repeatedly, until the
// set stops shrinking — one pass is not enough, since merging A into B can bring
// B within reach of C.
func clusterBoxes(boxes []pdfBox, pad float64) []pdfBox {
	out := append([]pdfBox(nil), boxes...)
	for {
		var next []pdfBox
		for _, b := range out {
			merged := false
			for i := range next {
				if next[i].near(b, pad) {
					next[i].merge(b)
					merged = true
					break
				}
			}
			if !merged {
				next = append(next, b)
			}
		}
		if len(next) == len(out) {
			return next
		}
		out = next
	}
}

// figureBoxes reduces a page's raw drawings to the boxes worth cutting out.
func figureBoxes(drawings []pdfBox) []pdfBox {
	var out []pdfBox
	for _, b := range clusterBoxes(drawings, pdfFigMergeGap) {
		if b.width() >= pdfFigMinWidth && b.height() >= pdfFigMinHeight {
			out = append(out, b)
		}
	}
	return out
}

// dropRepeating removes boxes that appear at the same spot on most pages — a
// running header, a journal stamp, a logo. pages is per-page figure boxes; the
// returned slice keeps that shape.
func dropRepeating(pages [][]pdfBox) [][]pdfBox {
	if len(pages) < 3 {
		return pages
	}
	seen := func(b pdfBox) int {
		n := 0
		for _, page := range pages {
			for _, c := range page {
				if math.Abs(b.l-c.l) <= pdfFigRepeatSlack && math.Abs(b.t-c.t) <= pdfFigRepeatSlack &&
					math.Abs(b.r-c.r) <= pdfFigRepeatSlack && math.Abs(b.b-c.b) <= pdfFigRepeatSlack {
					n++
					break // once per page
				}
			}
		}
		return n
	}

	limit := float64(len(pages)) * pdfFigRepeatRatio
	out := make([][]pdfBox, len(pages))
	for i, page := range pages {
		for _, b := range page {
			if float64(seen(b)) <= limit {
				out[i] = append(out[i], b)
			}
		}
	}
	return out
}

// captionPrefixes start the line that names a figure. Matched case-insensitively
// on the line's first word.
var captionPrefixes = []string{"figure", "fig.", "fig", "table", "chart", "algorithm", "listing"}

// captionFor returns the caption line for a figure box: the nearest line whose
// text opens like a caption, below the box first (the usual place) and above it
// otherwise. lines are (y, text) in page space.
func captionFor(b pdfBox, lines []pdfTextLine) string {
	const reach = 40 // pt; a caption sits directly against its figure

	best, bestDist := "", math.Inf(1)
	for _, ln := range lines {
		if !isCaptionLine(ln.text) {
			continue
		}
		var d float64
		switch {
		case ln.y <= b.b: // below
			d = b.b - ln.y
		case ln.y >= b.t: // above — same reach, but loses ties to a line below
			d = (ln.y - b.t) + 1
		default:
			continue // inside the figure: an axis label, not a caption
		}
		if d <= reach && d < bestDist {
			best, bestDist = ln.text, d
		}
	}
	return best
}

// isCaptionLine reports whether a line opens like a figure caption.
func isCaptionLine(s string) bool {
	fields := strings.Fields(strings.ToLower(strings.TrimSpace(s)))
	if len(fields) < 2 {
		return false
	}
	for _, p := range captionPrefixes {
		if fields[0] == p {
			return true
		}
	}
	return false
}

// inheritedKey looks a key up on a page dict, then on its ancestors — page
// attributes like MediaBox are commonly declared once on the page tree root.
// The depth cap guards against a malformed file whose /Parent chain loops.
func inheritedKey(v pdf.Value, key string) pdf.Value {
	for depth := 0; depth < 32 && !v.IsNull(); depth++ {
		if got := v.Key(key); !got.IsNull() {
			return got
		}
		v = v.Key("Parent")
	}
	return pdf.Value{}
}

// pdfTextLine is one rendered line of a page with the baseline it sat on.
type pdfTextLine struct {
	y    float64
	x    float64
	text string
}

// pdfFigure is one figure cut out of a page: where it was drawn, what it was
// called, and the placeholder standing in for it in the markdown until the asset
// is stored.
type pdfFigure struct {
	id   int
	page int
	box  pdfBox
	// pageBox is the page's MediaBox, needed to map box (PDF points, origin
	// bottom-left, possibly offset) onto the rendered bitmap (pixels, origin
	// top-left).
	pageBox pdfBox
	caption string
}

// mediaBox reads a page's MediaBox, falling back to US Letter when the page
// declares none (rare, and the fallback is what every reader assumes).
//
// The attribute is read off the page dict by hand, walking up /Parent, because
// the library's own MediaBox accessor is commented out in this fork.
func mediaBox(p pdf.Page) pdfBox {
	v := inheritedKey(p.V, "MediaBox")
	if v.Len() != 4 {
		return pdfBox{l: 0, b: 0, r: 612, t: 792}
	}
	return pdfBox{
		l: math.Min(v.Index(0).Float64(), v.Index(2).Float64()),
		b: math.Min(v.Index(1).Float64(), v.Index(3).Float64()),
		r: math.Max(v.Index(0).Float64(), v.Index(2).Float64()),
		t: math.Max(v.Index(1).Float64(), v.Index(3).Float64()),
	}
}

// token is the placeholder link target for a figure. It is never served — it
// only survives between extraction and the asset write in handlePDF.
func (f pdfFigure) token() string {
	return fmt.Sprintf("sam-figure:%d", f.id)
}

// assetURL is the synthetic original_url a figure is registered under. The
// media_assets uniqueness index needs a URL, and a figure has none — this key is
// derived purely from where the figure sits, so re-scraping the same PDF
// overwrites its assets instead of duplicating them.
func (f pdfFigure) assetURL(documentID string) string {
	return fmt.Sprintf("pdf://%s/p%d/fig%d", documentID, f.page, f.id)
}

// pixelRect maps a figure's box (PDF points, origin bottom-left, MediaBox may be
// offset) onto a rendered page bitmap (pixels, origin top-left), clipped to the
// bitmap. The scale is derived from the bitmap itself rather than assumed from
// the DPI, so a renderer that rounds page dimensions cannot shift the crop.
func (f pdfFigure) pixelRect(bounds image.Rectangle) image.Rectangle {
	pw, ph := f.pageBox.width(), f.pageBox.height()
	if pw <= 0 || ph <= 0 {
		return image.Rectangle{}
	}
	sx := float64(bounds.Dx()) / pw
	sy := float64(bounds.Dy()) / ph

	return image.Rect(
		bounds.Min.X+int((f.box.l-f.pageBox.l)*sx),
		bounds.Min.Y+int((f.pageBox.t-f.box.t)*sy),
		bounds.Min.X+int((f.box.r-f.pageBox.l)*sx),
		bounds.Min.Y+int((f.pageBox.t-f.box.b)*sy),
	).Intersect(bounds)
}

// markdown renders the figure as a markdown image pointing at its token.
func (f pdfFigure) markdown() string {
	return "![" + escapeMarkdownAlt(f.caption) + "](" + f.token() + ")"
}

// figureTokenRe matches a spliced figure image, whatever its caption.
var figureTokenRe = regexp.MustCompile(`!\[[^\]]*\]\(sam-figure:(\d+)\)`)

// resolveFigures swaps figure placeholders for the media URLs their assets
// ended up at. A token with no URL — the figure failed to render, or this is the
// first write, before anything is stored — is removed entirely, so a Document
// never carries a broken image.
func resolveFigures(md string, urls map[string]string) string {
	out := figureTokenRe.ReplaceAllStringFunc(md, func(m string) string {
		token := "sam-figure:" + figureTokenRe.FindStringSubmatch(m)[1]
		url, ok := urls[token]
		if !ok {
			return ""
		}
		return strings.Replace(m, "("+token+")", "("+url+")", 1)
	})
	// Dropping an image can leave the blank lines that surrounded it stacked up.
	return strings.TrimSpace(regexp.MustCompile(`\n{3,}`).ReplaceAllString(out, "\n\n"))
}

// escapeMarkdownAlt keeps a caption's brackets from closing the image syntax.
func escapeMarkdownAlt(s string) string {
	return strings.NewReplacer("[", "(", "]", ")", "\n", " ").Replace(strings.TrimSpace(s))
}
