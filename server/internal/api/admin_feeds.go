package api

import (
	"encoding/json"
	"net/http"

	"github.com/symunona/samizdat/server/internal/extractor"
)

// htmlFetcher is a minimal interface for fetching fully-rendered HTML.
// Satisfied by *worker.Worker via its FetchHTML method.
type htmlFetcher interface {
	FetchHTML(url string) (string, error)
}

type adminFeedsHandler struct {
	reg     extractor.Registry
	browser htmlFetcher
}

// POST /api/v1/admin/feeds/preview
// Body: {url}
// Runs the adapter Discover dry-run and returns the discovered URLs without writing to DB.
func (h *adminFeedsHandler) preview(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if body.URL == "" {
		writeErr(w, http.StatusBadRequest, "url required")
		return
	}

	cfg, ok := h.reg.LookupByURL(body.URL)
	if !ok {
		writeErr(w, http.StatusBadRequest, "no extractor config found for this domain — create extractors/<domain>/feed.yaml first")
		return
	}

	adapter := extractor.AdapterFor(cfg.Kind)
	if adapter == nil {
		writeErr(w, http.StatusBadRequest, "unknown adapter kind: "+cfg.Kind)
		return
	}

	// For html_links we need the browser to render the page first.
	var htmlContent string
	if cfg.Kind == "html_links" {
		var err error
		htmlContent, err = h.browser.FetchHTML(body.URL)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "browser fetch error: "+err.Error())
			return
		}
	}

	urls, err := adapter.Discover(r.Context(), body.URL, cfg, htmlContent)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "discover error: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"url":   body.URL,
		"kind":  cfg.Kind,
		"count": len(urls),
		"urls":  urls,
	})
}
