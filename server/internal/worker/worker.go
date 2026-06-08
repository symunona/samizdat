package worker

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

const (
	pollInterval = 5 * time.Second
	maxAttempts  = 3
)

type Worker struct {
	q        *store.Queries
	cacheDir string
}

func New(q *store.Queries, cacheDir string) *Worker {
	return &Worker{q: q, cacheDir: cacheDir}
}

func (w *Worker) Start(ctx context.Context) {
	go w.loop(ctx)
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
	var err error
	switch job.Kind {
	case "scrape_url":
		err = handleScrapeURL(ctx, w.q, job)
	case "fetch_assets":
		err = handleFetchAssets(ctx, w.q, job, w.cacheDir)
	default:
		err = fmt.Errorf("unknown job kind: %s", job.Kind)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if err == nil {
		if e := w.q.MarkJobDone(ctx, store.MarkJobDoneParams{UpdatedAt: now, ID: job.ID}); e != nil {
			log.Printf("worker: mark done: %v", e)
		}
		log.Printf("worker: job %s (%s) done", job.ID[:8], job.Kind)
		return
	}

	log.Printf("worker: job %s (%s) attempt %d failed: %v", job.ID[:8], job.Kind, job.Attempts, err)

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
