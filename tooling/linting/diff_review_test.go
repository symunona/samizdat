package linting

import "testing"

// The tool asks Claude for a FULL rewrite of CLAUDE.md and then writes it, with a
// Y/n prompt that defaults to yes. A truncated reply therefore deletes everything
// past the cut — that is how server/CLAUDE.md lost 67 lines of PDF and video
// notes. This guard is the last thing standing between a bad reply and the file.
func TestShrinksTooMuch(t *testing.T) {
	const doc = "0123456789" // 10 bytes, so "lost" reads as a percentage directly

	cases := []struct {
		name     string
		current  string
		proposed string
		wantOK   bool
	}{
		{"a rewrite that grows the file is fine", doc, doc + "more notes", true},
		{"an unchanged file is fine", doc, doc, true},
		{"trimming a little prose is fine", doc, "012345678", true},
		{"losing a third is a truncation", doc, "0123456", false},
		{"losing everything is a truncation", doc, "", false},
		{"no file yet: anything is an addition", "", "brand new doc", true},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lost, ok := shrinksTooMuch(c.current, c.proposed)
			if ok != c.wantOK {
				t.Fatalf("shrinksTooMuch(%q, %q) ok = %v, want %v (lost %d%%)",
					c.current, c.proposed, ok, c.wantOK, lost)
			}
		})
	}
}
