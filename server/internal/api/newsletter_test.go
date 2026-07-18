package api

import (
	"strings"
	"testing"
)

func TestPlaintextToHTML(t *testing.T) {
	// Blank-line-separated blocks become <p>; single newlines become <br>. The point
	// is to NOT emit a <pre> (which the html→markdown pass would turn into a ``` fence
	// that renders the whole newsletter as one code block).
	in := "Kedves budapestiek!\n\nMetró felújítás\nÚj pavilonok épültek.\r\n\r\nÜdv"
	got := plaintextToHTML(in)

	if strings.Contains(got, "<pre>") {
		t.Fatalf("plaintextToHTML must not emit <pre>: %q", got)
	}
	for _, want := range []string{
		"<p>Kedves budapestiek!</p>",
		"<p>Metró felújítás<br>\nÚj pavilonok épültek.</p>",
		"<p>Üdv</p>",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("plaintextToHTML(%q) = %q, missing %q", in, got, want)
		}
	}
}

func TestPlaintextToHTMLEscapes(t *testing.T) {
	got := plaintextToHTML("a < b & c > d")
	if !strings.Contains(got, "a &lt; b &amp; c &gt; d") {
		t.Errorf("expected HTML-escaped body, got %q", got)
	}
}
