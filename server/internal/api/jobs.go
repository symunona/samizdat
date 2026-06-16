package api

import (
	"database/sql"
	"encoding/json"
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
func (h *jobsHandler) listDescendants(r *http.Request, rootIDs []string) ([]store.Job, error) {
	if len(rootIDs) == 0 {
		return nil, nil
	}
	idsJSON, err := json.Marshal(rootIDs)
	if err != nil {
		return nil, err
	}
	const qry = `
		WITH RECURSIVE desc AS (
			SELECT j.* FROM jobs j, json_each(?) r
			WHERE j.parent_job_id = r.value AND j.deleted_at IS NULL
			UNION ALL
			SELECT j.* FROM jobs j JOIN desc d ON j.parent_job_id = d.id WHERE j.deleted_at IS NULL
		)
		SELECT id, kind, payload, status, attempts, run_after, last_error, result,
		       created_at, updated_at, rev, deleted_at, parent_job_id
		FROM desc ORDER BY updated_at DESC
	`
	rows, err := h.db.QueryContext(r.Context(), qry, string(idsJSON))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var jobs []store.Job
	for rows.Next() {
		var j store.Job
		if err := rows.Scan(
			&j.ID, &j.Kind, &j.Payload, &j.Status, &j.Attempts, &j.RunAfter,
			&j.LastError, &j.Result, &j.CreatedAt, &j.UpdatedAt, &j.Rev,
			&j.DeletedAt, &j.ParentJobID,
		); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

type jobWithCost struct {
	store.Job
	LLMCostUSD float64 `json:"llm_cost_usd"`
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
	usageRows, _ := h.q.GetLLMUsageByJob(r.Context(), &id)
	var costUSD float64
	for _, row := range usageRows {
		in := toInt64(row.InputTokens)
		out := toInt64(row.OutputTokens)
		costUSD += llm.EstimateCost(row.Model, int(in), int(out))
	}
	writeJSON(w, http.StatusOK, jobWithCost{Job: job, LLMCostUSD: costUSD})
}

type jobsPageResponse struct {
	Items   []store.Job `json:"items"`
	Total   int64       `json:"total"`  // count of root jobs only
	HasMore bool        `json:"has_more"`
	Offset  int64       `json:"offset"` // offset into root jobs
	Limit   int64       `json:"limit"`
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
		writeJSON(w, http.StatusOK, jobs)
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

	var (
		roots []store.Job
		total int64
		err   error
	)
	switch {
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
	descendants, err := h.listDescendants(r, rootIDs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Return roots first, then descendants (flat); client buildTree re-assembles.
	items := make([]store.Job, 0, len(roots)+len(descendants))
	items = append(items, roots...)
	items = append(items, descendants...)

	writeJSON(w, http.StatusOK, jobsPageResponse{
		Items:   items,
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
