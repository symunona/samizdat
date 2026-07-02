package api

import (
	"net/http"
	"time"
)

const version = "0.1.0"

// commit and buildTime are stamped at build time via `-ldflags -X` (see the
// build-server just recipe). They let a running server report exactly which
// code it is executing, so staleness is detectable from outside — `just status`
// compares /health's commit to `git rev-parse HEAD`. The defaults apply to a
// bare `go build`/`go run` with no ldflags.
var (
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
