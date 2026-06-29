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
	anns, err := h.q.ListAnnotationsByDocument(r.Context(), docID)
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
	if inp.Exact == "" {
		writeErr(w, http.StatusBadRequest, "exact is required")
		return
	}
	if inp.Color == "" {
		inp.Color = "yellow"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ann, err := h.q.InsertAnnotation(r.Context(), store.InsertAnnotationParams{
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
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, ann)
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
