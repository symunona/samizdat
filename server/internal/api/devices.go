package api

import (
	"log"
	"net/http"

	"github.com/symunona/samizdat/server/internal/store"
)

func handleListDevices(q *store.Queries) http.HandlerFunc {
	return bearerAuth(q, func(w http.ResponseWriter, r *http.Request) {
		current := deviceFromCtx(r)

		devices, err := q.ListDevices(r.Context())
		if err != nil {
			log.Printf("list devices: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}

		type deviceView struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"created_at"`
		}

		views := make([]deviceView, 0, len(devices))
		for _, d := range devices {
			views = append(views, deviceView{
				ID:        d.ID,
				Name:      d.Name,
				CreatedAt: d.CreatedAt,
			})
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"devices":           views,
			"current_device_id": current.ID,
		})
	})
}
