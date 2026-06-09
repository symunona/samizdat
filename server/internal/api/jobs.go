package api

import (
	"encoding/json"
	"net/http"
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

	payload, _ := json.Marshal(map[string]string{"url": body.URL})
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

// GET /api/v1/jobs — list with optional ?status= and ?kind= query params.
func (h *jobsHandler) list(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	kind := r.URL.Query().Get("kind")

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
	writeJSON(w, http.StatusOK, jobs)
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
