package api

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

var urlRe = regexp.MustCompile(`https?://[^\s)\]"<>]+`)

type highlightsHandler struct {
	q *store.Queries
}

type highlightWithDoc struct {
	store.Highlight
	DocumentTitle   string            `json:"document_title"`
	DocumentURL     string            `json:"document_url"`
	LinkedDocuments map[string]string `json:"linked_documents,omitempty"`
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
	urlCache := map[string]string{} // canonical_url → document id ("" = not found)
	for _, hl := range rows {
		doc, ok := docCache[hl.DocumentID]
		if !ok {
			doc, _ = h.q.GetDocumentByID(r.Context(), hl.DocumentID)
			docCache[hl.DocumentID] = doc
		}
		urls := urlRe.FindAllString(hl.Body, -1)
		var linked map[string]string
		for _, u := range urls {
			if docID, seen := urlCache[u]; seen {
				if docID != "" {
					if linked == nil {
						linked = map[string]string{}
					}
					linked[u] = docID
				}
				continue
			}
			d, err := h.q.GetDocumentByCanonicalURL(r.Context(), u)
			if err == nil {
				urlCache[u] = d.ID
				if linked == nil {
					linked = map[string]string{}
				}
				linked[u] = d.ID
			} else {
				urlCache[u] = ""
			}
		}
		out = append(out, highlightWithDoc{
			Highlight:       hl,
			DocumentTitle:   doc.Title,
			DocumentURL:     doc.CanonicalUrl,
			LinkedDocuments: linked,
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

func (h *highlightsHandler) patchOne(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var inp struct {
		Pinned *int64 `json:"pinned"`
	}
	if err := json.NewDecoder(r.Body).Decode(&inp); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if inp.Pinned != nil {
		if err := h.q.UpdateHighlightPinned(r.Context(), store.UpdateHighlightPinnedParams{
			Pinned:    *inp.Pinned,
			UpdatedAt: now,
			ID:        id,
		}); err != nil {
			writeErr(w, http.StatusInternalServerError, "update highlight failed")
			return
		}
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
