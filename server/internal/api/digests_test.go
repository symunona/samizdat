package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/digest"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// digestsFixture is a handler over a temp DB with two Feeds — "paid" scrapes
// behind a login — and a Router whose only cloud provider is anthropic.
func digestsFixture(t *testing.T) (*digestsHandler, *store.Queries) {
	t.Helper()
	for _, k := range []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"} {
		t.Setenv(k, "")
	}
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	q := store.New(db)
	now := time.Now().UTC().Format(time.RFC3339)
	for _, id := range []string{"open", "paid"} {
		if _, err := q.UpsertFeed(t.Context(), store.UpsertFeedParams{
			ID: id, Url: "https://" + id + ".example/rss", Kind: "rss", Title: id, Config: "{}", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	router := llm.NewRouter(config.LLMSection{
		Provider: "openai_compat", BaseURL: "http://box.example:11434/v1", DefaultModel: "m",
		Fallback: []config.LLMSection{{Provider: "anthropic", APIKey: "sk-test"}},
	})
	reg := extractor.Registry{"paid.example": {Kind: "rss", Auth: &extractor.AuthConfig{LoginURL: "https://paid.example/login"}}}
	return &digestsHandler{q: q, db: db, runner: digest.Runner{Q: q, Router: router, Registry: reg}}, q
}

// oneQuestion is the least a Digest may be saved with.
const oneQuestion = `"questions":[{"title":"Tools","prompt":"which?","enabled":true}]`

// call runs one handler and decodes its JSON body into out (nil = ignore it).
func call(t *testing.T, fn http.HandlerFunc, method, id, body string, out any) int {
	t.Helper()
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.SetPathValue("id", id)
	rec := httptest.NewRecorder()
	fn(rec, req)
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("decode %q: %v", rec.Body.String(), err)
		}
	}
	return rec.Code
}

func TestDigestCRUD(t *testing.T) {
	h, q := digestsFixture(t)

	// The lists of a Digest nobody filled in are [], never null: RN renders null
	// as a blank screen.
	var listed json.RawMessage
	if code := call(t, h.list, http.MethodGet, "", "", &listed); code != http.StatusOK || strings.TrimSpace(string(listed)) != "[]" {
		t.Fatalf("empty list = %d %s", code, listed)
	}

	var d digest.Digest
	body := `{"name":"AI weekly","period":"weekly","weekdays":[5,2],"hour":6,"source_feed_ids":["open"],
		"provider":"box.example:11434",` + oneQuestion + `}`
	if code := call(t, h.create, http.MethodPost, "", body, &d); code != http.StatusCreated {
		t.Fatalf("create = %d", code)
	}
	if d.ID == "" || !d.Enabled || d.Weekdays[0] != 2 || d.Questions[0].ID == "" || d.Questions[0].TopN != 5 || d.LastRunAt != nil {
		t.Fatalf("created = %+v", d)
	}
	next, err := time.Parse(time.RFC3339, d.NextRunAt)
	if err != nil || !next.After(time.Now()) || next.In(time.Local).Hour() != 6 {
		t.Fatalf("next_run_at = %q, want a future 6 o'clock local", d.NextRunAt)
	}
	if wd := next.In(time.Local).Weekday(); wd != time.Tuesday && wd != time.Friday {
		t.Fatalf("next_run_at falls on %s, want Tue or Fri", wd)
	}

	// A PATCH carries only what changed. A rename leaves the schedule alone;
	// disabling survives a re-read (the list's switch).
	var patched digest.Digest
	if code := call(t, h.update, http.MethodPatch, d.ID, `{"name":"Renamed","enabled":false}`, &patched); code != http.StatusOK {
		t.Fatalf("patch = %d", code)
	}
	if patched.Name != "Renamed" || patched.Enabled || patched.NextRunAt != d.NextRunAt || len(patched.Questions) != 1 || patched.Rev != d.Rev+1 {
		t.Fatalf("patched = %+v", patched)
	}
	var got digest.Digest
	call(t, h.get, http.MethodGet, d.ID, "", &got)
	if got.Enabled || got.Questions[0].Prompt != "which?" {
		t.Fatalf("re-read = %+v", got)
	}
	// Changing the schedule moves next_run_at with it.
	call(t, h.update, http.MethodPatch, d.ID, `{"period":"daily","hour":23}`, &patched)
	if moved, _ := time.Parse(time.RFC3339, patched.NextRunAt); moved.In(time.Local).Hour() != 23 || len(patched.Weekdays) != 0 {
		t.Fatalf("after a schedule change: next_run_at %q weekdays %v", patched.NextRunAt, patched.Weekdays)
	}

	for name, bad := range map[string]string{
		"no name":             `{"period":"daily",` + oneQuestion + `}`,
		"monthly":             `{"name":"x","period":"monthly",` + oneQuestion + `}`,
		"unknown feed":        `{"name":"x","source_feed_ids":["nope"],` + oneQuestion + `}`,
		"no question":         `{"name":"x"}`,
		"unknown color":       `{"name":"x","color":"teal",` + oneQuestion + `}`,
		"no enabled question": `{"name":"x","questions":[{"title":"Tools","prompt":"which?"}]}`,
		"not json":            `{`,
	} {
		if code := call(t, h.create, http.MethodPost, "", bad, nil); code != http.StatusBadRequest {
			t.Errorf("%s: create = %d, want 400", name, code)
		}
	}

	// Run now, twice: one Job, the second call handed the first.
	var first, second digest.Queued
	call(t, h.run, http.MethodPost, d.ID, "", &first)
	call(t, h.run, http.MethodPost, d.ID, "", &second)
	if first.JobID == "" || first.IssueID == "" || first.Deduped || !second.Deduped || second.JobID != first.JobID || second.IssueID != first.IssueID {
		t.Fatalf("run = %+v then %+v", first, second)
	}

	// Delete tombstones the Digest and its issues.
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := q.UpsertDigestIssue(t.Context(), store.UpsertDigestIssueParams{
		ID: "issue-1", DigestID: d.ID, WindowStart: now, WindowEnd: now, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if code := call(t, h.delete, http.MethodDelete, d.ID, "", nil); code != http.StatusNoContent {
		t.Fatalf("delete = %d", code)
	}
	if code := call(t, h.get, http.MethodGet, d.ID, "", nil); code != http.StatusNotFound {
		t.Errorf("get after delete = %d", code)
	}
	if code := call(t, h.getIssue, http.MethodGet, "issue-1", "", nil); code != http.StatusNotFound {
		t.Errorf("issue after its digest was deleted = %d", code)
	}
	synced := doSync(t, &syncHandler{q: q}, "1970-01-01T00:00:00Z")
	if len(synced.Digests) != 1 || synced.Digests[0].DeletedAt == nil || len(synced.DigestIssues) != 1 || synced.DigestIssues[0].DeletedAt == nil {
		t.Errorf("sync must carry both tombstones: %+v %+v", synced.Digests, synced.DigestIssues)
	}
}

// An app older than `history` rewrites the whole question list without the
// field. That must not switch it off; only a request that names it may.
func TestDigestQuestionHistorySurvivesAnOlderClient(t *testing.T) {
	h, _ := digestsFixture(t)
	var d digest.Digest
	body := `{"name":"AI","provider":"box.example:11434","questions":[
		{"title":"Frontier","prompt":"which?","enabled":true,"history":true},
		{"title":"Tools","prompt":"which?","enabled":true}]}`
	if code := call(t, h.create, http.MethodPost, "", body, &d); code != http.StatusCreated {
		t.Fatalf("create = %d", code)
	}
	if !d.Questions[0].History || d.Questions[1].History {
		t.Fatalf("created questions = %+v", d.Questions)
	}

	old := `{"questions":[{"id":"` + d.Questions[0].ID + `","title":"Renamed","prompt":"which?","enabled":true,"top_n":5},
		{"id":"` + d.Questions[1].ID + `","title":"Tools","prompt":"which?","enabled":true,"top_n":5}]}`
	var patched digest.Digest
	call(t, h.update, http.MethodPatch, d.ID, old, &patched)
	if patched.Questions[0].Title != "Renamed" || !patched.Questions[0].History || patched.Questions[1].History {
		t.Fatalf("after an older client's save: %+v", patched.Questions)
	}

	off := `{"questions":[{"id":"` + d.Questions[0].ID + `","title":"Renamed","prompt":"which?","enabled":true,"history":false}]}`
	var switched digest.Digest // a fresh one: `history` is omitted when false
	call(t, h.update, http.MethodPatch, d.ID, off, &switched)
	if len(switched.Questions) != 1 || switched.Questions[0].History {
		t.Fatalf("after switching it off: %+v", switched.Questions)
	}
}

// A Digest saved without a colour gets the first one no other Digest uses; a
// named colour is kept, and anything off the palette is refused.
func TestDigestColor(t *testing.T) {
	h, _ := digestsFixture(t)
	// Pinned to the local box: an unpinned Digest reading the paid Feed is refused.
	const local = `"provider":"box.example:11434",` + oneQuestion
	var first, second, picked digest.Digest
	call(t, h.create, http.MethodPost, "", `{"name":"First",`+local+`}`, &first)
	call(t, h.create, http.MethodPost, "", `{"name":"Second",`+local+`}`, &second)
	call(t, h.create, http.MethodPost, "", `{"name":"Picked","color":"purple",`+local+`}`, &picked)
	if first.Color != digest.Colors[0] || second.Color != digest.Colors[1] || picked.Color != "purple" {
		t.Fatalf("colors = %q, %q, %q", first.Color, second.Color, picked.Color)
	}
	if code := call(t, h.update, http.MethodPatch, second.ID, `{"color":"#00ff00"}`, nil); code != http.StatusBadRequest {
		t.Errorf("patch with a hex color = %d, want 400", code)
	}
	call(t, h.update, http.MethodPatch, second.ID, `{"color":"green"}`, &second)
	var listed []digest.Digest
	call(t, h.list, http.MethodGet, "", "", &listed)
	if second.Color != "green" || len(listed) != 3 || listed[1].Color != "green" {
		t.Errorf("after picking green: patch %q, list %+v", second.Color, listed)
	}

	// A row older than the column takes a colour on its next save, and keeps it.
	if _, err := h.db.ExecContext(t.Context(), `UPDATE digests SET color = '' WHERE id = ?`, second.ID); err != nil {
		t.Fatal(err)
	}
	call(t, h.update, http.MethodPatch, second.ID, `{"enabled":false}`, &second)
	if second.Color != digest.Colors[1] {
		t.Errorf("legacy row saved with color %q, want %q (red and purple are taken)", second.Color, digest.Colors[1])
	}
	call(t, h.update, http.MethodPatch, second.ID, `{"name":"Second again"}`, &second)
	if second.Color != digest.Colors[1] {
		t.Errorf("a rename changed the color to %q", second.Color)
	}
	synced := doSync(t, &syncHandler{q: h.q}, "1970-01-01T00:00:00Z")
	for _, d := range synced.Digests {
		if d.Color == "" {
			t.Errorf("sync carries %q without its color", d.Name)
		}
	}
}

// Rule 5 at save: a Digest scoped to a Feed scraped with a login is refused on
// any route that can reach a cloud provider — pinned, or the chain's fallback.
func TestDigestSaveRefusesCloudRouteForAuthFeed(t *testing.T) {
	h, _ := digestsFixture(t)

	for name, tc := range map[string]struct {
		body string
		want int
	}{
		"pinned cloud":              {`{"name":"x","source_feed_ids":["paid"],"provider":"anthropic",` + oneQuestion + `}`, http.StatusUnprocessableEntity},
		"chain with cloud fallback": {`{"name":"x","source_feed_ids":["paid"],` + oneQuestion + `}`, http.StatusUnprocessableEntity},
		"every feed, cloud":         {`{"name":"x","provider":"anthropic",` + oneQuestion + `}`, http.StatusUnprocessableEntity},
		"pinned local":              {`{"name":"x","source_feed_ids":["paid"],"provider":"box.example:11434",` + oneQuestion + `}`, http.StatusCreated},
		"cloud without the feed":    {`{"name":"x","source_feed_ids":["open"],"provider":"anthropic",` + oneQuestion + `}`, http.StatusCreated},
	} {
		var out map[string]any
		if code := call(t, h.create, http.MethodPost, "", tc.body, &out); code != tc.want {
			t.Errorf("%s: create = %d (%v), want %d", name, code, out["error"], tc.want)
		}
	}

	// The same gate on PATCH: a saved local Digest cannot be re-pointed at the cloud.
	var d digest.Digest
	call(t, h.create, http.MethodPost, "", `{"name":"y","source_feed_ids":["paid"],"provider":"box.example:11434",`+oneQuestion+`}`, &d)
	var out map[string]string
	if code := call(t, h.update, http.MethodPatch, d.ID, `{"provider":"anthropic"}`, &out); code != http.StatusUnprocessableEntity {
		t.Fatalf("patch to cloud = %d, want 422", code)
	}
	if !strings.Contains(out["error"], "paid") || !strings.Contains(out["error"], "anthropic") {
		t.Errorf("the refusal must name the feed and the provider: %q", out["error"])
	}
}

// An issue is served with its refs resolved; the list and the sync delta carry
// the same issue unresolved, with lists that are never null.
func TestDigestIssueServedResolved(t *testing.T) {
	h, q := digestsFixture(t)
	ctx := t.Context()
	now := time.Now().UTC().Format(time.RFC3339)
	feedID := "open"

	if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
		ID: "doc-1", CanonicalUrl: "https://open.example/1", Title: "Issue 12", FetchedAt: now,
		SourceFeedID: &feedID, MediaType: "article", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: "pipe", Name: "p", Enabled: 1, Trigger: "manual", Filter: "{}", Steps: "[]", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertPipelineRun(ctx, store.InsertPipelineRunParams{
		ID: "run", PipelineID: "pipe", DocumentID: "doc-1", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
		ID: "hl-1", DocumentID: "doc-1", PipelineRunID: "run", Kind: "summary", Title: "Summary",
		Body: "- first thing\n- **second** thing", Metadata: "{}", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	var d digest.Digest
	call(t, h.create, http.MethodPost, "", `{"name":"AI","provider":"box.example:11434",`+oneQuestion+`}`, &d)
	if _, err := q.UpsertDigestIssue(ctx, store.UpsertDigestIssueParams{
		ID: "issue-1", DigestID: d.ID, WindowStart: now, WindowEnd: now, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}

	// Still running: topics and metadata.questions are [], not null.
	var raw map[string]json.RawMessage
	call(t, h.getIssue, http.MethodGet, "issue-1", "", &raw)
	if string(raw["topics"]) != "[]" || !strings.Contains(string(raw["metadata"]), `"questions":[]`) || string(raw["status"]) != `"running"` {
		t.Fatalf("running issue = %s", raw)
	}

	topics := `[{"question_id":"q1","question_title":"Tools","rank":1,"title":"T","why":"w",
		"refs":[{"highlight_id":"hl-1","bullet":1},{"highlight_id":"hl-1","bullet":-1},{"highlight_id":"gone","bullet":0}]}]`
	if err := q.FinishDigestIssue(ctx, store.FinishDigestIssueParams{
		Status: digest.StatusDone, Topics: topics, Metadata: `{"questions":[{"question_id":"q1","model":"m","truncated":true}]}`,
		UpdatedAt: now, ID: "issue-1",
	}); err != nil {
		t.Fatal(err)
	}

	var issue digest.Issue
	if code := call(t, h.getIssue, http.MethodGet, "issue-1", "", &issue); code != http.StatusOK {
		t.Fatalf("get issue = %d", code)
	}
	refs := issue.Topics[0].Refs
	if refs[0].Text != "**second** thing" || refs[0].DocumentID != "doc-1" || refs[0].DocumentTitle != "Issue 12" ||
		refs[0].FeedTitle != "open" || refs[0].HighlightTitle != "Summary" {
		t.Errorf("bullet ref = %+v", refs[0])
	}
	if refs[1].Text != "- first thing\n- **second** thing" {
		t.Errorf("whole-Highlight ref text = %q", refs[1].Text)
	}
	if !refs[2].Missing || refs[2].Text != "" {
		t.Errorf("a ref to a Highlight that is gone = %+v, want missing", refs[2])
	}
	if !issue.Metadata.Questions[0].Truncated {
		t.Error("metadata lost `truncated`")
	}

	var list []digest.Issue
	call(t, h.listIssues, http.MethodGet, d.ID, "", &list)
	if len(list) != 1 || list[0].Status != digest.StatusDone || list[0].Topics[0].Refs[0].Text != "" {
		t.Errorf("issue list = %+v, want the issue with refs unresolved", list)
	}
	synced := doSync(t, &syncHandler{q: q}, "1970-01-01T00:00:00Z")
	if len(synced.Digests) != 1 || synced.Digests[0].Name != "AI" ||
		len(synced.DigestIssues) != 1 || len(synced.DigestIssues[0].Topics[0].Refs) != 3 || synced.DigestIssues[0].Topics[0].Refs[0].Text != "" {
		t.Errorf("sync = %+v %+v", synced.Digests, synced.DigestIssues)
	}
}
