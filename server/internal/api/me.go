package api

import (
	"net/http"
)

func handleMe(w http.ResponseWriter, r *http.Request) {
	dev := deviceFromCtx(r)
	writeJSON(w, http.StatusOK, map[string]string{
		"device_id":      dev.ID,
		"name":           dev.Name,
		"server_version": version,
	})
}
