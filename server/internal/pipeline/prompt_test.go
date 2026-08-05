package pipeline

import (
	"strings"
	"testing"
)

// TestRenderPromptPlaceholders: every token is expanded, and document text that
// itself looks like a token is left alone (single-pass replacement).
func TestRenderPromptPlaceholders(t *testing.T) {
	got := renderPrompt("do it{{recently_covered}}\n\n# {{title}}\n\n{{content}}", map[string]string{
		"title":            "T",
		"content":          "body with a literal {{title}} in it",
		"recently_covered": "\n\nSEEN",
	})
	want := "do it\n\nSEEN\n\n# T\n\nbody with a literal {{title}} in it"
	if got != want {
		t.Fatalf("render mismatch:\n got: %q\nwant: %q", got, want)
	}
}

// TestRenderPromptMissingVarRendersEmpty: a token the step doesn't produce must
// vanish, not leak as literal "{{recently_covered}}".
func TestRenderPromptMissingVarRendersEmpty(t *testing.T) {
	got := renderPrompt("P{{recently_covered}}\n\n# {{title}}\n\n{{content}}", map[string]string{
		"title": "T", "content": "C",
	})
	if want := "P\n\n# T\n\nC"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// TestRenderPromptLegacyTail: a hand-typed one-line prompt with no {{content}}
// still gets the document appended, exactly the way the steps composed it before
// templating existed.
func TestRenderPromptLegacyTail(t *testing.T) {
	got := renderPrompt("Summarize this.", map[string]string{"title": "T", "content": "C"})
	if want := "Summarize this.\n\n# T\n\nC"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// TestDefaultPromptsComposeLegacyMessage is the byte-identity guard: for a
// default config, the rendered user message must equal the concatenation the
// steps hardcoded before the prompts moved into the catalog.
func TestDefaultPromptsComposeLegacyMessage(t *testing.T) {
	const title, content, seen = "The Title", "the body", "\n\nALREADY COVERED: x"

	cases := []struct {
		kind   string
		prefix string // opening of the historical Go prompt const — guards a reword
		vars   map[string]string
		legacy func(base string) string
	}{
		{
			kind:   kindLLMSummarize,
			prefix: "Summarize as caveman. Rules: drop all articles (a/an/the),",
			vars:   map[string]string{"title": title, "content": content},
			legacy: func(base string) string {
				return base + "\n\n# " + title + "\n\n" + content
			},
		},
		{
			kind:   kindLLMTopics,
			prefix: "You split a newsletter into its distinct topics/sections.",
			vars:   map[string]string{"title": title, "content": content},
			legacy: func(base string) string {
				return base + "\n\n# " + title + "\n\n" + content
			},
		},
		{
			kind:   kindLLM321Newsletter,
			prefix: "You parse James Clear's 3-2-1 newsletter.",
			vars:   map[string]string{"title": title, "content": content},
			legacy: func(base string) string {
				return base + "\n\n# " + title + "\n\n" + content
			},
		},
		{
			kind:   kindLLMAINewsletter,
			prefix: "You analyze AI/ML newsletters.",
			vars:   map[string]string{"title": title, "content": content, "recently_covered": seen},
			legacy: func(base string) string {
				return base + seen + "\n\n# " + title + "\n\n" + content
			},
		},
	}

	for _, tc := range cases {
		tmpl := defaultPrompt(tc.kind)
		if tmpl == "" {
			t.Fatalf("%s: no default prompt in catalog", tc.kind)
		}
		if !strings.HasPrefix(tmpl, tc.prefix) {
			t.Fatalf("%s: default prompt no longer starts with the historical text %q", tc.kind, tc.prefix)
		}
		base, ok := trimSuffix(tmpl, promptTemplateTail)
		if !ok {
			t.Fatalf("%s: default prompt does not end with the shared template tail", tc.kind)
		}
		if got, want := renderPrompt(tmpl, tc.vars), tc.legacy(base); got != want {
			t.Fatalf("%s: composed message differs from legacy:\n got: %q\nwant: %q", tc.kind, got, want)
		}
	}
}

func trimSuffix(s, suffix string) (string, bool) {
	if len(s) < len(suffix) || s[len(s)-len(suffix):] != suffix {
		return s, false
	}
	return s[:len(s)-len(suffix)], true
}
