package digest

import (
	"strings"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/store"
)

const day24 = 24 * time.Hour

var historyQuestion = []Question{{
	ID: "frontier", Title: "Frontier releases", Prompt: "Which frontier models shipped?", TopN: 5, Enabled: true, History: true,
}}

// isDiffCall tells a History question's second pass from its first.
func isDiffCall(prompt string) bool { return strings.Contains(prompt, "EARLIER ITEMS:") }

// frontierBox answers the first pass with one topic citing the Opus 5.5 line, and
// the second pass with diff(prompt).
func frontierBox(t *testing.T, diff func(prompt string) string) *box {
	t.Helper()
	b := &box{}
	b.reply = func(p string) string {
		if isDiffCall(p) {
			return diff(p)
		}
		return `{"topics":[{"title":"Claude Opus 5.5","why":"shipped this week","refs":["` + refOf(t, p, "30% faster") + `"]}]}`
	}
	return b
}

func (f *fixture) seedOpus() {
	f.t.Helper()
	f.feed("a", "https://a.example/rss")
	f.feed("b", "https://b.example/rss")
	f.feed("c", "https://c.example/rss")
	f.titledHighlight("new", "a", "Claude Opus 5.5", "- *What*: Fable-level reasoning, 30% faster decode\n- *Why*: Opus pricing", time.Hour)
	f.titledHighlight("old", "b", "Claude Opus 5", "- *What*: sits between Opus 4.8 and Fable 5\n- *Why*: matches Fable 5 on SWE", 60*day24)
	f.titledHighlight("tool", "a", "Zed agent panel", "an editor, not a model", 30*day24)
	f.titledHighlight("outside", "c", "Claude Opus 4.8", "from a newsletter the digest does not read", 90*day24)
}

func (f *fixture) runHistory(b *box) Issue {
	f.t.Helper()
	row := f.digest(Digest{Name: "AI", Period: PeriodWeekly, Weekdays: []int{2}, Hour: 7,
		SourceFeedIDs: []string{"a", "b"}, Questions: historyQuestion})
	r := Runner{Q: f.q, Router: localRouter(b.serve(f.t), config.SummarizeSection{}), Registry: extractor.Registry{}}
	if status, err := r.Run(f.ctx, row.ID, "issue-1", f.now); err != nil || status != StatusDone {
		f.t.Fatalf("Run = %q, %v", status, err)
	}
	is := f.issue("issue-1")
	if err := is.Resolve(f.ctx, f.q); err != nil {
		f.t.Fatal(err)
	}
	return is
}

// The plan's self-test: the window holds the new release, the Highlight on the
// one before it is two months old. The second pass is shown it, dated, and the
// topic ends up carrying the diff and the stored earlier text it rests on.
func TestHistoryQuestionDiffsAgainstEarlierHighlights(t *testing.T) {
	f := newFixture(t)
	f.seedOpus()
	b := frontierBox(t, func(p string) string {
		// One earlier ref that was sent, one that never was.
		return `{"diffs":[{"previous":"Claude Opus 5","diff":"Now Fable-level and 30% faster.","refs":["` +
			refOf(t, p, "between Opus 4.8") + `","h9"]}]}`
	})
	is := f.runHistory(b)

	if len(b.prompts) != 2 || !isDiffCall(b.prompts[1]) {
		t.Fatalf("calls = %d, want the question and one diff", len(b.prompts))
	}
	if isDiffCall(b.prompts[0]) || strings.Contains(b.prompts[0], "between Opus 4.8") {
		t.Fatalf("history reached the first pass:\n%s", b.prompts[0])
	}
	p := b.prompts[1]
	wantOld := "[h1] " + f.stamp(-60 * day24)[:10] + " · Feed b · Claude Opus 5 — What: sits between Opus 4.8 and Fable 5"
	if !strings.Contains(p, wantOld) {
		t.Errorf("diff prompt lacks the dated earlier line %q:\n%s", wantOld, p)
	}
	if !strings.Contains(p, "RELEASE: Claude Opus 5.5") || !strings.Contains(p, "NEW ITEMS:\n[1] Feed a · Claude Opus 5.5 — What: Fable-level") {
		t.Errorf("diff prompt lacks the release or its own lines:\n%s", p)
	}
	if strings.Contains(p, "Zed") || strings.Contains(p, "does not read") {
		t.Errorf("an unrelated or out-of-scope Highlight reached the diff prompt:\n%s", p)
	}

	if len(is.Topics) != 1 {
		t.Fatalf("topics = %+v", is.Topics)
	}
	topic := is.Topics[0]
	if topic.Previous != "Claude Opus 5" || topic.Diff != "Now Fable-level and 30% faster." {
		t.Errorf("previous/diff = %q / %q", topic.Previous, topic.Diff)
	}
	if len(topic.Refs) != 2 {
		t.Fatalf("refs = %+v, want the new one and the earlier one", topic.Refs)
	}
	if fresh := topic.Refs[0]; fresh.HighlightID != "new" || fresh.History {
		t.Errorf("first ref = %+v", fresh)
	}
	if old := topic.Refs[1]; old.HighlightID != "old" || !old.History || old.Date != f.stamp(-60 * day24)[:10] || old.FeedTitle != "Feed b" {
		t.Errorf("earlier ref = %+v", old)
	}
	meta := is.Metadata.Questions[0]
	if meta.Diffs != 1 || meta.DroppedDiffs != 0 || meta.Calls != 2 || meta.TokensIn != 22 {
		t.Errorf("metadata = %+v, want one diff over two calls with their tokens summed", meta)
	}
}

// A diff citing no earlier ref that resolves is the model writing facts nobody
// can check: it is dropped and counted, and the topic stays as the first pass
// wrote it. "No previous release" is an answer, not a drop.
func TestDiffWithoutAnEarlierRefIsDropped(t *testing.T) {
	for name, tc := range map[string]struct {
		reply   string
		dropped int
	}{
		"invented":    {`{"diffs":[{"previous":"Claude Opus 5","diff":"Twice the context.","refs":["h9"]}]}`, 1},
		"other tier":  {`{"diffs":[{"previous":"Claude Sonnet 5","diff":"Faster.","refs":["h1"]}]}`, 1},
		"unnamed":     {`{"diffs":[{"previous":"Opus 4.5","diff":"Faster.","refs":["h1"]}]}`, 1},
		"itself":      {`{"diffs":[{"previous":"claude opus 5.5","diff":"Faster.","refs":["h1"]}]}`, 1},
		"no previous": {`{"diffs":[{"previous":"","diff":"Faster.","refs":["h1"]}]}`, 1},
		"none":        {`{"diffs":[]}`, 0},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.seedOpus()
			is := f.runHistory(frontierBox(t, func(string) string { return tc.reply }))
			topic := is.Topics[0]
			if topic.Previous != "" || topic.Diff != "" || len(topic.Refs) != 1 {
				t.Errorf("topic = %+v, want it untouched", topic)
			}
			if meta := is.Metadata.Questions[0]; meta.Diffs != 0 || meta.DroppedDiffs != tc.dropped {
				t.Errorf("diffs/dropped = %d/%d, want 0/%d", meta.Diffs, meta.DroppedDiffs, tc.dropped)
			}
		})
	}
}

// No earlier Highlight shares a title word with the topic: nothing to compare
// against, so no second call is paid for.
func TestNoMatchingHistoryMakesNoDiffCall(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	f.titledHighlight("new", "a", "Claude Opus 5.5", "30% faster decode", time.Hour)
	f.titledHighlight("tool", "a", "Zed agent panel", "an editor", 30*day24)
	b := frontierBox(t, func(string) string {
		t.Error("a diff call was made with no history to compare")
		return `{"diffs":[]}`
	})
	if is := f.runHistory(b); len(b.prompts) != 1 || is.Metadata.Questions[0].Calls != 0 {
		t.Errorf("calls = %d, metadata = %+v", len(b.prompts), is.Metadata.Questions[0])
	}
}

func TestPickHistoryRanksBySharedTitleWords(t *testing.T) {
	titles := []string{ // newest first, as ListDigestCandidates returns them
		"GPT-6 Sol & Luna",
		"⭐ Kimi K3 ~ Opus 4.8",
		"Claude Opus 5",
		"New model release",
		"GPT-5.6 Sol / Terra / Luna",
		"Zed agent panel",
	}
	rows := make([]store.ListDigestCandidatesRow, len(titles))
	for i, title := range titles {
		rows[i].Title = title
	}
	for topic, want := range map[string][]string{
		"Claude Opus 5.5":      {"Claude Opus 5", "⭐ Kimi K3 ~ Opus 4.8"},
		"GPT-6.1 Sol":          {"GPT-6 Sol & Luna", "GPT-5.6 Sol / Terra / Luna"},
		"A new model released": nil,
		"Qwen3.8-27B":          nil,
	} {
		var got []string
		for _, h := range pickHistory(topic, rows) {
			got = append(got, h.Title)
		}
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("pickHistory(%q) = %q, want %q", topic, got, want)
		}
	}

	many := make([]store.ListDigestCandidatesRow, maxHistory+5)
	for i := range many {
		many[i].Title = "Claude note"
	}
	if got := len(pickHistory("Claude Opus 5.5", many)); got != maxHistory {
		t.Errorf("picked %d, want the cap of %d", got, maxHistory)
	}
}

func TestSameLine(t *testing.T) {
	for _, tc := range []struct {
		title, previous string
		want            bool
	}{
		{"Claude Opus 5.5", "Claude Opus 5", true},
		{"Opus 5.5", "Claude Opus 5", true},
		{"GPT-6.1 Sol", "GPT-5.6 Sol / Terra / Luna", true},
		{"Gemini 4 Argon", "Gemini 4", true},
		{"Claude Sonnet 5.5", "Claude Opus 5", false},
		{"Claude Haiku 5.5", "Claude Opus 5.5", false},
		{"Claude Opus 5.5", "claude opus 5.5", false},
		{"Claude Opus 5.5", "5", false},
	} {
		if got := sameLine(tc.title, tc.previous); got != tc.want {
			t.Errorf("sameLine(%q, %q) = %v, want %v", tc.title, tc.previous, got, tc.want)
		}
	}
}
