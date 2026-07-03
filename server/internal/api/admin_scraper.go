package api

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/symunona/samizdat/server/internal/extractor"
)

// scraperLoginer performs a headless form login for a paywalled domain and
// persists the session jar. Satisfied by *worker.Worker.
type scraperLoginer interface {
	Login(auth extractor.AuthConfig, user, pass, statePath string) (string, error)
}

type adminScraperHandler struct {
	reg      extractor.Registry
	login    scraperLoginer
	cacheDir string
}

// POST /api/v1/admin/scraper/login  (loopback-only)
// Body: {domain, username, password}
// Logs in via the domain's feed.yaml auth block and persists the session jar.
// Credentials are used once for the login and never stored — only the resulting
// cookie jar is kept.
func (h *adminScraperHandler) loginDomain(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Domain   string `json:"domain"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	body.Domain = strings.ToLower(strings.TrimSpace(body.Domain))
	if body.Domain == "" || body.Username == "" || body.Password == "" {
		writeErr(w, http.StatusBadRequest, "domain, username, password required")
		return
	}

	cfg, ok := h.reg[body.Domain]
	if !ok {
		writeErr(w, http.StatusBadRequest, "no extractor config for "+body.Domain+" — create extractors/"+body.Domain+"/feed.yaml first")
		return
	}
	if cfg.Auth == nil {
		writeErr(w, http.StatusBadRequest, "no auth block in extractors/"+body.Domain+"/feed.yaml")
		return
	}

	statePath := extractor.AuthStatePath(h.cacheDir, body.Domain)
	detail, err := h.login.Login(*cfg.Auth, body.Username, body.Password, statePath)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "domain": body.Domain, "detail": detail})
}
