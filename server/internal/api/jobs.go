package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

type jobsHandler struct {
	q  *store.Queries
	db *sql.DB
}

func (h *jobsHandler) create(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Kind string `json:"kind"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.Kind == "" {
		body.Kind = "scrape_url"
	}
	if body.Kind != "scrape_url" {
		writeErr(w, http.StatusBadRequest, "unsupported kind")
		return
	}
	if body.URL == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}

	dev := deviceFromCtx(r)
	payload, _ := json.Marshal(map[string]string{
		"url":         body.URL,
		"device_id":   dev.ID,
		"device_name": dev.Name,
	})
	now := time.Now().UTC().Format(time.RFC3339)

	job, err := h.q.InsertJob(r.Context(), store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      body.Kind,
		Payload:   string(payload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"job_id": job.ID})
}

// listDescendants fetches all descendants (recursive) of the given root job IDs.
// When includeDeleted is true, tombstoned (superseded) descendants are included too.
func (h *jobsHandler) listDescendants(r *http.Request, rootIDs []string, includeDeleted bool) ([]store.Job, error) {
	if len(rootIDs) == 0 {
		return nil, nil
	}
	idsJSON, err := json.Marshal(rootIDs)
	if err != nil {
		return nil, fmt.Errorf("marshal root ids: %w", err)
	}
	delFilter := "AND j.deleted_at IS NULL"
	if includeDeleted {
		delFilter = ""
	}
	qry := `
		WITH RECURSIVE desc AS (
			SELECT j.* FROM jobs j, json_each(?) r
			WHERE j.parent_job_id = r.value ` + delFilter + `
			UNION ALL
			SELECT j.* FROM jobs j JOIN desc d ON j.parent_job_id = d.id WHERE 1=1 ` + delFilter + `
		)
		SELECT id, kind, payload, status, attempts, run_after, last_error, result,
		       duration_ms, created_at, updated_at, rev, deleted_at, parent_job_id
		FROM desc ORDER BY updated_at DESC
	`
	rows, err := h.db.QueryContext(r.Context(), qry, string(idsJSON))
	if err != nil {
		return nil, fmt.Errorf("query descendants: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var jobs []store.Job
	for rows.Next() {
		var j store.Job
		if err := rows.Scan(
			&j.ID, &j.Kind, &j.Payload, &j.Status, &j.Attempts, &j.RunAfter,
			&j.LastError, &j.Result, &j.DurationMs, &j.CreatedAt, &j.UpdatedAt, &j.Rev,
			&j.DeletedAt, &j.ParentJobID,
		); err != nil {
			return nil, fmt.Errorf("scan job: %w", err)
		}
		jobs = append(jobs, j)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate descendants: %w", err)
	}
	return jobs, nil
}

// subtreeJobIDs returns the rooted subtree of job ids: the node itself plus all
// of its non-deleted descendants (recursive over parent_job_id).
func (h *jobsHandler) subtreeJobIDs(ctx context.Context, rootID string) ([]string, error) {
	const qry = `
		WITH RECURSIVE sub AS (
			SELECT id FROM jobs WHERE id = ?
			UNION ALL
			SELECT j.id FROM jobs j JOIN sub s ON j.parent_job_id = s.id WHERE j.deleted_at IS NULL
		)
		SELECT id FROM sub`
	rows, err := h.db.QueryContext(ctx, qry, rootID)
	if err != nil {
		return nil, fmt.Errorf("query subtree: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan job id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate subtree: %w", err)
	}
	return ids, nil
}

// rerun tombstones a job node's whole descendant subtree (jobs + their
// pipeline_runs + regenerable highlights), preserving user-interacted highlights,
// then re-enqueues a fresh forced equivalent of the node. All in one transaction.
func (h *jobsHandler) rerun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	ctx := r.Context()
	node, err := h.q.GetJob(ctx, id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}

	jobIDs, err := h.subtreeJobIDs(ctx, id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Fresh payload = node payload with force=true (bypass the skip guard).
	var payload map[string]any
	if json.Unmarshal([]byte(node.Payload), &payload) != nil || payload == nil {
		payload = map[string]any{}
	}
	payload["force"] = true
	freshPayload, _ := json.Marshal(payload)

	now := time.Now().UTC().Format(time.RFC3339)
	newJobID := uuid.NewString()

	tx, err := h.db.BeginTx(ctx, nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	runIDs, err := store.RunIDsByJobIDs(ctx, tx, jobIDs)
	if err == nil {
		err = store.RegenerateCascade(ctx, tx, runIDs, now)
	}
	if err == nil {
		err = store.SoftDeleteJobsByIDs(ctx, tx, jobIDs, now)
	}
	if err == nil {
		_, err = store.New(tx).InsertJob(ctx, store.InsertJobParams{
			ID:          newJobID,
			Kind:        node.Kind,
			Payload:     string(freshPayload),
			RunAfter:    now,
			CreatedAt:   now,
			UpdatedAt:   now,
			ParentJobID: node.ParentJobID,
		})
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	committed = true

	writeJSON(w, http.StatusAccepted, map[string]string{"job_id": newJobID})
}

// jobLLMUsage is the per-(provider,model) LLM spend attributed to a job.
type jobLLMUsage struct {
	Provider     string  `json:"provider"`
	Model        string  `json:"model"`
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd"`
}

type jobWithCost struct {
	store.Job
	LLM        []jobLLMUsage `json:"llm,omitempty"`
	LLMCostUSD float64       `json:"llm_cost_usd"`
}

// usageByJobs returns LLM usage grouped per job_id for the given job IDs, with
// cost estimated per (provider, model) row.
func (h *jobsHandler) usageByJobs(r *http.Request, ids []string) (map[string][]jobLLMUsage, error) {
	out := map[string][]jobLLMUsage{}
	if len(ids) == 0 {
		return out, nil
	}
	idsJSON, err := json.Marshal(ids)
	if err != nil {
		return nil, fmt.Errorf("marshal job ids: %w", err)
	}
	const qry = `
		SELECT job_id, provider, model,
		       COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0)
		FROM llm_usages
		WHERE job_id IN (SELECT value FROM json_each(?))
		GROUP BY job_id, provider, model`
	rows, err := h.db.QueryContext(r.Context(), qry, string(idsJSON))
	if err != nil {
		return nil, fmt.Errorf("query llm usages: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var jid string
		var u jobLLMUsage
		if err := rows.Scan(&jid, &u.Provider, &u.Model, &u.InputTokens, &u.OutputTokens); err != nil {
			return nil, fmt.Errorf("scan llm usage: %w", err)
		}
		u.CostUSD = llm.EstimateCost(u.Model, int(u.InputTokens), int(u.OutputTokens))
		out[jid] = append(out[jid], u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate llm usages: %w", err)
	}
	return out, nil
}

// wrapJobs attaches LLM usage + total cost to each job for API responses.
func wrapJobs(jobs []store.Job, usage map[string][]jobLLMUsage) []jobWithCost {
	out := make([]jobWithCost, len(jobs))
	for i, j := range jobs {
		u := usage[j.ID]
		var cost float64
		for _, x := range u {
			cost += x.CostUSD
		}
		out[i] = jobWithCost{Job: j, LLM: u, LLMCostUSD: cost}
	}
	return out
}

// GET /api/v1/jobs/:id — get single job by ID.
func (h *jobsHandler) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	job, err := h.q.GetJob(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	usage, err := h.usageByJobs(r, []string{id})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, wrapJobs([]store.Job{job}, usage)[0])
}

type jobsPageResponse struct {
	Items   []jobWithCost `json:"items"`
	Total   int64         `json:"total"` // count of root jobs only
	HasMore bool          `json:"has_more"`
	Offset  int64         `json:"offset"` // offset into root jobs
	Limit   int64         `json:"limit"`
}

// GET /api/v1/jobs — list with optional ?status= ?kind= ?limit= ?offset= query params.
// When limit is provided the response is paginated; otherwise legacy flat array.
func (h *jobsHandler) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	kind := q.Get("kind")
	limitStr := q.Get("limit")
	offsetStr := q.Get("offset")

	// Legacy (no pagination params) — return flat array for backwards compat
	if limitStr == "" && offsetStr == "" {
		var (
			jobs []store.Job
			err  error
		)
		switch {
		case status != "" && kind != "":
			jobs, err = h.q.ListJobsByStatusAndKind(r.Context(), store.ListJobsByStatusAndKindParams{
				Status: status,
				Kind:   kind,
			})
		case status != "":
			jobs, err = h.q.ListJobsByStatus(r.Context(), status)
		case kind != "":
			jobs, err = h.q.ListJobsByKind(r.Context(), kind)
		default:
			jobs, err = h.q.ListJobs(r.Context())
		}
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		if jobs == nil {
			jobs = []store.Job{}
		}
		ids := make([]string, len(jobs))
		for i, j := range jobs {
			ids[i] = j.ID
		}
		usage, err := h.usageByJobs(r, ids)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, wrapJobs(jobs, usage))
		return
	}

	// Paginated path — paginate by root jobs only, then attach all descendants.
	limit, _ := strconv.ParseInt(limitStr, 10, 64)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset, _ := strconv.ParseInt(offsetStr, 10, 64)
	if offset < 0 {
		offset = 0
	}

	inclSuperseded := q.Get("include_superseded") == "true"

	var (
		roots []store.Job
		total int64
		err   error
	)
	switch {
	case inclSuperseded:
		// History view: include tombstoned (superseded) roots + subtrees.
		roots, err = h.q.ListRootJobsPageInclDeleted(r.Context(), store.ListRootJobsPageInclDeletedParams{
			Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountRootJobsInclDeleted(r.Context())
		}
	case status != "" && kind != "":
		roots, err = h.q.ListRootJobsByStatusAndKindPage(r.Context(), store.ListRootJobsByStatusAndKindPageParams{
			Status: status, Kind: kind, Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountRootJobsByStatusAndKind(r.Context(), store.CountRootJobsByStatusAndKindParams{
				Status: status, Kind: kind,
			})
		}
	case status != "":
		roots, err = h.q.ListRootJobsByStatusPage(r.Context(), store.ListRootJobsByStatusPageParams{
			Status: status, Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountRootJobsByStatus(r.Context(), status)
		}
	case kind != "":
		roots, err = h.q.ListRootJobsByKindPage(r.Context(), store.ListRootJobsByKindPageParams{
			Kind: kind, Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountRootJobsByKind(r.Context(), kind)
		}
	default:
		roots, err = h.q.ListRootJobsPage(r.Context(), store.ListRootJobsPageParams{
			Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountRootJobs(r.Context())
		}
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Collect all root IDs and fetch their full descendant subtrees.
	rootIDs := make([]string, len(roots))
	for i, j := range roots {
		rootIDs[i] = j.ID
	}
	descendants, err := h.listDescendants(r, rootIDs, inclSuperseded)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Return roots first, then descendants (flat); client buildTree re-assembles.
	flat := make([]store.Job, 0, len(roots)+len(descendants))
	flat = append(flat, roots...)
	flat = append(flat, descendants...)

	allIDs := make([]string, len(flat))
	for i, j := range flat {
		allIDs[i] = j.ID
	}
	usage, err := h.usageByJobs(r, allIDs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	writeJSON(w, http.StatusOK, jobsPageResponse{
		Items:   wrapJobs(flat, usage),
		Total:   total,
		HasMore: offset+int64(len(roots)) < total,
		Offset:  offset,
		Limit:   limit,
	})
}

// POST /api/v1/jobs/{id}/retry — reset status=queued, attempts=0, run_after=now.
func (h *jobsHandler) retry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.RetryJob(r.Context(), store.RetryJobParams{
		RunAfter:  now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "queued"})
}

// DELETE /api/v1/jobs — soft-delete all done/dead/queued jobs.
func (h *jobsHandler) clearCompleted(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := h.q.ClearCompletedJobs(r.Context(), store.ClearCompletedJobsParams{
		DeletedAt: &now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"cleared": n})
}

// POST /api/v1/jobs/{id}/resume — set paused job back to queued.
func (h *jobsHandler) resume(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.ResumeJob(r.Context(), store.ResumeJobParams{
		RunAfter:  now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "queued"})
}

// POST /api/v1/jobs/resume-all — set all paused jobs back to queued.
func (h *jobsHandler) resumeAll(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.ResumeAllPausedJobs(r.Context(), store.ResumeAllPausedJobsParams{
		RunAfter:  now,
		UpdatedAt: now,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// DELETE /api/v1/jobs/queued — soft-delete all queued jobs.
func (h *jobsHandler) clearQueued(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := h.q.ClearQueuedJobs(r.Context(), store.ClearQueuedJobsParams{
		DeletedAt: &now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]int64{"cleared": n})
}

// DELETE /api/v1/jobs/{id} — soft delete.
func (h *jobsHandler) softDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "id required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeleteJob(r.Context(), store.SoftDeleteJobParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
