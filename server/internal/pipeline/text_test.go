package pipeline

import (
	"strings"
	"testing"
)

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

func TestStripCodeFence(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"whole-body fence", "```\nKedves budapestiek!\n\nAz elmúlt hetekben\n```", "Kedves budapestiek!\n\nAz elmúlt hetekben"},
		{"fence with lang tag", "```text\nhello\nworld\n```", "hello\nworld"},
		{"leading blank lines before fence", "\n\n```\nbody\n```", "body"},
		{"no fence unchanged", "# Heading\n\nprose paragraph", "# Heading\n\nprose paragraph"},
		{"open fence but no close unchanged", "```\nno closing fence here", "```\nno closing fence here"},
		{"inline code block not stripped", "intro\n\n```\ncode\n```\n\noutro", "intro\n\n```\ncode\n```\n\noutro"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := StripCodeFence(c.in); got != c.want {
				t.Errorf("StripCodeFence(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

type dllItem struct {
	Title string `json:"title"`
}

// TestDecodeLLMList covers the shape tolerance itself, independent of any one
// step: the documented wrapper object still works, a bare top-level array (what
// job 8cd52ad8 actually got back from qwen3-sum) is accepted as the same list, a
// markdown fence around either shape is stripped first, and genuine garbage still
// fails with the raw reply intact in the error.
func TestDecodeLLMList(t *testing.T) {
	cases := []struct {
		name       string
		reply      string
		wantTitles []string
		wantErr    bool
	}{
		{
			name:       "wrapper object",
			reply:      `{"items": [{"title": "a"}, {"title": "b"}]}`,
			wantTitles: []string{"a", "b"},
		},
		{
			name:       "bare array",
			reply:      `[{"title": "a"}, {"title": "b"}]`,
			wantTitles: []string{"a", "b"},
		},
		{
			name:       "fenced wrapper object",
			reply:      "```json\n{\"items\": [{\"title\": \"a\"}]}\n```",
			wantTitles: []string{"a"},
		},
		{
			name:       "fenced bare array",
			reply:      "```json\n[{\"title\": \"a\"}]\n```",
			wantTitles: []string{"a"},
		},
		{
			name:       "wrapper object missing key decodes empty, no error",
			reply:      `{"other": "field"}`,
			wantTitles: nil,
		},
		{
			name:    "genuine garbage still errors",
			reply:   "not json at all",
			wantErr: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := DecodeLLMList[dllItem](c.reply, "items", "test_step")
			if c.wantErr {
				if err == nil {
					t.Fatalf("want error, got items %+v", got)
				}
				if !strings.Contains(err.Error(), "test_step: parse llm json:") || !strings.Contains(err.Error(), c.reply) {
					t.Fatalf("error must name the step and carry the raw reply, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			var titles []string
			for _, it := range got {
				titles = append(titles, it.Title)
			}
			if len(titles) != len(c.wantTitles) {
				t.Fatalf("got titles %v, want %v", titles, c.wantTitles)
			}
			for i := range titles {
				if titles[i] != c.wantTitles[i] {
					t.Fatalf("got titles %v, want %v", titles, c.wantTitles)
				}
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

// A small model that opens the documented wrapper, emits a bare array anyway and
// then closes the brace produces valid JSON plus one stray byte. That is a
// formatting slip, not a content failure — job 090344f0 lost six correct,
// verbatim highlights to it.
func TestDecodeLLMListToleratesTrailingNoise(t *testing.T) {
	type item struct {
		Kind string `json:"kind"`
		Body string `json:"body"`
	}
	for _, tc := range []struct {
		name, reply string
		want        int
		wantErr     bool
	}{
		{"bare array with a stray closing brace", `[{"kind":"idea","body":"b"},{"kind":"quote","body":"c"}]}`, 2, false},
		{"wrapper with trailing prose", `{"highlights":[{"kind":"idea","body":"b"}]} hope that helps!`, 1, false},
		{"clean bare array still works", `[{"kind":"idea","body":"b"}]`, 1, false},
		{"clean wrapper still works", `{"highlights":[{"kind":"idea","body":"b"}]}`, 1, false},
		{"genuine garbage still errors", `not json at all`, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DecodeLLMList[item](tc.reply, "highlights", "test_step")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %d items", len(got))
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != tc.want {
				t.Fatalf("got %d items, want %d", len(got), tc.want)
			}
		})
	}
}
