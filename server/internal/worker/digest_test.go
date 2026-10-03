package worker

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/symunona/samizdat/server/internal/digest"
	"github.com/symunona/samizdat/server/internal/store"
)

// The scheduler enqueues a due, enabled Digest exactly once: next_run_at moves
// before the Job is inserted, so the next tick finds nothing due. A disabled
// Digest is never enqueued, however overdue.
func TestScheduleDigests(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()
	w := &Worker{q: q}

	now := time.Now().UTC()
	stamp := now.Format(time.RFC3339)
	add := func(id string, enabled int64, nextRun time.Time) {
		if _, err := q.InsertDigest(ctx, store.InsertDigestParams{
			ID: id, Name: id, Enabled: enabled, Period: digest.PeriodDaily, Weekdays: "[]", Hour: 7,
			SourceFeedIds: "[]", Questions: "[]", NextRunAt: nextRun.Format(time.RFC3339),
			CreatedAt: stamp, UpdatedAt: stamp,
		}); err != nil {
			t.Fatal(err)
		}
	}
	add("due", 1, now.Add(-time.Hour))
	add("disabled", 0, now.Add(-time.Hour))
	add("later", 1, now.Add(time.Hour))

	w.scheduleDigests(ctx)
	w.scheduleDigests(ctx)

	jobs, err := q.ListJobsByKind(ctx, digest.Kind)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 {
		t.Fatalf("%d %s jobs after two ticks, want 1", len(jobs), digest.Kind)
	}
	if queued, err := digest.Enqueue(ctx, q, store.Digest{ID: "due"}); err != nil || !queued.Deduped || queued.JobID != jobs[0].ID || queued.IssueID == "" {
		t.Errorf("a second enqueue = %+v, %v; want the run already queued", queued, err)
	}

	due, _ := q.GetDigest(ctx, "due")
	next, err := time.Parse(time.RFC3339, due.NextRunAt)
	if err != nil || !next.After(now) || next.Sub(now) > 24*time.Hour {
		t.Errorf("next_run_at = %q, want the next 7 o'clock", due.NextRunAt)
	}
	if next.In(time.Local).Hour() != 7 {
		t.Errorf("next_run_at = %s local, want hour 7 in the server's zone", next.In(time.Local))
	}
	if disabled, _ := q.GetDigest(ctx, "disabled"); disabled.NextRunAt != now.Add(-time.Hour).Format(time.RFC3339) {
		t.Error("a disabled Digest was touched")
	}
}

// Hold acts where a pipeline run completes, and only for a Feed an enabled
// Digest picked by name. Everything else stays in the feed — including every
// Feed of a Digest scoped to all of them — and a pinned Highlight stays there
// even when its Feed is held.
func TestHoldArchivesAtRunCompletion(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	q := store.New(db)
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339)

	// No steps: the first tick finds nothing left to do and completes the run.
	if _, err := q.InsertPipeline(ctx, store.InsertPipelineParams{
		ID: "pipeline-1", Name: "test", Enabled: 1, Trigger: "manual", Filter: "{}", Steps: "[]",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	addDigest := func(id string, enabled int64, feeds string) {
		t.Helper()
		if _, err := q.InsertDigest(ctx, store.InsertDigestParams{
			ID: id, Name: id, Enabled: enabled, Period: digest.PeriodDaily, Weekdays: "[]", Hour: 7,
			SourceFeedIds: feeds, Questions: "[]", NextRunAt: now,
			CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// complete runs a pipeline to completion for one Document of feedID ("" = a
	// Document that came in through no Feed) and returns its Highlights by id.
	complete := func(name, feedID string) map[string]store.Highlight {
		t.Helper()
		docID, runID := "document-"+name, "pipeline-run-"+name
		var feed *string
		if feedID != "" {
			if _, err := q.UpsertFeed(ctx, store.UpsertFeedParams{
				ID: feedID, Url: "https://" + feedID + ".example/rss", Kind: "rss", Title: feedID, Config: "{}",
				CreatedAt: now, UpdatedAt: now,
			}); err != nil {
				t.Fatal(err)
			}
			feed = &feedID
		}
		if _, err := q.UpsertDocument(ctx, store.UpsertDocumentParams{
			ID: docID, CanonicalUrl: "https://" + name + ".example/1", Title: name,
			FetchedAt: now, SourceFeedID: feed, MediaType: "article", CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := q.InsertPipelineRun(ctx, store.InsertPipelineRunParams{
			ID: runID, PipelineID: "pipeline-1", DocumentID: docID, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{name + "-plain", name + "-pinned"} {
			if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
				ID: id, DocumentID: docID, PipelineRunID: runID, Kind: "note",
				Title: id, Body: "body", Metadata: "{}", CreatedAt: now, UpdatedAt: now,
			}); err != nil {
				t.Fatal(err)
			}
		}
		if err := q.UpdateHighlightPinned(ctx, store.UpdateHighlightPinnedParams{Pinned: 1, UpdatedAt: now, ID: name + "-pinned"}); err != nil {
			t.Fatal(err)
		}

		payload := `{"pipeline_run_id":"` + runID + `"}`
		if out, err := handleRunPipelineStep(ctx, q, store.Job{ID: "job-" + name, Payload: payload}, nil); err != nil || out != `{"status":"done"}` {
			t.Fatalf("%s: step = %q, %v; want the run done", name, out, err)
		}
		rows, err := q.ListHighlightsByPipelineRun(ctx, runID)
		if err != nil {
			t.Fatal(err)
		}
		got := map[string]store.Highlight{}
		for _, r := range rows {
			got[r.ID] = r
		}
		return got
	}

	addDigest("scoped", 1, `["other","held"]`)
	addDigest("disabled", 0, `["of-disabled"]`)
	// No Feed list = every Feed, and holding every Feed would empty the feed.
	addDigest("everything", 1, `[]`)

	held := complete("held", "held")
	if h := held["held-plain"]; h.ArchivedAt == nil || h.Rev != 1 {
		t.Errorf("held feed: archived_at=%v rev=%d, want archived with rev 1 so a device pulls it", h.ArchivedAt, h.Rev)
	}
	if held["held-pinned"].ArchivedAt != nil {
		t.Error("a pinned Highlight was held — pinning is the user's explicit keep")
	}
	for name, feedID := range map[string]string{
		"read-by-every-feed-digest": "unpicked",
		"of-disabled":               "of-disabled",
		"held-prefix":               "hel", // a substring of a picked id is not that id
		"no-feed":                   "",
	} {
		if complete(name, feedID)[name+"-plain"].ArchivedAt != nil {
			t.Errorf("%s: a Highlight no Digest picked was archived", name)
		}
	}
}
