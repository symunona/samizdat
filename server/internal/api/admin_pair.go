package api

import (
	"net/http"

	"github.com/symunona/samizdat/server/internal/pair"
	"github.com/symunona/samizdat/server/internal/store"
)

type adminPairHandler struct {
	q          *store.Queries
	serverURLs []string
}

func (h *adminPairHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	code, expiresAt, err := pair.Mint(r.Context(), h.q)
	if err != nil {
		logPair.Errorf("mint pair code: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"code":        code,
		"expires_at":  expiresAt.Format("2006-01-02T15:04:05Z"),
		"server_urls": h.serverURLs,
	})
}
