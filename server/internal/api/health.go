package api

import (
	"net/http"
	"time"
)

const version = "0.1.0"

// Version returns the server version string (for use in main).
func Version() string { return version }

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": version,
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
}
