package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

type readStatesHandler struct{ q *store.Queries }

// progress reads this device's article scroll (per-device) plus the freshest
// playback position across ALL devices (cross-device video/audio resume).
func (h *readStatesHandler) progress(ctx context.Context, deviceID, docID string) (scrollY float64, mediaPosMs int64, err error) {
	rs, err := h.q.GetReadState(ctx, store.GetReadStateParams{DeviceID: deviceID, DocumentID: docID})
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, 0, fmt.Errorf("get read state: %w", err)
	}
	scrollY = rs.ScrollY
	mediaPosMs, err = h.q.GetMediaPosition(ctx, docID)
	if errors.Is(err, sql.ErrNoRows) {
		return scrollY, 0, nil
	}
	if err != nil {
		return 0, 0, fmt.Errorf("get media position: %w", err)
	}
	return scrollY, mediaPosMs, nil
}

func (h *readStatesHandler) get(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	scrollY, mediaPosMs, err := h.progress(r.Context(), dev.ID, docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scroll_y": scrollY, "media_pos_ms": mediaPosMs})
}

func (h *readStatesHandler) put(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	// Patch-style: article scroll and video playback position arrive from different
	// callers. Pointers let us upsert only the field(s) present so one never zeroes
	// the other in the shared (device_id, document_id) row.
	var body struct {
		ScrollY    *float64 `json:"scroll_y"`
		MediaPosMs *int64   `json:"media_pos_ms"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if body.ScrollY != nil {
		if _, err := h.q.UpsertReadState(r.Context(), store.UpsertReadStateParams{
			ID:         uuid.NewString(),
			DeviceID:   dev.ID,
			DocumentID: docID,
			ScrollY:    *body.ScrollY,
			CreatedAt:  now,
			UpdatedAt:  now,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	if body.MediaPosMs != nil {
		if _, err := h.q.UpsertMediaPosition(r.Context(), store.UpsertMediaPositionParams{
			ID:         uuid.NewString(),
			DeviceID:   dev.ID,
			DocumentID: docID,
			MediaPosMs: *body.MediaPosMs,
			CreatedAt:  now,
			UpdatedAt:  now,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	scrollY, mediaPosMs, err := h.progress(r.Context(), dev.ID, docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scroll_y": scrollY, "media_pos_ms": mediaPosMs})
}
