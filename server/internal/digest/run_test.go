package digest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

// box is a stub OpenAI-compatible endpoint that records every prompt and answers
// each with reply(prompt).
type box struct {
	prompts []string
	reply   func(prompt string) string
}

func (b *box) serve(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		prompt := body.Messages[0].Content
		b.prompts = append(b.prompts, prompt)
		out, _ := json.Marshal(map[string]any{
			"model":   "stub-model",
			"choices": []any{map[string]any{"message": map[string]string{"content": b.reply(prompt)}}},
			"usage":   map[string]int{"prompt_tokens": 11, "completion_tokens": 5},
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv.URL + "/v1"
}

// refOf finds the bracketed ref of the prompt line containing needle.
func refOf(t *testing.T, prompt, needle string) string {
	t.Helper()
	for _, line := range strings.Split(prompt, "\n") {
		if strings.Contains(line, needle) && strings.HasPrefix(line, "[") {
			return line[1:strings.Index(line, "]")]
		}
	}
	t.Fatalf("no item line containing %q in prompt:\n%s", needle, prompt)
	return ""
}

type fixture struct {
	t   *testing.T
	ctx context.Context
	db  *sql.DB
	q   *store.Queries
	now time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	// Discovery reads the environment; a key exported on this box must not add a
	// cloud provider to a test's chain.
	for _, k := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"} {
		t.Setenv(k, "")
	}
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	f := &fixture{t: t, ctx: t.Context(), db: db, q: store.New(db), now: time.Date(2026, 10, 2, 7, 0, 0, 0, time.UTC)}
	stamp := f.stamp(0)
	if _, err := f.q.InsertPipeline(f.ctx, store.InsertPipelineParams{
		ID: "pipe", Name: "p", Enabled: 1, Trigger: "manual", Filter: "{}", Steps: "[]", CreatedAt: stamp, UpdatedAt: stamp,
	}); err != nil {
		t.Fatal(err)
	}
	return f
}

// stamp is the fixture's now moved by d, as stored.
func (f *fixture) stamp(d time.Duration) string { return f.now.Add(d).Format(time.RFC3339) }

func (f *fixture) feed(id, url string) { f.titledFeed(id, url, "Feed "+id) }

func (f *fixture) titledFeed(id, url, title string) {
	f.t.Helper()
	if _, err := f.q.UpsertFeed(f.ctx, store.UpsertFeedParams{
		ID: id, Url: url, Kind: "rss", Title: title, Config: "{}", CreatedAt: f.stamp(0), UpdatedAt: f.stamp(0),
	}); err != nil {
		f.t.Fatal(err)
	}
}

// highlight adds one Highlight, on its own Document in feedID, created age ago.
func (f *fixture) highlight(id, feedID, body string, age time.Duration) {
	f.t.Helper()
	at := f.stamp(-age)
	if _, err := f.q.UpsertDocument(f.ctx, store.UpsertDocumentParams{
		ID: "doc-" + id, CanonicalUrl: "https://" + feedID + ".example/" + id, Title: "Issue " + id,
		FetchedAt: at, SourceFeedID: &feedID, MediaType: "article", CreatedAt: at, UpdatedAt: at,
	}); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.q.InsertPipelineRun(f.ctx, store.InsertPipelineRunParams{
		ID: "run-" + id, PipelineID: "pipe", DocumentID: "doc-" + id, CreatedAt: at, UpdatedAt: at,
	}); err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.q.InsertHighlight(f.ctx, store.InsertHighlightParams{
		ID: id, DocumentID: "doc-" + id, PipelineRunID: "run-" + id, Kind: "summary",
		Title: "Title " + id, Body: body, Metadata: "{}", CreatedAt: at, UpdatedAt: at,
	}); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) digest(d Digest) store.Digest {
	f.t.Helper()
	if err := d.Normalize(); err != nil {
		f.t.Fatal(err)
	}
	weekdays, feeds, questions := d.Lists()
	row, err := f.q.InsertDigest(f.ctx, store.InsertDigestParams{
		ID: "digest-1", Name: d.Name, Enabled: 1, Period: d.Period, Weekdays: weekdays, Hour: int64(d.Hour),
		SourceFeedIds: feeds, Questions: questions, Provider: d.Provider, Model: d.Model,
		NextRunAt: f.stamp(0), CreatedAt: f.stamp(0), UpdatedAt: f.stamp(0),
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return row
}

func (f *fixture) issue(id string) Issue {
	f.t.Helper()
	row, err := f.q.GetDigestIssue(f.ctx, id)
	if err != nil {
		f.t.Fatal(err)
	}
	return IssueFromRow(row)
}

func localRouter(baseURL string, sum config.SummarizeSection) *llm.Router {
	return llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: baseURL, DefaultModel: "stub-model", Summarize: sum,
	})
}

var oneQuestion = []Question{{ID: "tools", Title: "Cool tools", Prompt: "Which tools came out?", TopN: 5, Enabled: true}}

// The plan's self-test at the Runner: two newsletters word the same launch
// differently and a third, out of scope, carries something else. One topic, two
// bullets, nothing from the third — and every bullet is stored text.
func TestRunGroupsAcrossFeeds(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	f.feed("b", "https://b.example/rss")
	f.feed("c", "https://c.example/rss")
	f.highlight("ha", "a", "- **Zed** ships an agent panel\n- unrelated hiring news", time.Hour)
	f.highlight("hb", "b", "The Zed editor now has a built-in AI agent.", 2*time.Hour)
	f.highlight("hc", "c", "- cats\n- dogs", time.Hour)
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, SourceFeedIDs: []string{"a", "b"}, Questions: oneQuestion})

	b := &box{}
	b.reply = func(p string) string {
		// The model invents a fact in `why` and cites one ref nobody sent it.
		return `{"topics":[{"title":"Zed agent","why":"both cover it","refs":["` +
			refOf(t, p, "agent panel") + `","` + refOf(t, p, "built-in AI agent") + `","77.1"]}]}`
	}
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), config.SummarizeSection{}), Registry: extractor.Registry{}}

	ctx := pipeline.WithParentJobID(f.ctx, "job-1")
	status, err := r.Run(ctx, row.ID, "issue-1", f.now)
	if err != nil || status != StatusDone {
		t.Fatalf("Run = %q, %v", status, err)
	}
	if len(b.prompts) != 1 {
		t.Fatalf("calls = %d, want one per enabled question", len(b.prompts))
	}
	if p := b.prompts[0]; strings.Contains(p, "cats") || strings.Contains(p, "Feed c") {
		t.Fatalf("an out-of-scope Feed reached the prompt:\n%s", p)
	}
	if p := b.prompts[0]; !strings.Contains(p, "[1.0] Feed a · Title ha — **Zed** ships an agent panel") {
		t.Fatalf("candidates must be numbered lines, newest first:\n%s", p)
	}

	is := f.issue("issue-1")
	if err := is.Resolve(f.ctx, f.q); err != nil {
		t.Fatal(err)
	}
	if len(is.Topics) != 1 || len(is.Topics[0].Refs) != 2 {
		t.Fatalf("topics = %+v, want ONE topic with TWO refs", is.Topics)
	}
	first, second := is.Topics[0].Refs[0], is.Topics[0].Refs[1]
	if first.HighlightID != "ha" || first.Bullet != 0 || first.Text != "**Zed** ships an agent panel" || first.FeedTitle != "Feed a" {
		t.Errorf("first ref = %+v", first)
	}
	if second.HighlightID != "hb" || second.Bullet != -1 || second.DocumentID != "doc-hb" || second.DocumentTitle != "Issue hb" {
		t.Errorf("second ref = %+v", second)
	}

	meta := is.Metadata.Questions
	if len(meta) != 1 || meta[0].QuestionID != "tools" || meta[0].Model != "stub-model" || meta[0].TokensIn != 11 ||
		meta[0].PromptSHA == "" || meta[0].Truncated || meta[0].Candidates != 3 || meta[0].CandidatesSent != 3 {
		t.Errorf("metadata = %+v", meta)
	}

	// One ledger row, on the job and on no PipelineRun.
	var jobID, runID *string
	if err := f.db.QueryRow(`SELECT job_id, pipeline_run_id FROM llm_usages`).Scan(&jobID, &runID); err != nil {
		t.Fatalf("ledger: %v", err)
	}
	if jobID == nil || *jobID != "job-1" || runID != nil {
		t.Errorf("ledger row job_id=%v pipeline_run_id=%v, want job-1 / nil", jobID, runID)
	}
}

// Most Feeds never get a title. Their host names them instead — in the prompt,
// so the model can tell newsletters apart, and on the resolved ref a reader sees.
func TestUntitledFeedIsNamedByItsHost(t *testing.T) {
	f := newFixture(t)
	f.titledFeed("a", "https://www.news.example:8443/rss", "")
	f.highlight("h", "a", "Zed ships an agent panel", time.Hour)
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Questions: oneQuestion})

	b := &box{reply: func(p string) string {
		return `{"topics":[{"title":"Zed","why":"w","refs":["` + refOf(t, p, "agent panel") + `"]}]}`
	}}
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), config.SummarizeSection{}), Registry: extractor.Registry{}}
	if status, err := r.Run(f.ctx, row.ID, "issue-1", f.now); err != nil || status != StatusDone {
		t.Fatalf("Run = %q, %v", status, err)
	}
	if want := "[1] news.example · Title h — Zed ships an agent panel"; !strings.Contains(b.prompts[0], want) {
		t.Errorf("prompt lacks %q:\n%s", want, b.prompts[0])
	}
	is := f.issue("issue-1")
	if err := is.Resolve(f.ctx, f.q); err != nil {
		t.Fatal(err)
	}
	if got := is.Topics[0].Refs[0].FeedTitle; got != "news.example" {
		t.Errorf("resolved feed_title = %q, want the host", got)
	}
}

// The window is "since the last issue": it starts at last_run_at whatever the
// period says, and a run that wrote an issue moves last_run_at to its end.
func TestWindowStartsAtLastRun(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	f.highlight("old", "a", "before the last issue", 80*time.Hour)
	f.highlight("gap", "a", "after it, but more than a day ago", 60*time.Hour)
	f.highlight("new", "a", "this morning", time.Hour)
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Questions: oneQuestion})
	last := f.stamp(-72 * time.Hour)
	if err := f.q.MarkDigestRun(f.ctx, store.MarkDigestRunParams{LastRunAt: &last, UpdatedAt: last, ID: row.ID}); err != nil {
		t.Fatal(err)
	}

	b := &box{reply: func(string) string { return `{"topics":[]}` }}
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), config.SummarizeSection{}), Registry: extractor.Registry{}}
	if _, err := r.Run(f.ctx, row.ID, "issue-1", f.now); err != nil {
		t.Fatal(err)
	}

	is := f.issue("issue-1")
	if is.WindowStart != last || is.WindowEnd != f.stamp(0) {
		t.Fatalf("window = %s..%s, want %s..%s", is.WindowStart, is.WindowEnd, last, f.stamp(0))
	}
	p := b.prompts[0]
	if strings.Contains(p, "before the last issue") {
		t.Error("a Highlight from before last_run_at was sent")
	}
	if !strings.Contains(p, "more than a day ago") || !strings.Contains(p, "this morning") {
		t.Errorf("the gap since the last issue was not covered:\n%s", p)
	}
	after, _ := f.q.GetDigest(f.ctx, row.ID)
	if after.LastRunAt == nil || *after.LastRunAt != f.stamp(0) {
		t.Errorf("last_run_at = %v, want the issue's window_end", after.LastRunAt)
	}

	// A first run has no last issue: one period back.
	if got := (Digest{Period: PeriodWeekly}).WindowStart(f.now); !got.Equal(f.now.AddDate(0, 0, -7)) {
		t.Errorf("first weekly window starts %s", got)
	}
}

// Hold archives a Feed's Highlights as they are made, so a Digest that skipped
// archived rows would hold its own input out of every issue.
func TestHeldHighlightIsStillACandidate(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	f.highlight("held", "a", "held out of the feed", time.Hour)
	f.highlight("open", "a", "still in the feed", 2*time.Hour)
	if n, err := f.q.ArchiveHighlightsByPipelineRun(f.ctx, store.ArchiveHighlightsByPipelineRunParams{
		ArchivedAt: new(f.stamp(0)), UpdatedAt: f.stamp(0), PipelineRunID: "run-held",
	}); err != nil || n != 1 {
		t.Fatalf("archived %d rows, %v; want 1", n, err)
	}
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Questions: oneQuestion})

	b := &box{reply: func(p string) string {
		return `{"topics":[{"title":"T","why":"w","refs":["` + refOf(t, p, "held out") + `"]}]}`
	}}
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), config.SummarizeSection{}), Registry: extractor.Registry{}}
	if status, err := r.Run(f.ctx, row.ID, "issue-1", f.now); err != nil || status != StatusDone {
		t.Fatalf("run = %q, %v", status, err)
	}
	if is := f.issue("issue-1"); len(is.Topics) != 1 || is.Topics[0].Refs[0].HighlightID != "held" {
		t.Errorf("topics = %+v, want one pointing at the held Highlight", is.Topics)
	}
}

// A failed run writes a failed issue saying why, and leaves last_run_at alone so
// the next run covers the same Highlights. The retry reopens the same issue.
func TestFailedRunKeepsTheWindow(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	f.highlight("h", "a", "something", time.Hour)
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Questions: oneQuestion})

	b := &box{reply: func(string) string { return "I could not decide." }}
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), config.SummarizeSection{}), Registry: extractor.Registry{}}
	status, err := r.Run(f.ctx, row.ID, "issue-1", f.now)
	if err == nil || status != StatusFailed {
		t.Fatalf("Run = %q, %v; want a failure", status, err)
	}
	if is := f.issue("issue-1"); is.Status != StatusFailed || is.Metadata.Error == "" || len(is.Topics) != 0 {
		t.Fatalf("issue = %+v", is)
	}
	if after, _ := f.q.GetDigest(f.ctx, row.ID); after.LastRunAt != nil {
		t.Fatalf("last_run_at moved to %s on a failed run", *after.LastRunAt)
	}

	b.reply = func(p string) string { return `[{"title":"T","why":"w","refs":["` + refOf(t, p, "something") + `"]}]` }
	if status, err := r.Run(f.ctx, row.ID, "issue-1", f.now.Add(time.Minute)); err != nil || status != StatusDone {
		t.Fatalf("retry = %q, %v", status, err)
	}
	issues, _ := f.q.ListDigestIssuesByDigest(f.ctx, store.ListDigestIssuesByDigestParams{DigestID: row.ID, Limit: 10})
	if len(issues) != 1 || issues[0].Status != StatusDone {
		t.Fatalf("issues after retry = %+v, want the one row reopened", issues)
	}
}

// Nothing in the window: an empty issue, no call, and the window still moves.
func TestEmptyWindowMakesNoCall(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Questions: oneQuestion})
	b := &box{reply: func(string) string { return "{}" }}
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), config.SummarizeSection{}), Registry: extractor.Registry{}}

	status, err := r.Run(f.ctx, row.ID, "issue-1", f.now)
	if err != nil || status != StatusEmpty || len(b.prompts) != 0 {
		t.Fatalf("Run = %q, %v, %d calls; want empty and no call", status, err, len(b.prompts))
	}
	if after, _ := f.q.GetDigest(f.ctx, row.ID); after.LastRunAt == nil {
		t.Error("an empty issue did not move last_run_at")
	}
}

// Over budget: the newest items are kept, the oldest dropped, and the issue says
// so. Never silent.
func TestOverBudgetClampsAndMarksTruncated(t *testing.T) {
	f := newFixture(t)
	f.feed("a", "https://a.example/rss")
	filler := strings.Repeat("lorem ipsum ", 40)
	f.highlight("newest", "a", "NEWEST "+filler, 1*time.Hour)
	f.highlight("middle", "a", "MIDDLE "+filler, 2*time.Hour)
	f.highlight("oldest", "a", "OLDEST "+filler, 3*time.Hour)
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Questions: oneQuestion})

	b := &box{reply: func(p string) string {
		return `{"topics":[{"title":"T","why":"w","refs":["` + refOf(t, p, "NEWEST") + `","3"]}]}`
	}}
	sum := config.DefaultSummarize()

	// A window that cannot hold the prompt at all fails; it does not send everything.
	sum.Map.CtxTokens = 100
	r := Runner{Q: f.q, Router: localRouter(b.serve(t), sum), Registry: extractor.Registry{}}
	if _, err := r.Run(f.ctx, row.ID, "issue-0", f.now); err == nil || len(b.prompts) != 0 {
		t.Fatalf("a context too small for the prompt must fail the run before any call (err %v, %d calls)", err, len(b.prompts))
	}

	// Room for the prompt and about two of the three ~500-rune items.
	head := pipeline.EstimateTokens(promptHead(oneQuestion[0], nil))
	sum.Map.CtxTokens = (head + sum.Reduce.MaxTokens + 400) * 3 / 2
	r.Router = localRouter(b.serve(t), sum)
	if _, err := r.Run(f.ctx, row.ID, "issue-1", f.now); err != nil {
		t.Fatal(err)
	}

	p := b.prompts[0]
	if !strings.Contains(p, "NEWEST") || !strings.Contains(p, "MIDDLE") || strings.Contains(p, "OLDEST") {
		t.Fatalf("clamp must keep newest first and drop the oldest:\n%s", p)
	}
	is := f.issue("issue-1")
	m := is.Metadata.Questions[0]
	if !m.Truncated || m.Candidates != 3 || m.CandidatesSent != 2 {
		t.Errorf("metadata = %+v, want truncated 2 of 3", m)
	}
	// "3" was cut before the call: citing it resolves to nothing.
	if len(is.Topics) != 1 || len(is.Topics[0].Refs) != 1 || is.Topics[0].Refs[0].HighlightID != "newest" {
		t.Errorf("topics = %+v", is.Topics)
	}
}

// Rule 5: a Feed scraped with a login may only be digested on a local provider.
// Refused at save (CheckRoute) and again at run, where nothing is sent.
func TestAuthFeedRefusesCloudRoute(t *testing.T) {
	f := newFixture(t)
	f.feed("open", "https://open.example/rss")
	f.feed("paid", "https://paid.example/rss")
	f.highlight("h", "paid", "subscriber-only text", time.Hour)
	reg := extractor.Registry{"paid.example": {Kind: "rss", Auth: &extractor.AuthConfig{LoginURL: "https://paid.example/login"}}}

	b := &box{reply: func(string) string { return `{"topics":[]}` }}
	local := b.serve(t)
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: local, DefaultModel: "stub-model",
		Fallback: []config.LLMSection{{Provider: "anthropic", APIKey: "sk-test"}},
	})
	localID := strings.TrimSuffix(strings.TrimPrefix(local, "http://"), "/v1")
	r := Runner{Q: f.q, Router: router, Registry: reg}

	for _, tc := range []struct {
		name     string
		provider string
		feeds    []string
		refused  bool
	}{
		{"pinned cloud", "anthropic", []string{"paid"}, true},
		{"unpinned chain with a cloud fallback", "", []string{"paid"}, true},
		{"every feed, pinned cloud", "anthropic", nil, true},
		{"pinned local", localID, []string{"paid"}, false},
		{"cloud, but the paid feed is out of scope", "anthropic", []string{"open"}, false},
	} {
		err := r.CheckRoute(f.ctx, Digest{Provider: tc.provider, SourceFeedIDs: tc.feeds})
		if got := errors.Is(err, ErrCloudRoute); got != tc.refused {
			t.Errorf("%s: err = %v, refused = %v, want %v", tc.name, err, got, tc.refused)
		}
	}

	// At run: the Feed gained its login after the Digest was saved.
	row := f.digest(Digest{Name: "AI", Period: PeriodDaily, Hour: 7, Provider: "anthropic", Questions: oneQuestion})
	status, err := r.Run(f.ctx, row.ID, "issue-1", f.now)
	if !errors.Is(err, ErrCloudRoute) || status != StatusFailed {
		t.Fatalf("Run = %q, %v; want ErrCloudRoute", status, err)
	}
	if is := f.issue("issue-1"); !strings.Contains(is.Metadata.Error, "paid") {
		t.Errorf("the failed issue does not say which feed: %q", is.Metadata.Error)
	}
	if len(b.prompts) != 0 {
		t.Error("paywalled text left the box")
	}
}
