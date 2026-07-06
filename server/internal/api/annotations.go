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

type annotationsHandler struct{ q *store.Queries }

type annotationInput struct {
	Exact       string  `json:"exact"`
	Prefix      string  `json:"prefix"`
	Suffix      string  `json:"suffix"`
	PosStart    int64   `json:"pos_start"`
	PosEnd      int64   `json:"pos_end"`
	MediaTsMs   int64   `json:"media_ts_ms"`
	Color       string  `json:"color"`
	Note        string  `json:"note"`
	HighlightID *string `json:"highlight_id"`
}

type annotationUpdateInput struct {
	Note  string `json:"note"`
	Color string `json:"color"`
}

func (h *annotationsHandler) list(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	anns, err := h.q.ListAnnotationsByDocument(r.Context(), &docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if anns == nil {
		anns = []store.Annotation{}
	}
	writeJSON(w, http.StatusOK, anns)
}

func (h *annotationsHandler) create(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	var inp annotationInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	// A note-only annotation (generic note about the whole document, untimed and
	// unanchored) has empty exact — allow it as long as it carries a note body.
	// Only reject an annotation that anchors to nothing AND says nothing.
	if inp.Exact == "" && inp.Note == "" {
		writeErr(w, http.StatusBadRequest, "exact or note is required")
		return
	}
	ann, err := h.insert(r.Context(), &docID, inp)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, ann)
}

// createStandalone creates a standalone note (POST /api/v1/annotations): an
// annotation with no parent Document (document_id NULL) and no anchor. The body
// carries just note + optional color, reusing the annotation storage/sync/tagging
// surface.
func (h *annotationsHandler) createStandalone(w http.ResponseWriter, r *http.Request) {
	var inp annotationInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if inp.Note == "" {
		writeErr(w, http.StatusBadRequest, "note is required")
		return
	}
	// A standalone note is unanchored: force-clear any anchor fields a client sends.
	inp.Exact, inp.Prefix, inp.Suffix, inp.PosStart, inp.PosEnd, inp.HighlightID = "", "", "", 0, 0, nil
	ann, err := h.insert(r.Context(), nil, inp)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, ann)
}

// insert writes an annotation row; docID is nil for a standalone note.
func (h *annotationsHandler) insert(ctx context.Context, docID *string, inp annotationInput) (store.Annotation, error) {
	if inp.Color == "" {
		inp.Color = "yellow"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ann, err := h.q.InsertAnnotation(ctx, store.InsertAnnotationParams{
		ID:          uuid.New().String(),
		DocumentID:  docID,
		HighlightID: inp.HighlightID,
		Exact:       inp.Exact,
		Prefix:      inp.Prefix,
		Suffix:      inp.Suffix,
		PosStart:    inp.PosStart,
		PosEnd:      inp.PosEnd,
		MediaTsMs:   inp.MediaTsMs,
		Color:       inp.Color,
		Note:        inp.Note,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
	if err != nil {
		return ann, fmt.Errorf("insert annotation: %w", err)
	}
	return ann, nil
}

func (h *annotationsHandler) update(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	var inp annotationUpdateInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.UpdateAnnotation(r.Context(), store.UpdateAnnotationParams{
		Note:      inp.Note,
		Color:     inp.Color,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	ann, err := h.q.GetAnnotation(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, ann)
}

func (h *annotationsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeleteAnnotation(r.Context(), store.SoftDeleteAnnotationParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
