package store

import (
	"context"
	"encoding/json"
	"fmt"
)

// Rerun cascade helpers — hand-written raw SQL because sqlc's SQLite parser does
// not bind parameters inside json_each(); positional `?` inside json_each works at
// runtime (same pattern as the recursive job-subtree query in api/jobs.go).
//
// All take a DBTX so callers can run them inside a transaction (pass a *sql.Tx)
// for atomic cascades. IDs are passed as a JSON array bound to a single `?`.
//
// The "user-interacted" preservation rule lives ONCE, in
// SoftDeleteRegenerableHighlights — shared by both the forced-rerun endpoint and
// the content-change regenerate path.

func idsJSON(ids []string) (string, error) {
	b, err := json.Marshal(ids)
	if err != nil {
		return "", fmt.Errorf("marshal ids: %w", err)
	}
	return string(b), nil
}

// RunIDsByJobIDs returns non-deleted pipeline_run ids whose job_id is in jobIDs.
func RunIDsByJobIDs(ctx context.Context, db DBTX, jobIDs []string) ([]string, error) {
	j, err := idsJSON(jobIDs)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx,
		`SELECT id FROM pipeline_runs
		 WHERE job_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`, j)
	if err != nil {
		return nil, fmt.Errorf("query runs by job ids: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan run id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate runs: %w", err)
	}
	return ids, nil
}

// ActiveRunIDsForDoc returns non-deleted pipeline_run ids for a (pipeline, doc).
func ActiveRunIDsForDoc(ctx context.Context, db DBTX, pipelineID, documentID string) ([]string, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id FROM pipeline_runs
		 WHERE pipeline_id = ? AND document_id = ? AND deleted_at IS NULL`, pipelineID, documentID)
	if err != nil {
		return nil, fmt.Errorf("query active runs for doc: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan run id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate runs: %w", err)
	}
	return ids, nil
}

// SoftDeleteRegenerableHighlights soft-deletes (tombstone + rev bump) the
// machine-generated highlights of the given runs, EXCEPT user-interacted ones:
// pinned, archived, annotated, or tagged highlights are never deleted. Returns
// the number of highlights tombstoned.
func SoftDeleteRegenerableHighlights(ctx context.Context, db DBTX, runIDs []string, now string) (int64, error) {
	if len(runIDs) == 0 {
		return 0, nil
	}
	j, err := idsJSON(runIDs)
	if err != nil {
		return 0, err
	}
	res, err := db.ExecContext(ctx,
		`UPDATE highlights SET deleted_at = ?, updated_at = ?, rev = rev + 1
		 WHERE pipeline_run_id IN (SELECT value FROM json_each(?))
		   AND deleted_at IS NULL
		   AND pinned = 0
		   AND archived_at IS NULL
		   AND NOT EXISTS (SELECT 1 FROM annotations a WHERE a.highlight_id = highlights.id AND a.deleted_at IS NULL)
		   AND NOT EXISTS (SELECT 1 FROM highlight_tags ht WHERE ht.highlight_id = highlights.id AND ht.deleted_at IS NULL)`,
		now, now, j)
	if err != nil {
		return 0, fmt.Errorf("soft-delete regenerable highlights: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("rows affected: %w", err)
	}
	return n, nil
}

// SupersedeRuns marks the given runs superseded (history marker) without deleting
// them — runs that keep surviving interacted highlights stay alive so the FK holds.
func SupersedeRuns(ctx context.Context, db DBTX, runIDs []string, now string) error {
	if len(runIDs) == 0 {
		return nil
	}
	j, err := idsJSON(runIDs)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx,
		`UPDATE pipeline_runs SET superseded_at = ?, updated_at = ?, rev = rev + 1
		 WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND superseded_at IS NULL`,
		now, now, j)
	if err != nil {
		return fmt.Errorf("supersede runs: %w", err)
	}
	return nil
}

// TombstoneEmptyRuns soft-deletes the given runs that have no surviving (non-deleted)
// highlights left — i.e. fully regenerated runs with nothing the user kept.
func TombstoneEmptyRuns(ctx context.Context, db DBTX, runIDs []string, now string) error {
	if len(runIDs) == 0 {
		return nil
	}
	j, err := idsJSON(runIDs)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx,
		`UPDATE pipeline_runs SET deleted_at = ?, updated_at = ?, rev = rev + 1
		 WHERE id IN (SELECT value FROM json_each(?))
		   AND deleted_at IS NULL
		   AND NOT EXISTS (SELECT 1 FROM highlights h WHERE h.pipeline_run_id = pipeline_runs.id AND h.deleted_at IS NULL)`,
		now, now, j)
	if err != nil {
		return fmt.Errorf("tombstone empty runs: %w", err)
	}
	return nil
}

// SoftDeleteJobsByIDs soft-deletes (tombstone + rev bump) the given jobs.
func SoftDeleteJobsByIDs(ctx context.Context, db DBTX, jobIDs []string, now string) error {
	if len(jobIDs) == 0 {
		return nil
	}
	j, err := idsJSON(jobIDs)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx,
		`UPDATE jobs SET deleted_at = ?, updated_at = ?, rev = rev + 1
		 WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`,
		now, now, j)
	if err != nil {
		return fmt.Errorf("soft-delete jobs: %w", err)
	}
	return nil
}

// RegenerateCascade supersedes the given runs and tombstones their regenerable
// highlights (preserving interacted ones), then tombstones any run left empty.
// Shared by the rerun endpoint and the content-change regenerate path.
func RegenerateCascade(ctx context.Context, db DBTX, runIDs []string, now string) error {
	if _, err := SoftDeleteRegenerableHighlights(ctx, db, runIDs, now); err != nil {
		return err
	}
	if err := SupersedeRuns(ctx, db, runIDs, now); err != nil {
		return err
	}
	return TombstoneEmptyRuns(ctx, db, runIDs, now)
}
