package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/store"
)

type tagsHandler struct{ q *store.Queries }

type tagInput struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type tagObjectInput struct {
	TagID string `json:"tag_id"`
}

func (h *tagsHandler) list(w http.ResponseWriter, r *http.Request) {
	rows, err := h.q.ListTagsWithCounts(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if rows == nil {
		rows = []store.ListTagsWithCountsRow{}
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *tagsHandler) create(w http.ResponseWriter, r *http.Request) {
	var inp tagInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if inp.Name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	if inp.Color == "" {
		inp.Color = "default"
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tag, err := h.q.InsertTag(r.Context(), store.InsertTagParams{
		ID:        uuid.New().String(),
		Name:      inp.Name,
		Color:     inp.Color,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, tag)
}

func (h *tagsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeleteTag(r.Context(), store.SoftDeleteTagParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *tagsHandler) listDocumentsByTag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	docs, err := h.q.ListDocumentsByTag(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if docs == nil {
		docs = []store.Document{}
	}
	writeJSON(w, http.StatusOK, docs)
}

func (h *tagsHandler) listAnnotationsByTag(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	anns, err := h.q.ListAnnotationsByTag(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if anns == nil {
		anns = []store.Annotation{}
	}
	writeJSON(w, http.StatusOK, anns)
}

// Document tag handlers

type documentTagsHandler struct{ q *store.Queries }

func (h *documentTagsHandler) list(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	tags, err := h.q.ListTagsByDocument(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if tags == nil {
		tags = []store.Tag{}
	}
	writeJSON(w, http.StatusOK, tags)
}

func (h *documentTagsHandler) add(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	var inp tagObjectInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if inp.TagID == "" {
		writeErr(w, http.StatusBadRequest, "tag_id is required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	dt, err := h.q.InsertDocumentTag(r.Context(), store.InsertDocumentTagParams{
		ID:         uuid.New().String(),
		DocumentID: docID,
		TagID:      inp.TagID,
		CreatedAt:  now,
		UpdatedAt:  now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, dt)
}

func (h *documentTagsHandler) remove(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	tagID := r.PathValue("tag_id")
	if docID == "" || tagID == "" {
		writeErr(w, http.StatusBadRequest, "missing id or tag_id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.DeleteDocumentTag(r.Context(), store.DeleteDocumentTagParams{
		DeletedAt:  &now,
		UpdatedAt:  now,
		DocumentID: docID,
		TagID:      tagID,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Annotation tag handlers

type annotationTagsHandler struct{ q *store.Queries }

func (h *annotationTagsHandler) list(w http.ResponseWriter, r *http.Request) {
	annID := r.PathValue("id")
	if annID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	tags, err := h.q.ListTagsByAnnotation(r.Context(), annID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if tags == nil {
		tags = []store.Tag{}
	}
	writeJSON(w, http.StatusOK, tags)
}

func (h *annotationTagsHandler) add(w http.ResponseWriter, r *http.Request) {
	annID := r.PathValue("id")
	if annID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	var inp tagObjectInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if inp.TagID == "" {
		writeErr(w, http.StatusBadRequest, "tag_id is required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	at, err := h.q.InsertAnnotationTag(r.Context(), store.InsertAnnotationTagParams{
		ID:           uuid.New().String(),
		AnnotationID: annID,
		TagID:        inp.TagID,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, at)
}

func (h *annotationTagsHandler) remove(w http.ResponseWriter, r *http.Request) {
	annID := r.PathValue("id")
	tagID := r.PathValue("tag_id")
	if annID == "" || tagID == "" {
		writeErr(w, http.StatusBadRequest, "missing id or tag_id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.DeleteAnnotationTag(r.Context(), store.DeleteAnnotationTagParams{
		DeletedAt:    &now,
		UpdatedAt:    now,
		AnnotationID: annID,
		TagID:        tagID,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Highlight tag handlers

type highlightTagsHandler struct{ q *store.Queries }

func (h *highlightTagsHandler) list(w http.ResponseWriter, r *http.Request) {
	hlID := r.PathValue("id")
	if hlID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	tags, err := h.q.ListTagsByHighlight(r.Context(), hlID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if tags == nil {
		tags = []store.Tag{}
	}
	writeJSON(w, http.StatusOK, tags)
}

func (h *highlightTagsHandler) add(w http.ResponseWriter, r *http.Request) {
	hlID := r.PathValue("id")
	if hlID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	var inp tagObjectInput
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if inp.TagID == "" {
		writeErr(w, http.StatusBadRequest, "tag_id is required")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	ht, err := h.q.InsertHighlightTag(r.Context(), store.InsertHighlightTagParams{
		ID:          uuid.New().String(),
		HighlightID: hlID,
		TagID:       inp.TagID,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusCreated, ht)
}

func (h *highlightTagsHandler) remove(w http.ResponseWriter, r *http.Request) {
	hlID := r.PathValue("id")
	tagID := r.PathValue("tag_id")
	if hlID == "" || tagID == "" {
		writeErr(w, http.StatusBadRequest, "missing id or tag_id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.DeleteHighlightTag(r.Context(), store.DeleteHighlightTagParams{
		DeletedAt:   &now,
		UpdatedAt:   now,
		HighlightID: hlID,
		TagID:       tagID,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
