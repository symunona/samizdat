package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

type highlightsHandler struct {
	q *store.Queries
}

type highlightWithDoc struct {
	store.Highlight
	DocumentTitle string `json:"document_title"`
	DocumentURL   string `json:"document_url"`
}

func (h *highlightsHandler) listAll(w http.ResponseWriter, r *http.Request) {
	limitStr := r.URL.Query().Get("limit")
	limit := int64(100)
	if limitStr != "" {
		if n, err := strconv.ParseInt(limitStr, 10, 64); err == nil && n > 0 {
			limit = n
		}
	}
	rows, err := h.q.ListHighlights(r.Context(), limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list highlights failed")
		return
	}
	out := make([]highlightWithDoc, 0, len(rows))
	docCache := map[string]store.Document{}
	for _, hl := range rows {
		doc, ok := docCache[hl.DocumentID]
		if !ok {
			doc, _ = h.q.GetDocumentByID(r.Context(), hl.DocumentID)
			docCache[hl.DocumentID] = doc
		}
		out = append(out, highlightWithDoc{
			Highlight:     hl,
			DocumentTitle: doc.Title,
			DocumentURL:   doc.CanonicalUrl,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *highlightsHandler) listByDocument(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	rows, err := h.q.ListHighlightsByDocument(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list highlights failed")
		return
	}
	if rows == nil {
		rows = []store.Highlight{}
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *highlightsHandler) listRunsByDocument(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	rows, err := h.q.ListPipelineRunsByDocument(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list pipeline runs failed")
		return
	}
	if rows == nil {
		rows = []store.PipelineRun{}
	}
	writeJSON(w, http.StatusOK, rows)
}

func (h *highlightsHandler) deleteOne(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeleteHighlight(r.Context(), store.SoftDeleteHighlightParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "delete highlight failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *highlightsHandler) deleteAllByDocument(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	now := time.Now().UTC().Format(time.RFC3339)
	runs, err := h.q.ListPipelineRunsByDocument(r.Context(), docID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "list runs failed")
		return
	}
	for _, run := range runs {
		_ = h.q.SoftDeleteHighlightsByPipelineRun(r.Context(), store.SoftDeleteHighlightsByPipelineRunParams{
			DeletedAt:     &now,
			UpdatedAt:     now,
			PipelineRunID: run.ID,
		})
	}
	_ = h.q.SoftDeletePipelineRunsByDocument(r.Context(), store.SoftDeletePipelineRunsByDocumentParams{
		DeletedAt:  &now,
		UpdatedAt:  now,
		DocumentID: docID,
	})
	w.WriteHeader(http.StatusNoContent)
}
