package api

import (
	"net/http"
	"time"
)

// version, commit and buildTime are stamped at build time via `-ldflags -X`
// (see the build-server just recipe). version tracks the single product version
// from app/app.json (`expo.version`), so server and app report the same number;
// commit + buildTime let a running server report exactly which code it is
// executing, so staleness is detectable from outside — `just status` compares
// /health's commit to `git rev-parse HEAD`. The defaults apply to a bare
// `go build`/`go run` with no ldflags.
var (
	version   = "0.0.0-dev"
	commit    = "unknown"
	buildTime = "unknown"
)

// Version returns the server version string (for the startup log).
func Version() string { return version }

// Build returns the stamped commit (for the startup log).
func Build() string { return commit }

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"app":      "samizdat",
		"status":   "ok",
		"version":  version,
		"commit":   commit,
		"built_at": buildTime,
		"time":     time.Now().UTC().Format(time.RFC3339),
	})
}
