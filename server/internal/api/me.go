package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

func handleMe(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	writeJSON(w, http.StatusOK, map[string]string{
		"device_id":      dev.ID,
		"name":           dev.Name,
		"server_version": version,
	})
}

func handlePatchMe(q *store.Queries) http.HandlerFunc {
	return bearerAuth(q, func(w http.ResponseWriter, r *http.Request) {
		dev := deviceFromCtx(r)
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid json")
			return
		}
		name := strings.TrimSpace(body.Name)
		if name == "" {
			writeErr(w, http.StatusBadRequest, "name required")
			return
		}
		now := time.Now().UTC().Format(time.RFC3339)
		if err := q.UpdateDeviceName(r.Context(), store.UpdateDeviceNameParams{
			Name:      name,
			UpdatedAt: now,
			ID:        dev.ID,
		}); err != nil {
			logAPI.Errorf("update device name: %v", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"device_id":      dev.ID,
			"name":           name,
			"server_version": version,
		})
	})
}
