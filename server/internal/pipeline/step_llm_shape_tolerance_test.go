package pipeline

import (
	"encoding/json"
	"strings"
	"testing"
)

// These three steps used to fail job 8cd52ad8-style: a small local model returns
// complete, correctly-shaped JSON for the list itself but drops the documented
// wrapper object, and the step died with "cannot unmarshal array into Go value of
// type ...Response". DecodeLLMList / UnwrapLLMReply (text.go) fixed that; these
// tests drive each step's handler end-to-end (not just the decode helper) so a
// regression in how a step WIRES the helper — not just the helper itself — still
// fails the build.

// TestLLM321NewsletterAcceptsBareArray: wrapper object, bare array, and both
// fenced, all produce the same 2 highlights; genuine garbage still errors with
// the raw reply.
func TestLLM321NewsletterAcceptsBareArray(t *testing.T) {
	const wrapper = `{"highlights":[{"kind":"idea","title":"ignored","body":"Keep moving forward."},{"kind":"quote","title":"Author Name","body":"A quote body."}]}`
	const bare = `[{"kind":"idea","title":"ignored","body":"Keep moving forward."},{"kind":"quote","title":"Author Name","body":"A quote body."}]`

	cases := []struct {
		name    string
		reply   string
		wantErr bool
	}{
		{"wrapper object", wrapper, false},
		{"bare array", bare, false},
		{"fenced wrapper object", "```json\n" + wrapper + "\n```", false},
		{"fenced bare array", "```json\n" + bare + "\n```", false},
		{"genuine garbage", "not json at all", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, q, run := setupRun(t)
			_, err := handleLLM321Newsletter(ctx, q, run, json.RawMessage(`{}`), stubRouter(t, c.reply))
			if c.wantErr {
				if err == nil {
					t.Fatal("want error for unparseable reply, got nil")
				}
				if !strings.Contains(err.Error(), "llm_321_newsletter: parse llm json:") || !strings.Contains(err.Error(), c.reply) {
					t.Fatalf("error must name the step and carry the raw reply, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("llm_321_newsletter: %v", err)
			}
			hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
			if err != nil {
				t.Fatalf("list highlights: %v", err)
			}
			if len(hs) != 2 {
				t.Fatalf("want 2 highlights, got %d", len(hs))
			}
			byKind := map[string]string{}
			for _, h := range hs {
				byKind[h.Kind] = h.Title
			}
			// Idea titles are re-derived deterministically (firstSentenceTitle), not
			// taken from the model — so "ignored" never survives either shape.
			if got := byKind["idea"]; got != "Keep moving forward" {
				t.Fatalf("idea title = %q, want the derived first sentence", got)
			}
			if got := byKind["quote"]; got != "Author Name" {
				t.Fatalf("quote title = %q, want %q", got, "Author Name")
			}
		})
	}
}

// TestLLMTopicsAcceptsBareArray: same tolerance, single-field wrapper.
func TestLLMTopicsAcceptsBareArray(t *testing.T) {
	const wrapper = `{"highlights":[{"title":"Topic A","body":"Body A text."},{"title":"Topic B","body":"Body B text."}]}`
	const bare = `[{"title":"Topic A","body":"Body A text."},{"title":"Topic B","body":"Body B text."}]`

	cases := []struct {
		name    string
		reply   string
		wantErr bool
	}{
		{"wrapper object", wrapper, false},
		{"bare array", bare, false},
		{"fenced wrapper object", "```json\n" + wrapper + "\n```", false},
		{"fenced bare array", "```json\n" + bare + "\n```", false},
		{"genuine garbage", "not json at all", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, q, run := setupRun(t)
			_, err := handleLLMTopics(ctx, q, run, json.RawMessage(`{}`), stubRouter(t, c.reply))
			if c.wantErr {
				if err == nil {
					t.Fatal("want error for unparseable reply, got nil")
				}
				if !strings.Contains(err.Error(), "llm_topics: parse llm json:") || !strings.Contains(err.Error(), c.reply) {
					t.Fatalf("error must name the step and carry the raw reply, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("llm_topics: %v", err)
			}
			hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
			if err != nil {
				t.Fatalf("list highlights: %v", err)
			}
			if len(hs) != 2 {
				t.Fatalf("want 2 highlights, got %d", len(hs))
			}
			titles := map[string]bool{}
			for _, h := range hs {
				if h.Kind != "topic" {
					t.Fatalf("kind = %q, want topic", h.Kind)
				}
				titles[h.Title] = true
			}
			if !titles["Topic A"] || !titles["Topic B"] {
				t.Fatalf("want Topic A and Topic B, got %v", titles)
			}
		})
	}
}

// TestLLMAINewsletterBareArrayIsHighlightsOnly: this step's wrapper carries TWO
// fields (summary, highlights), so a bare array can't auto-map onto it the way
// the other two steps do — it is a deliberate decision, not a generic decode.
// Resolution: the array IS the highlights list, with no summary, because
// "summary" is a plain string[] with no kind/title/body — an array of
// {kind,title,body} objects only ever schema-matches "highlights", and this is
// the exact shape skip_summary pipelines already choose on purpose.
func TestLLMAINewsletterBareArrayIsHighlightsOnly(t *testing.T) {
	const wrapper = `{"summary":["**foo** bar"],"highlights":[{"kind":"tool","title":"ToolX","body":["*Who* x","*What* y"]}]}`
	const bare = `[{"kind":"tool","title":"ToolX","body":["*Who* x","*What* y"]}]`

	cases := []struct {
		name      string
		reply     string
		wantErr   bool
		wantCount int
	}{
		{"wrapper object: summary + highlight", wrapper, false, 2},
		{"bare array: highlights only, no summary", bare, false, 1},
		{"fenced wrapper object", "```json\n" + wrapper + "\n```", false, 2},
		{"fenced bare array", "```json\n" + bare + "\n```", false, 1},
		{"genuine garbage", "not json at all", true, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, q, run := setupRun(t)
			_, err := handleLLMAINewsletter(ctx, q, run, json.RawMessage(`{}`), stubRouter(t, c.reply))
			if c.wantErr {
				if err == nil {
					t.Fatal("want error for unparseable reply, got nil")
				}
				if !strings.Contains(err.Error(), "llm_ai_newsletter: parse llm json:") || !strings.Contains(err.Error(), c.reply) {
					t.Fatalf("error must name the step and carry the raw reply, got: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("llm_ai_newsletter: %v", err)
			}
			hs, err := q.ListHighlightsByPipelineRun(ctx, run.ID)
			if err != nil {
				t.Fatalf("list highlights: %v", err)
			}
			if len(hs) != c.wantCount {
				t.Fatalf("want %d highlights, got %d: %+v", c.wantCount, len(hs), hs)
			}
			var sawTool, sawSummary bool
			for _, h := range hs {
				switch h.Kind {
				case "tool":
					sawTool = true
					if h.Title != "ToolX" {
						t.Fatalf("tool title = %q, want ToolX", h.Title)
					}
					if !strings.Contains(h.Body, "Who") || !strings.Contains(h.Body, "What") {
						t.Fatalf("tool body lost its bullets: %q", h.Body)
					}
				case "summary":
					sawSummary = true
				}
			}
			if !sawTool {
				t.Fatal("want a tool highlight in every non-error case")
			}
			if c.wantCount == 1 && sawSummary {
				t.Fatal("bare array must not produce a summary highlight")
			}
			if c.wantCount == 2 && !sawSummary {
				t.Fatal("wrapper object must still produce its summary highlight")
			}
		})
	}
}
