package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/symunona/samizdat/server/internal/digest"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

// DigestRunner is the Runner the worker executes Digests with. The API validates
// a save against the same one, so save and run cannot disagree about rule 5.
func (w *Worker) DigestRunner() digest.Runner {
	return digest.Runner{Q: w.q, Router: w.llmRouter, Registry: w.extractorReg}
}

// scheduleDigests enqueues a run for every enabled Digest that is due. Same
// shape as schedulePollFeeds, except next_run_at moves FIRST: a Digest whose
// bump failed is skipped rather than enqueued again on every tick. The next due
// time is computed in the server's local zone — "7 o'clock" is the owner's.
func (w *Worker) scheduleDigests(ctx context.Context) {
	now := time.Now()
	nowStr := now.UTC().Format(time.RFC3339)
	due, err := w.q.ListDueDigests(ctx, nowStr)
	if err != nil {
		logScheduler.Errorf("list due digests: %v", err)
		return
	}
	for _, row := range due {
		next := digest.FromRow(row).NextRun(now).UTC().Format(time.RFC3339)
		if err := w.q.BumpDigestNextRun(ctx, store.BumpDigestNextRunParams{
			NextRunAt: next,
			UpdatedAt: nowStr,
			ID:        row.ID,
		}); err != nil {
			logScheduler.Errorf("bump next_run_at for digest %s: %v", row.ID, err)
			continue
		}
		queued, err := digest.Enqueue(ctx, w.q, row)
		if err != nil {
			logScheduler.Errorf("enqueue digest %s: %v", row.ID, err)
			continue
		}
		logScheduler.Printf("enqueued %s for digest %s (%s), job %s, next run %s",
			digest.Kind, row.ID, row.Name, queued.JobID, next)
	}
}

func handleRunDigest(ctx context.Context, runner digest.Runner, job store.Job) (string, error) {
	var p digest.JobPayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}
	status, err := runner.Run(pipeline.WithParentJobID(ctx, job.ID), p.DigestID, p.IssueID, time.Now())
	if err != nil {
		return "", fmt.Errorf("run digest: %w", err)
	}
	result, _ := json.Marshal(map[string]string{"issue_id": p.IssueID, "status": status})
	return string(result), nil
}

// holdHighlights archives the Highlights of a run that just completed when an
// enabled Digest picked its Document's Feed (store.FeedHeldByDigest), so they
// never sit in the feed between issues. It is the ONE site hold acts at; a step's insert knows nothing of it.
// Same stamp as sweepAutoArchive: pinned rows are left alone, rev + 1 carries
// the rest to the phone. A Document that came in through no Feed is never held —
// no Digest would ever read it back out.
func holdHighlights(ctx context.Context, q *store.Queries, run store.PipelineRun, now string) error {
	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return fmt.Errorf("get document: %w", err)
	}
	if doc.SourceFeedID == nil {
		return nil
	}
	held, err := q.FeedHeldByDigest(ctx, *doc.SourceFeedID)
	if err != nil {
		return fmt.Errorf("feed held by digest: %w", err)
	}
	if held == 0 {
		return nil
	}
	n, err := q.ArchiveHighlightsByPipelineRun(ctx, store.ArchiveHighlightsByPipelineRunParams{
		ArchivedAt:    &now,
		UpdatedAt:     now,
		PipelineRunID: run.ID,
	})
	if err != nil {
		return fmt.Errorf("archive run highlights: %w", err)
	}
	if n > 0 {
		logPipeline.Printf("run %s: held %d highlights for a digest", run.ID[:8], n)
	}
	return nil
}
