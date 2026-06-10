package api

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

func handleListDevices(q *store.Queries) http.HandlerFunc {
	return bearerAuth(q, func(w http.ResponseWriter, r *http.Request) {
		current := deviceFromCtx(r)

		devices, err := q.ListDevices(r.Context())
		if err != nil {
			logDevs.Errorf("list devices: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}

		type deviceView struct {
			ID         string  `json:"id"`
			Name       string  `json:"name"`
			CreatedAt  string  `json:"created_at"`
			LastSeenAt *string `json:"last_seen_at"`
		}

		views := make([]deviceView, 0, len(devices))
		for _, d := range devices {
			views = append(views, deviceView{
				ID:         d.ID,
				Name:       d.Name,
				CreatedAt:  d.CreatedAt,
				LastSeenAt: d.LastSeenAt,
			})
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"devices":           views,
			"current_device_id": current.ID,
		})
	})
}

func handleRevokeDevice(q *store.Queries) http.HandlerFunc {
	return bearerAuth(q, func(w http.ResponseWriter, r *http.Request) {
		current := deviceFromCtx(r)
		id := r.PathValue("id")
		if id == "" {
			writeErr(w, http.StatusBadRequest, "id required")
			return
		}
		if id == current.ID {
			writeErr(w, http.StatusBadRequest, "cannot revoke your own device")
			return
		}

		_, err := q.GetDevice(r.Context(), id)
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusNotFound, "device not found")
			return
		}
		if err != nil {
			logDevs.Errorf("get device %s: %v", id, err)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}

		maxRev, err := q.MaxDeviceRev(r.Context())
		if err != nil {
			logDevs.Errorf("max device rev: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}
		var nextRev int64
		if v, ok := maxRev.(int64); ok {
			nextRev = v + 1
		} else {
			nextRev = 1
		}

		now := time.Now().UTC().Format(time.RFC3339)
		err = q.SoftDeleteDevice(r.Context(), store.SoftDeleteDeviceParams{
			DeletedAt: &now,
			UpdatedAt: now,
			Rev:       nextRev,
			ID:        id,
		})
		if err != nil {
			logDevs.Errorf("soft delete device %s: %v", id, err)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}

		w.WriteHeader(http.StatusNoContent)
	})
}
