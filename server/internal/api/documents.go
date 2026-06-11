package api

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

type documentsHandler struct{ q *store.Queries }

type documentListItem struct {
	store.Document
	AnnotationCount interface{} `json:"annotation_count"`
	HighlightCount  interface{} `json:"highlight_count"`
}

func (h *documentsHandler) list(w http.ResponseWriter, r *http.Request) {
	feedID := r.URL.Query().Get("feed_id")
	if feedID != "" {
		docs, err := h.q.ListDocumentsByFeed(r.Context(), &feedID)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		if docs == nil {
			docs = []store.Document{}
		}
		writeJSON(w, http.StatusOK, docs)
		return
	}

	rows, err := h.q.ListDocumentsWithAnnotationCount(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	items := make([]documentListItem, len(rows))
	for i, row := range rows {
		items[i] = documentListItem{
			Document: store.Document{
				ID:           row.ID,
				CanonicalUrl: row.CanonicalUrl,
				Title:        row.Title,
				Markdown:     row.Markdown,
				FetchedAt:    row.FetchedAt,
				Excerpt:      row.Excerpt,
				HeroImageUrl: row.HeroImageUrl,
				Author:       row.Author,
				SourceFeedID: row.SourceFeedID,
				CreatedAt:    row.CreatedAt,
				UpdatedAt:    row.UpdatedAt,
				Rev:          row.Rev,
				DeletedAt:    row.DeletedAt,
			},
			AnnotationCount: row.AnnotationCount,
			HighlightCount:  row.HighlightCount,
		}
	}
	if items == nil {
		items = []documentListItem{}
	}
	writeJSON(w, http.StatusOK, items)
}

func (h *documentsHandler) get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	doc, err := h.q.GetDocumentByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *documentsHandler) delete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if err := h.q.SoftDeleteDocument(r.Context(), store.SoftDeleteDocumentParams{
		DeletedAt: &now,
		UpdatedAt: now,
		ID:        id,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *documentsHandler) lookupByURL(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}
	doc, err := h.q.GetDocumentByCanonicalURL(r.Context(), rawURL)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (h *documentsHandler) listMedia(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	assets, err := h.q.ListMediaAssetsByDocument(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if assets == nil {
		assets = []store.MediaAsset{}
	}
	writeJSON(w, http.StatusOK, assets)
}
