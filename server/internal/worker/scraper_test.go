package worker

import (
	"strings"
	"testing"
)

// TestUnwrapFigureImages verifies <figure>-wrapped images are lifted into inline
// <p><img> at their original position so trafilatura keeps them in document order.
func TestUnwrapFigureImages(t *testing.T) {
	in := `<html><body><article>
<p>First paragraph of the article body text.</p>
<figure><img src="https://cdn.example.com/a.jpeg" alt="Alpha"><figcaption>cap</figcaption></figure>
<p>Second paragraph between the two images.</p>
<figure><img data-src="https://cdn.example.com/b.jpeg"></figure>
<p>Third and final paragraph.</p>
<aside><figure><img src="https://cdn.example.com/promo.jpeg"></figure></aside>
</article></body></html>`

	out := string(unwrapFigureImages([]byte(in)))

	// Figures became <p><img>; <figure> tags are gone in the article body.
	if strings.Count(out, "<figure") != 1 { // only the <aside> figure survives untouched
		t.Errorf("expected exactly 1 surviving <figure> (in aside), got:\n%s", out)
	}
	// Positions preserved: a.jpeg between para 1 and 2, b.jpeg between 2 and 3.
	idxA := strings.Index(out, "a.jpeg")
	idxB := strings.Index(out, "b.jpeg")
	idx2 := strings.Index(out, "Second paragraph")
	idx3 := strings.Index(out, "Third and final")
	if idxA < 0 || idxA >= idx2 || idx2 >= idxB || idxB >= idx3 {
		t.Errorf("image order not preserved: a=%d second=%d b=%d third=%d", idxA, idx2, idxB, idx3)
	}
	// Lazy data-src resolved to a real src.
	if !strings.Contains(out, `src="https://cdn.example.com/b.jpeg"`) {
		t.Errorf("data-src not resolved to src:\n%s", out)
	}
	// alt preserved.
	if !strings.Contains(out, `alt="Alpha"`) {
		t.Errorf("alt not preserved:\n%s", out)
	}
	// Boilerplate figure inside <aside> left untouched (trafilatura drops the region).
	if !strings.Contains(out, "promo.jpeg") {
		t.Errorf("aside image should be left in place:\n%s", out)
	}
}

// TestUnwrapFigureImagesNoFigures returns input unchanged when nothing to rewrite.
func TestUnwrapFigureImagesNoFigures(t *testing.T) {
	in := []byte(`<html><body><p>plain text, no figures here</p></body></html>`)
	if got := unwrapFigureImages(in); string(got) != string(in) {
		t.Errorf("expected unchanged input, got:\n%s", got)
	}
}
