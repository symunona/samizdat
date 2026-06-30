package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

const (
	pollInterval      = 5 * time.Second
	schedulerInterval = 60 * time.Second
	maxAttempts       = 3
	stuckJobAge       = 10 * time.Minute
)

type Worker struct {
	q            *store.Queries
	db           *sql.DB
	cacheDir     string
	browser      *BrowserPool
	extractorReg extractor.Registry
	llmClient    llm.Client
	ytdlp        config.YTDLPSection
}

func New(q *store.Queries, db *sql.DB, cacheDir string, extractorDir string, llmClient llm.Client, ytdlp config.YTDLPSection) *Worker {
	browser, err := NewBrowserPool()
	if err != nil {
		logWorker.Fatalf("browser init failed: %v", err)
	}
	reg, err := extractor.LoadAll(extractorDir)
	if err != nil {
		logWorker.Errorf("extractor registry load error: %v", err)
		reg = make(extractor.Registry)
	}
	logWorker.Printf("loaded %d extractor configs from %s", len(reg), extractorDir)
	return &Worker{q: q, db: db, cacheDir: cacheDir, browser: browser, extractorReg: reg, llmClient: llmClient, ytdlp: ytdlp}
}

func (w *Worker) Start(ctx context.Context) {
	w.resetStuckJobs(ctx)
	go func() {
		w.loop(ctx)
		w.browser.Close()
	}()
	go func() {
		t := time.NewTicker(schedulerInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				w.schedulePollFeeds(ctx)
				w.resetStuckJobs(ctx)
			}
		}
	}()
}

func (w *Worker) resetStuckJobs(ctx context.Context) {
	now := time.Now().UTC()
	cutoff := now.Add(-stuckJobAge).Format(time.RFC3339)
	nowStr := now.Format(time.RFC3339)
	if err := w.q.ResetStuckJobs(ctx, store.ResetStuckJobsParams{
		RunAfter:    nowStr,
		UpdatedAt:   nowStr,
		UpdatedAt_2: cutoff,
	}); err != nil {
		logWorker.Errorf("reset stuck jobs: %v", err)
	} else {
		logWorker.Printf("reset stuck jobs older than %s", cutoff)
	}
}

// ExtractorRegistry returns the loaded extractor registry.
func (w *Worker) ExtractorRegistry() extractor.Registry {
	return w.extractorReg
}

// FetchHTML fetches the fully-rendered HTML for the given URL via the browser pool.
func (w *Worker) FetchHTML(url string) (string, error) {
	return w.browser.FetchHTML(url)
}

func (w *Worker) schedulePollFeeds(ctx context.Context) {
	if val, err := w.q.GetSetting(ctx, "polling_enabled"); err == nil && val == "false" {
		logScheduler.Printf("polling disabled, skipping")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	subs, err := w.q.ListDueSubscriptions(ctx, now)
	if err != nil {
		logScheduler.Errorf("list due subscriptions: %v", err)
		return
	}
	logScheduler.Printf("%d due subscriptions", len(subs))
	for _, sub := range subs {
		feedURL := ""
		if feed, err := w.q.GetFeed(ctx, sub.FeedID); err == nil {
			feedURL = feed.Url
		}
		payload, _ := json.Marshal(pollFeedPayload{FeedID: sub.FeedID, FeedURL: feedURL})
		_, err := w.q.InsertJob(ctx, store.InsertJobParams{
			ID:        uuid.NewString(),
			Kind:      "poll_feed",
			Payload:   string(payload),
			RunAfter:  now,
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			logScheduler.Errorf("enqueue poll_feed for sub %s: %v", sub.ID, err)
			continue
		}
		// Bump next_run_at so we don't double-enqueue on the next tick.
		nextRun := time.Now().UTC().Add(time.Duration(sub.IntervalH) * time.Hour).Format(time.RFC3339)
		if err := w.q.BumpSubscriptionNextRun(ctx, store.BumpSubscriptionNextRunParams{
			NextRunAt: nextRun,
			UpdatedAt: now,
			ID:        sub.ID,
		}); err != nil {
			logScheduler.Errorf("bump next_run_at for sub %s: %v", sub.ID, err)
		}
		logScheduler.Printf("enqueued poll_feed for feed %s (sub %s)", sub.FeedID, sub.ID)
	}
}

func (w *Worker) loop(ctx context.Context) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.drainQueue(ctx)
		}
	}
}

func (w *Worker) drainQueue(ctx context.Context) {
	for {
		now := time.Now().UTC().Format(time.RFC3339)
		job, err := w.q.ClaimNextJob(ctx, store.ClaimNextJobParams{
			UpdatedAt: now,
			RunAfter:  now,
		})
		if errors.Is(err, sql.ErrNoRows) {
			return
		}
		if err != nil {
			logWorker.Errorf("claim error: %v", err)
			return
		}
		w.run(ctx, job)
	}
}

func (w *Worker) run(ctx context.Context, job store.Job) {
	logWorker.Printf("job %s (%s) attempt %d starting  payload=%s",
		job.ID[:8], job.Kind, job.Attempts+1, job.Payload)
	start := time.Now()

	// Make the DB handle available to pipeline steps so they can wrap their
	// highlight inserts in a transaction (idempotent retries — no duplicates).
	ctx = pipeline.WithDB(ctx, w.db)

	var (
		result string
		err    error
	)
	switch job.Kind {
	case "scrape_url":
		result, err = handleScrapeURL(ctx, w.q, job, w.browser, w.cacheDir, w.ytdlp)
	case "fetch_assets":
		result, err = handleFetchAssets(ctx, w.q, job, w.cacheDir)
	case "poll_feed":
		result, err = handlePollFeed(ctx, w.q, job, w.browser, w.extractorReg)
	case "run_pipeline":
		result, err = handleRunPipeline(ctx, w.q, w.db, job, w.llmClient)
	case "run_pipeline_step":
		result, err = handleRunPipelineStep(ctx, w.q, job, w.llmClient)
	default:
		err = fmt.Errorf("unknown job kind: %s", job.Kind)
	}

	elapsed := time.Since(start).Round(time.Millisecond)
	now := time.Now().UTC().Format(time.RFC3339)
	if err == nil {
		if e := w.q.MarkJobDone(ctx, store.MarkJobDoneParams{Result: result, DurationMs: elapsed.Milliseconds(), UpdatedAt: now, ID: job.ID}); e != nil {
			logWorker.Errorf("mark done: %v", e)
		}
		logWorker.Printf("job %s (%s) done in %s  result=%s", job.ID[:8], job.Kind, elapsed, result)
		return
	}

	logWorker.Errorf("job %s (%s) attempt %d failed in %s: %v", job.ID[:8], job.Kind, job.Attempts, elapsed, err)

	// Record the error message on the job for operator visibility.
	if e := w.q.MarkJobLastError(ctx, store.MarkJobLastErrorParams{
		LastError: err.Error(),
		UpdatedAt: now,
		ID:        job.ID,
	}); e != nil {
		logWorker.Errorf("mark last_error: %v", e)
	}

	status := "queued"
	if job.Attempts >= maxAttempts {
		status = "dead"
	}
	backoff := time.Duration(math.Pow(2, float64(job.Attempts-1))) * 30 * time.Second
	runAfter := time.Now().UTC().Add(backoff).Format(time.RFC3339)

	logWorker.Printf("job %s (%s) → status=%s  backoff=%s  run_after=%s",
		job.ID[:8], job.Kind, status, backoff.Round(time.Second), runAfter)

	if e := w.q.MarkJobFailed(ctx, store.MarkJobFailedParams{
		Status:     status,
		Attempts:   job.Attempts,
		RunAfter:   runAfter,
		DurationMs: elapsed.Milliseconds(),
		UpdatedAt:  now,
		ID:         job.ID,
	}); e != nil {
		logWorker.Errorf("mark failed: %v", e)
	}

	// When a pipeline step job permanently dies, mark the run failed so pollers don't wait forever.
	if status == "dead" && job.Kind == "run_pipeline_step" {
		var p runPipelineStepPayload
		if e := json.Unmarshal([]byte(job.Payload), &p); e == nil && p.PipelineRunID != "" {
			if e := w.q.UpdatePipelineRunProgress(ctx, store.UpdatePipelineRunProgressParams{
				Status:    "failed",
				StepIndex: 0,
				State:     "{}",
				UpdatedAt: now,
				ID:        p.PipelineRunID,
			}); e != nil {
				logWorker.Errorf("mark pipeline run %s failed: %v", p.PipelineRunID[:8], e)
			} else {
				logWorker.Printf("pipeline run %s marked failed (step job dead)", p.PipelineRunID[:8])
			}
		}
	}
}
