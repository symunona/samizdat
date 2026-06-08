package api

import (
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
