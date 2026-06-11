package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

type jobsHandler struct{ q *store.Queries }

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
	writeJSON(w, http.StatusOK, job)
}

type jobsPageResponse struct {
	Items   []store.Job `json:"items"`
	Total   int64       `json:"total"`
	HasMore bool        `json:"has_more"`
	Offset  int64       `json:"offset"`
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

	// Paginated path
	limit, _ := strconv.ParseInt(limitStr, 10, 64)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset, _ := strconv.ParseInt(offsetStr, 10, 64)
	if offset < 0 {
		offset = 0
	}

	var (
		jobs  []store.Job
		total int64
		err   error
	)
	switch {
	case status != "" && kind != "":
		jobs, err = h.q.ListJobsByStatusAndKindPage(r.Context(), store.ListJobsByStatusAndKindPageParams{
			Status: status, Kind: kind, Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountJobsByStatusAndKind(r.Context(), store.CountJobsByStatusAndKindParams{
				Status: status, Kind: kind,
			})
		}
	case status != "":
		jobs, err = h.q.ListJobsByStatusPage(r.Context(), store.ListJobsByStatusPageParams{
			Status: status, Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountJobsByStatus(r.Context(), status)
		}
	case kind != "":
		jobs, err = h.q.ListJobsByKindPage(r.Context(), store.ListJobsByKindPageParams{
			Kind: kind, Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountJobsByKind(r.Context(), kind)
		}
	default:
		jobs, err = h.q.ListJobsPage(r.Context(), store.ListJobsPageParams{
			Limit: limit, Offset: offset,
		})
		if err == nil {
			total, err = h.q.CountJobs(r.Context())
		}
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if jobs == nil {
		jobs = []store.Job{}
	}
	writeJSON(w, http.StatusOK, jobsPageResponse{
		Items:   jobs,
		Total:   total,
		HasMore: offset+int64(len(jobs)) < total,
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
