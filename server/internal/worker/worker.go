package worker

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/extractor"
	"github.com/symunona/samizdat/server/internal/store"
)

const (
	pollInterval     = 5 * time.Second
	schedulerInterval = 60 * time.Second
	maxAttempts      = 3
)

type Worker struct {
	q            *store.Queries
	cacheDir     string
	browser      *BrowserPool
	extractorReg extractor.Registry
}

func New(q *store.Queries, cacheDir string, extractorDir string) *Worker {
	browser, err := NewBrowserPool()
	if err != nil {
		log.Fatalf("worker: browser init failed: %v", err)
	}
	reg, err := extractor.LoadAll(extractorDir)
	if err != nil {
		log.Printf("worker: extractor registry load error: %v", err)
		reg = make(extractor.Registry)
	}
	log.Printf("worker: loaded %d extractor configs from %s", len(reg), extractorDir)
	return &Worker{q: q, cacheDir: cacheDir, browser: browser, extractorReg: reg}
}

func (w *Worker) Start(ctx context.Context) {
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
			}
		}
	}()
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
	now := time.Now().UTC().Format(time.RFC3339)
	subs, err := w.q.ListDueSubscriptions(ctx, now)
	if err != nil {
		log.Printf("scheduler: list due subscriptions: %v", err)
		return
	}
	for _, sub := range subs {
		payload, _ := json.Marshal(map[string]string{"feed_id": sub.FeedID})
		_, err := w.q.InsertJob(ctx, store.InsertJobParams{
			ID:        uuid.NewString(),
			Kind:      "poll_feed",
			Payload:   string(payload),
			RunAfter:  now,
			CreatedAt: now,
			UpdatedAt: now,
		})
		if err != nil {
			log.Printf("scheduler: enqueue poll_feed for sub %s: %v", sub.ID, err)
			continue
		}
		// Bump next_run_at so we don't double-enqueue on the next tick.
		nextRun := time.Now().UTC().Add(time.Duration(sub.IntervalH) * time.Hour).Format(time.RFC3339)
		if err := w.q.BumpSubscriptionNextRun(ctx, store.BumpSubscriptionNextRunParams{
			NextRunAt: nextRun,
			UpdatedAt: now,
			ID:        sub.ID,
		}); err != nil {
			log.Printf("scheduler: bump next_run_at for sub %s: %v", sub.ID, err)
		}
		log.Printf("scheduler: enqueued poll_feed for feed %s (sub %s)", sub.FeedID, sub.ID)
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
			log.Printf("worker: claim error: %v", err)
			return
		}
		w.run(ctx, job)
	}
}

func (w *Worker) run(ctx context.Context, job store.Job) {
	var (
		result string
		err    error
	)
	switch job.Kind {
	case "scrape_url":
		result, err = handleScrapeURL(ctx, w.q, job, w.browser)
	case "fetch_assets":
		result, err = handleFetchAssets(ctx, w.q, job, w.cacheDir)
	case "poll_feed":
		result, err = handlePollFeed(ctx, w.q, job, w.browser, w.extractorReg)
	default:
		err = fmt.Errorf("unknown job kind: %s", job.Kind)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if err == nil {
		if e := w.q.MarkJobDone(ctx, store.MarkJobDoneParams{Result: result, UpdatedAt: now, ID: job.ID}); e != nil {
			log.Printf("worker: mark done: %v", e)
		}
		log.Printf("worker: job %s (%s) done", job.ID[:8], job.Kind)
		return
	}

	log.Printf("worker: job %s (%s) attempt %d failed: %v", job.ID[:8], job.Kind, job.Attempts, err)

	// Record the error message on the job for operator visibility.
	if e := w.q.MarkJobLastError(ctx, store.MarkJobLastErrorParams{
		LastError: err.Error(),
		UpdatedAt: now,
		ID:        job.ID,
	}); e != nil {
		log.Printf("worker: mark last_error: %v", e)
	}

	status := "queued"
	if job.Attempts >= maxAttempts {
		status = "dead"
	}
	backoff := time.Duration(math.Pow(2, float64(job.Attempts-1))) * 30 * time.Second
	runAfter := time.Now().UTC().Add(backoff).Format(time.RFC3339)

	if e := w.q.MarkJobFailed(ctx, store.MarkJobFailedParams{
		Status:    status,
		Attempts:  job.Attempts,
		RunAfter:  runAfter,
		UpdatedAt: now,
		ID:        job.ID,
	}); e != nil {
		log.Printf("worker: mark failed: %v", e)
	}
}
