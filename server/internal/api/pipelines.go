package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

type pipelinesHandler struct {
	q *store.Queries
}

func (h *pipelinesHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.q.ListPipelines(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list pipelines failed")
		return
	}
	if rows == nil {
		rows = []store.Pipeline{}
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *pipelinesHandler) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	row, err := h.q.GetPipeline(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "pipeline not found")
		return
	}
	writeJSON(w, http.StatusOK, row)
}

type createPipelineRequest struct {
	Name    string `json:"name"`
	Enabled *bool  `json:"enabled"`
	Trigger string `json:"trigger"`
	Filter  string `json:"filter"`
	Steps   string `json:"steps"`
}

func (h *pipelinesHandler) create(w http.ResponseWriter, r *http.Request) {
	var req createPipelineRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "name required")
		return
	}
	if req.Trigger == "" {
		req.Trigger = "on_new_document"
	}
	if req.Filter == "" {
		req.Filter = "{}"
	}
	if req.Steps == "" {
		req.Steps = "[]"
	}
	enabled := int64(1)
	if req.Enabled != nil && !*req.Enabled {
		enabled = 0
	}

	now := time.Now().UTC().Format(time.RFC3339)
	row, err := h.q.InsertPipeline(r.Context(), store.InsertPipelineParams{
		ID:        uuid.NewString(),
		Name:      req.Name,
		Enabled:   enabled,
		Trigger:   req.Trigger,
		Filter:    req.Filter,
		Steps:     req.Steps,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "create pipeline failed")
		return
	}
	w.WriteHeader(http.StatusCreated)
	writeJSON(w, http.StatusOK, row)
}

func (h *pipelinesHandler) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	existing, err := h.q.GetPipeline(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "pipeline not found")
		return
	}

	var req createPipelineRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	if req.Name == "" {
		req.Name = existing.Name
	}
	if req.Trigger == "" {
		req.Trigger = existing.Trigger
	}
	if req.Filter == "" {
		req.Filter = existing.Filter
	}
	if req.Steps == "" {
		req.Steps = existing.Steps
	}
	enabled := existing.Enabled
	if req.Enabled != nil {
		if *req.Enabled {
			enabled = 1
		} else {
			enabled = 0
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.UpdatePipeline(r.Context(), store.UpdatePipelineParams{
		Name:      req.Name,
		Enabled:   enabled,
		Trigger:   req.Trigger,
		Filter:    req.Filter,
		Steps:     req.Steps,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "update pipeline failed")
		return
	}

	updated, _ := h.q.GetPipeline(r.Context(), id)
	writeJSON(w, http.StatusOK, updated)
}

func (h *pipelinesHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := h.q.GetPipeline(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "pipeline not found")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeletePipeline(r.Context(), store.SoftDeletePipelineParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete pipeline failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type runPipelineRequest struct {
	DocumentID string `json:"document_id"`
}

func (h *pipelinesHandler) run(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := h.q.GetPipeline(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, "pipeline not found")
		return
	}
	var req runPipelineRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DocumentID == "" {
		writeErr(w, http.StatusBadRequest, "document_id required")
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	payload, _ := json.Marshal(map[string]string{
		"pipeline_id": id,
		"document_id": req.DocumentID,
	})
	job, err := h.q.InsertJob(r.Context(), store.InsertJobParams{
		ID:        uuid.NewString(),
		Kind:      "run_pipeline",
		Payload:   string(payload),
		RunAfter:  now,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "enqueue failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"job_id": job.ID})
}
