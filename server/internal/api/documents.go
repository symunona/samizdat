package api

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/symunona/samizdat/server/internal/store"
)

type documentsHandler struct{ q *store.Queries }

func (h *documentsHandler) list(w http.ResponseWriter, r *http.Request) {
	docs, err := h.q.ListDocuments(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, docs)
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
