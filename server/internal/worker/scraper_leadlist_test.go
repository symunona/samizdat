package worker

import "testing"

// Regression for the doubled-body bug (Joy & Curiosity #92): extractLeadLists
// re-serialized the newsletter <ul> and prepended it because its dedup guard
// failed when the first bullet's pre-link text was short ("Finally: ["). The URL
// anchor is format-stable, so it matches trafilatura's line-broken rendering.
func TestExtractLeadLists_DedupsWhenTrafilaturaLineBreaksLinks(t *testing.T) {
	// Trafilatura output: same list, but link split onto its own line.
	extractedMD := "- Finally:\n\n  [Amp now has subscriptions](https://ampcode.com/news/subscriptions). Yes, you read that right.\n" +
		"- Fabien Sanglard:\n\n  [Don't you mean extinct?](https://fabiensanglard.net/extinct/index.html) Lovely article, worth your time."

	// Raw HTML with the same bullets — the exact shape that used to double.
	rawHTML := []byte(`<html><body><ul>` +
		`<li>Finally: <a href="https://ampcode.com/news/subscriptions">Amp now has subscriptions</a>. Yes, you read that right.</li>` +
		`<li>Fabien Sanglard: <a href="https://fabiensanglard.net/extinct/index.html">Don't you mean extinct?</a> Lovely article, worth your time.</li>` +
		`</ul></body></html>`)

	if got := extractLeadLists(rawHTML, extractedMD); got != "" {
		t.Fatalf("expected list to dedup (already in trafilatura output), got prepend:\n%s", got)
	}
}

// A list trafilatura genuinely dropped must still be recovered (the reason the
// step exists) — absence of the URL means "not present" → keep.
func TestExtractLeadLists_KeepsListTrafilaturaDropped(t *testing.T) {
	extractedMD := "Some prose paragraph with no bullets at all."
	rawHTML := []byte(`<html><body><ul>` +
		`<li>First: <a href="https://example.com/a">link a</a> with enough text.</li>` +
		`<li>Second: <a href="https://example.com/b">link b</a> with enough text.</li>` +
		`</ul></body></html>`)

	got := extractLeadLists(rawHTML, extractedMD)
	if got == "" {
		t.Fatal("expected dropped list to be recovered, got empty")
	}
}

// Linkless list falls back to normalized-text matching, tolerant of whitespace
// and case differences between the two serializations.
func TestExtractLeadLists_LinklessFallbackDedups(t *testing.T) {
	extractedMD := "- buy   milk and   eggs today\n- call the   plumber about the leak"
	rawHTML := []byte(`<html><body><ul>` +
		`<li>Buy milk and eggs today</li>` +
		`<li>Call the plumber about the leak</li>` +
		`</ul></body></html>`)

	if got := extractLeadLists(rawHTML, extractedMD); got != "" {
		t.Fatalf("expected linkless list to dedup via normalized text, got:\n%s", got)
	}
}
