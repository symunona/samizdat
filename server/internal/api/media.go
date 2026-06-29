package api

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

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
	h.serveFile(w, r, asset.LocalPath)
}

// serveDocAudio streams the audio asset for a video Document (range requests
// supported via http.ServeFile, so native/web players can seek).
func (h *mediaHandler) serveDocAudio(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if docID == "" {
		writeErr(w, http.StatusBadRequest, "missing id")
		return
	}
	asset, err := h.q.GetMediaAssetByDocumentAndKind(r.Context(), store.GetMediaAssetByDocumentAndKindParams{
		DocumentID: docID,
		Kind:       "audio",
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "no audio for document")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	h.serveFile(w, r, asset.LocalPath)
}

func (h *mediaHandler) serveFile(w http.ResponseWriter, r *http.Request, localPath string) {
	fullPath := filepath.Join(h.cacheDir, localPath)
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		writeErr(w, http.StatusNotFound, "file not found")
		return
	}
	w.Header().Set("Content-Type", contentTypeFor(fullPath))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, fullPath)
}

func contentTypeFor(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".m4a", ".mp4", ".aac":
		return "audio/mp4"
	case ".mp3":
		return "audio/mpeg"
	case ".webm", ".opus":
		return "audio/webm"
	case ".png":
		return "image/png"
	default:
		return "image/jpeg"
	}
}
