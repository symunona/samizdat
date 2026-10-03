package digest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

// JobPayload is the run_digest Job's payload. digest_id is what
// GetActiveRunDigestJob matches on, so that key must stay stable.
type JobPayload struct {
	DigestID   string `json:"digest_id"`
	DigestName string `json:"digest_name,omitempty"`
	// IssueID is minted here, not by the handler: a retried Job must reopen the
	// issue it already started.
	IssueID string `json:"issue_id"`
}

// Queued is what an enqueue hands back: the Job to watch and the issue it will
// write. Deduped means a run was already in flight and this is that one.
type Queued struct {
	JobID   string `json:"job_id"`
	IssueID string `json:"issue_id"`
	Deduped bool   `json:"deduped"`
}

// Enqueue inserts the run_digest Job for d — the scheduler's and "Run now"'s
// one way in. A Digest with a run already queued or running gets that run back
// instead of a second one over the same window.
func Enqueue(ctx context.Context, q *store.Queries, d store.Digest) (Queued, error) {
	active, err := q.GetActiveRunDigestJob(ctx, d.ID)
	if err == nil {
		var p JobPayload
		_ = json.Unmarshal([]byte(active.Payload), &p)
		return Queued{JobID: active.ID, IssueID: p.IssueID, Deduped: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Queued{}, fmt.Errorf("look up active run: %w", err)
	}

	p := JobPayload{DigestID: d.ID, DigestName: d.Name, IssueID: uuid.NewString()}
	payload, _ := json.Marshal(p)
	now := time.Now().UTC().Format(time.RFC3339)
	job, err := q.InsertJob(ctx, store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      Kind,
		Payload:   string(payload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return Queued{}, fmt.Errorf("enqueue %s: %w", Kind, err)
	}
	return Queued{JobID: job.ID, IssueID: p.IssueID}, nil
}
