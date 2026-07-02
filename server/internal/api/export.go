package api

import (
	"net/http"

	"github.com/symunona/samizdat/server/internal/export"
)

// exportHandler surfaces auto-export stats. When export is disabled, exp is nil
// and the handler reports {enabled:false}.
type exportHandler struct {
	exp *export.Exporter
}

// GET /api/v1/export/stats — also triggers an immediate sweep so a page refresh
// mirrors the latest DB state without waiting for the next tick.
func (h *exportHandler) stats(w http.ResponseWriter, r *http.Request) {
	if h.exp == nil {
		writeJSON(w, http.StatusOK, export.Stats{Enabled: false})
		return
	}
	h.exp.Refresh(r.Context())
	writeJSON(w, http.StatusOK, h.exp.Snapshot())
}
