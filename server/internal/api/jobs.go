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
