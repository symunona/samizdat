package api

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"

	"github.com/symunona/samizdat/server/internal/store"
)

type mediaHandler struct {
	q        *store.Queries
	cacheDir string
}

func (h *mediaHandler) serve(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}

	asset, err := h.q.GetMediaAssetByID(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	fullPath := filepath.Join(h.cacheDir, asset.LocalPath)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, fullPath)
}
