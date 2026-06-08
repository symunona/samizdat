package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

type readStatesHandler struct{ q *store.Queries }

func (h *readStatesHandler) get(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	rs, err := h.q.GetReadState(r.Context(), store.GetReadStateParams{
		DeviceID:   dev.ID,
		DocumentID: docID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scroll_y": rs.ScrollY})
}

func (h *readStatesHandler) put(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	var body struct {
		ScrollY float64 `json:"scroll_y"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	rs, err := h.q.UpsertReadState(r.Context(), store.UpsertReadStateParams{
		ID:         uuid.NewString(),
		DeviceID:   dev.ID,
		DocumentID: docID,
		ScrollY:    body.ScrollY,
		CreatedAt:  now,
		UpdatedAt:  now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scroll_y": rs.ScrollY})
}
