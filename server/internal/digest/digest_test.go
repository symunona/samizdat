package digest

import (
	"errors"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/store"
)

func TestNextRun(t *testing.T) {
	loc := time.FixedZone("test", 2*3600)
	at := func(s string) time.Time {
		t.Helper()
		v, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	daily := Digest{Period: PeriodDaily, Hour: 7}
	// 2026-09-29 is a Tuesday, 2026-10-02 a Friday.
	tueFri := Digest{Period: PeriodWeekly, Weekdays: []int{2, 5}, Hour: 7}

	for _, tc := range []struct {
		name        string
		d           Digest
		after, want string
	}{
		{"daily, before the hour", daily, "2026-10-01 06:59", "2026-10-01 07:00"},
		{"daily, on the hour is not after it", daily, "2026-10-01 07:00", "2026-10-02 07:00"},
		{"daily, across a month end", daily, "2026-09-30 12:00", "2026-10-01 07:00"},
		{"weekly, Tue run done, Fri is next", tueFri, "2026-09-29 07:00", "2026-10-02 07:00"},
		{"weekly, Fri run done, crosses the week to Tue", tueFri, "2026-10-02 07:00", "2026-10-06 07:00"},
		{"weekly, Fri before the hour", tueFri, "2026-10-02 06:00", "2026-10-02 07:00"},
		{"weekly, between days", tueFri, "2026-10-03 23:00", "2026-10-06 07:00"},
		{"weekly, its only day already ran", Digest{Period: PeriodWeekly, Weekdays: []int{5}, Hour: 7}, "2026-10-02 08:00", "2026-10-09 07:00"},
	} {
		if got := tc.d.NextRun(at(tc.after)); !got.Equal(at(tc.want)) {
			t.Errorf("%s: NextRun(%s) = %s, want %s", tc.name, tc.after, got.Format("2006-01-02 15:04"), tc.want)
		}
	}
}

func TestNormalize(t *testing.T) {
	ok := Digest{Name: " AI ", Period: PeriodWeekly, Weekdays: []int{5, 2, 5}, Hour: 7,
		Questions: []Question{{Title: "Tools", Prompt: "which?", Enabled: true}}}
	if err := ok.Normalize(); err != nil {
		t.Fatal(err)
	}
	if ok.Name != "AI" || len(ok.Weekdays) != 2 || ok.Weekdays[0] != 2 {
		t.Fatalf("name/weekdays not normalized: %q %v", ok.Name, ok.Weekdays)
	}
	if q := ok.Questions[0]; q.ID == "" || q.TopN != defaultTopN {
		t.Fatalf("question defaults not filled: %+v", q)
	}
	if ok.SourceFeedIDs == nil {
		t.Fatal("source_feed_ids left nil: it would serialize as null")
	}

	asked := []Question{{Title: "Tools", Prompt: "which?", Enabled: true}}
	for _, color := range append([]string{""}, Colors...) {
		d := Digest{Name: "x", Period: PeriodDaily, Color: color, Questions: asked}
		if err := d.Normalize(); err != nil {
			t.Errorf("color %q refused: %v", color, err)
		}
	}

	for name, bad := range map[string]Digest{
		"no name":             {Period: PeriodDaily},
		"monthly":             {Name: "x", Period: "monthly"},
		"weekly without days": {Name: "x", Period: PeriodWeekly},
		"weekday 7":           {Name: "x", Period: PeriodWeekly, Weekdays: []int{7}},
		"hour 24":             {Name: "x", Period: PeriodDaily, Hour: 24},
		"a hex color":         {Name: "x", Period: PeriodDaily, Color: "#ff0000", Questions: asked},
		"an unknown color":    {Name: "x", Period: PeriodDaily, Color: "teal", Questions: asked},
		"question no prompt":  {Name: "x", Period: PeriodDaily, Questions: []Question{{Title: "t", Enabled: true}}},
		"no question":         {Name: "x", Period: PeriodDaily},
		"no enabled question": {Name: "x", Period: PeriodDaily, Questions: []Question{{Title: "t", Prompt: "p"}}},
	} {
		if err := bad.Normalize(); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}

func TestNextColor(t *testing.T) {
	for _, tc := range []struct {
		name string
		used []string
		want string
	}{
		{"the first Digest", nil, "red"},
		{"skips what others use", []string{"red", "orange"}, "yellow"},
		{"takes a gap before the tail", []string{"red", "yellow", "pink"}, "orange"},
		{"rows older than the column use nothing", []string{"", ""}, "red"},
		{"a full palette starts over", Colors, "red"},
		{"a full palette, then the least used", append(append([]string{"red"}, Colors...), "orange"), "yellow"},
	} {
		if got := NextColor(tc.used); got != tc.want {
			t.Errorf("%s: NextColor(%v) = %q, want %q", tc.name, tc.used, got, tc.want)
		}
	}
}

// The app keeps its own copy of the palette (it owns the hex of each name). A
// colour only one side knows is a save the server refuses or a chip the app
// paints grey, so the two lists are compared here, in order.
func TestColorsMatchAppPalette(t *testing.T) {
	src, err := os.ReadFile("../../../app/src/tagColor.ts")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?s)export const PALETTE = \[(.*?)\]`).FindSubmatch(src)
	if m == nil {
		t.Fatal("app/src/tagColor.ts no longer declares `export const PALETTE = [...]`")
	}
	var app []string
	for _, name := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(m[1], -1) {
		app = append(app, string(name[1]))
	}
	if !slices.Equal(app, Colors) {
		t.Fatalf("palettes drifted:\n  app/src/tagColor.ts PALETTE = %v\n  digest.Colors               = %v", app, Colors)
	}
}

func TestBulletText(t *testing.T) {
	body := "![](/api/v1/media/x)\n\n- **Qwen** ships 4B\n* second\n3. third"
	for bullet, want := range map[int]string{
		2:  "**Qwen** ships 4B",
		3:  "second",
		4:  "third",
		-1: body,
		99: body, // the body lost that line since the issue was written
	} {
		if got := BulletText(body, bullet); got != want {
			t.Errorf("BulletText(%d) = %q, want %q", bullet, got, want)
		}
	}
}

// A Highlight whose bullets are the fields of one thing is ONE candidate, cited
// whole; a list of several things still gives one candidate per bullet, and a
// bullet ref into it resolves to that bullet's stored text.
func TestBuildCandidatesKeepsFieldListsWhole(t *testing.T) {
	long := strings.Repeat("very long what ", 30)
	rows := []store.ListDigestCandidatesRow{
		{ID: "tool", FeedTitle: "Latent", Title: "Halo", Body: "- *Who*: **Halo** team\n" +
			"- *What*: post-training/RL framework; 2.8x over TRL\n- *When/Where*: Available now\n" +
			"- *Why*: RL iteration was throughput-bound\n- *How*: plug in a Hugging Face model"},
		{ID: "bold", FeedTitle: "Nate", Title: "Qwen", Body: "- **Who**: Alibaba\n- **What**: " + long + "\n- **Params**: 35B MoE"},
		{ID: "sum", FeedTitle: "Thorsten", Title: "Week", Body: "- **Zed** ships an agent panel\n- **Why** it matters: cheaper tokens\n- hiring news"},
	}
	cands := buildCandidates(rows, "", false)
	keys := make([]string, len(cands))
	for i, c := range cands {
		keys[i] = c.key
	}
	if want := []string{"1", "2", "3.0", "3.1", "3.2"}; !slices.Equal(keys, want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}

	tool := cands[0]
	if tool.ref != (Ref{HighlightID: "tool", Bullet: -1}) {
		t.Errorf("field list ref = %+v, want the whole Highlight", tool.ref)
	}
	if want := "[1] Latent · Halo — What: post-training/RL framework; 2.8x over TRL Why: RL iteration was throughput-bound"; tool.line != want {
		t.Errorf("field list line =\n  %q\nwant\n  %q", tool.line, want)
	}
	// What alone is clipped: one Highlight cannot eat the budget.
	if bold := cands[1].line; utf8.RuneCountInString(bold) > len("[2] Nate · Qwen — What: ")+fieldRunes || !strings.HasSuffix(bold, "…") {
		t.Errorf("long field not clipped: %q", bold)
	}

	if got := BulletText(rows[2].Body, indexRefs(cands)["3.1"].Bullet); got != "**Why** it matters: cheaper tokens" {
		t.Errorf("bullet ref 3.1 resolves to %q", got)
	}
}

// A Digest pinned to the provider a role names gets that role's window whatever
// model it picks: Opus on `anthropic` was clamped to the 7k local window because
// `big` named Haiku. Anything else is sized like map.
func TestWindowMatchesOnProvider(t *testing.T) {
	lim := config.SummarizeLimits{
		Map:    config.SummarizeRole{CtxTokens: 7168},
		Reduce: config.SummarizeRole{Provider: "box:11434", CtxTokens: 12000, MaxTokens: 1024},
		Big:    config.SummarizeRole{Provider: "anthropic", Model: "claude-haiku-4-5", CtxTokens: 200000},
	}
	modelOnly := lim
	modelOnly.Big = config.SummarizeRole{Model: "claude-opus-4-8", CtxTokens: 200000}

	for _, tc := range []struct {
		name string
		lim  config.SummarizeLimits
		d    Digest
		want int
	}{
		{"big's provider, another model", lim, Digest{Provider: "anthropic", Model: "claude-opus-4-8"}, 200000},
		{"big's provider and model", lim, Digest{Provider: "anthropic", Model: "claude-haiku-4-5"}, 200000},
		{"big's provider, default model", lim, Digest{Provider: "anthropic"}, 200000},
		{"reduce's provider", lim, Digest{Provider: "box:11434", Model: "qwen3:4b"}, 12000},
		{"unpinned", lim, Digest{}, 7168},
		{"a provider no role names", lim, Digest{Provider: "openrouter", Model: "claude-haiku-4-5"}, 7168},
		{"a role naming only a model routes nothing", modelOnly, Digest{Provider: "anthropic", Model: "claude-opus-4-8"}, 7168},
	} {
		ctx, reply := window(tc.lim, tc.d)
		if ctx != tc.want || reply != 1024 {
			t.Errorf("%s: window = %d / %d, want %d / 1024", tc.name, ctx, reply, tc.want)
		}
	}
}

// The model is handed numbers and writes a title and a why — nothing else it
// returns survives. A ref that was never sent is dropped, and a topic left with
// no ref goes with it.
func TestParseTopicsDropsWhatDoesNotResolve(t *testing.T) {
	sent := []candidate{
		{key: "1.0", ref: Ref{HighlightID: "h1", Bullet: 0}},
		{key: "1.1", ref: Ref{HighlightID: "h1", Bullet: 1}},
		{key: "2", ref: Ref{HighlightID: "h2", Bullet: -1}},
	}
	q := Question{ID: "q", Title: "Tools", TopN: 5}
	reply := "```json\n" + `{"topics":[
		{"title":"Real","why":"w","refs":["1.1","[2]","9.9","1.1"]},
		{"title":"Invented","why":"w","refs":["42","7.3"]},
		{"title":"No refs","why":"w"},
		{"title":"  ","why":"w","refs":["2"]},
		{"title":"Numeric and bare","why":"w","refs":[1.0, 1]}
	]}` + "\n```"

	topics, dropped, trimmed, err := parseTopics(reply, q, indexRefs(sent))
	if err != nil {
		t.Fatal(err)
	}
	if trimmed != 0 {
		t.Errorf("trimmed = %d, want 0 under the cap", trimmed)
	}
	if dropped != 2 {
		t.Errorf("dropped = %d, want 2 (Invented, No refs)", dropped)
	}
	if len(topics) != 2 {
		t.Fatalf("topics = %+v, want 2", topics)
	}
	real := topics[0]
	if real.Title != "Real" || real.Rank != 1 || real.QuestionID != "q" || real.QuestionTitle != "Tools" {
		t.Errorf("first topic = %+v", real)
	}
	if len(real.Refs) != 2 || real.Refs[0] != (Ref{HighlightID: "h1", Bullet: 1}) || real.Refs[1] != (Ref{HighlightID: "h2", Bullet: -1}) {
		t.Errorf("refs = %+v, want [h1#1 h2#-1] (unknown dropped, repeat folded)", real.Refs)
	}
	// 1.0 is a listed bullet; a bare 1 is all of Highlight 1, which the model saw.
	if got := topics[1].Refs; topics[1].Rank != 2 || len(got) != 2 || got[0].Bullet != 0 || got[1].Bullet != -1 {
		t.Errorf("second topic = %+v", topics[1])
	}

	// A bare array, the shape a small model returns when it drops the wrapper.
	bare, _, _, err := parseTopics(`[{"title":"A","refs":["2"]},{"title":"B","refs":["2"]}]`, Question{TopN: 1}, indexRefs(sent))
	if err != nil || len(bare) != 1 {
		t.Fatalf("bare array: %v %+v, want 1 topic (top_n)", err, bare)
	}
	if _, _, _, err := parseTopics("no json here", q, indexRefs(sent)); err == nil {
		t.Error("an unparseable reply must fail the question, not read as no topics")
	}
}

// A topic citing more than maxTopicRefs keeps one ref per newsletter first, then
// fills up in the model's order — so trimming never costs the cross-newsletter
// proof — and the cut is counted.
func TestParseTopicsCapsRefsSpreadAcrossFeeds(t *testing.T) {
	var sent []candidate
	var refs []string
	// Ten bullets from Feed a first, then one each from b and c: a plain
	// first-seven cut would keep only Feed a.
	for i := range 10 {
		sent = append(sent, candidate{key: "1." + strconv.Itoa(i), ref: Ref{HighlightID: "ha", Bullet: i}, feed: "a"})
	}
	sent = append(sent,
		candidate{key: "2", ref: Ref{HighlightID: "hb", Bullet: -1}, feed: "b"},
		candidate{key: "3", ref: Ref{HighlightID: "hc", Bullet: -1}, feed: "c"})
	for _, c := range sent {
		refs = append(refs, `"`+c.key+`"`)
	}
	reply := `{"topics":[{"title":"Big","why":"w","refs":[` + strings.Join(refs, ",") + `]},{"title":"Small","why":"w","refs":["2","3"]}]}`

	topics, _, trimmed, err := parseTopics(reply, Question{ID: "q", TopN: 5}, indexRefs(sent))
	if err != nil {
		t.Fatal(err)
	}
	if trimmed != 12-maxTopicRefs {
		t.Errorf("trimmed = %d, want %d", trimmed, 12-maxTopicRefs)
	}
	var got []string
	for _, r := range topics[0].Refs {
		got = append(got, r.HighlightID+"#"+strconv.Itoa(r.Bullet))
	}
	want := []string{"ha#0", "ha#1", "ha#2", "ha#3", "ha#4", "hb#-1", "hc#-1"}
	if !slices.Equal(got, want) {
		t.Errorf("kept refs = %v, want %v (every Feed first, then the model's order)", got, want)
	}
	if len(topics[1].Refs) != 2 {
		t.Errorf("a topic under the cap lost refs: %+v", topics[1].Refs)
	}
}
