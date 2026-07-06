package pipeline

import "testing"

func TestStripLeadingTitle(t *testing.T) {
	cases := []struct {
		name, body, title, want string
	}{
		{"markdown heading", "# Go 1.21 Release\n\n- foo\n- bar", "The Go Programming Language", "- foo\n- bar"},
		{"echoed title", "The Go Programming Language\n\n- foo", "The Go Programming Language", "- foo"},
		{"echoed title bold/punct", "**The Go Programming Language.**\n- foo", "The Go Programming Language", "- foo"},
		{"no title line", "- first bullet\n- second", "The Go Programming Language", "- first bullet\n- second"},
		{"empty title never strips content", "real first line\nmore", "", "real first line\nmore"},
		{"single line heading", "# Only a heading", "Doc", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := StripLeadingTitle(c.body, c.title); got != c.want {
				t.Errorf("StripLeadingTitle(%q, %q) = %q, want %q", c.body, c.title, got, c.want)
			}
		})
	}
}

func TestFirstSentenceTitle(t *testing.T) {
	cases := []struct {
		name, body string
		max        int
		want       string
	}{
		{"first sentence within limit", "Do the hard thing first. It compounds.", 10, "Do the hard thing first"},
		{"cap at max words", "One two three four five six seven eight nine ten eleven twelve", 10, "One two three four five six seven eight nine ten"},
		{"strips markdown", "**Focus** on *one* thing. Rest later.", 10, "Focus on one thing"},
		{"first line only", "Line one is the title\nLine two ignored", 10, "Line one is the title"},
		{"question mark ends sentence", "What matters most? Everything else is noise.", 10, "What matters most"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := firstSentenceTitle(c.body, c.max); got != c.want {
				t.Errorf("firstSentenceTitle(%q, %d) = %q, want %q", c.body, c.max, got, c.want)
			}
		})
	}
}
