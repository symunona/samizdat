package api

import (
	"encoding/json"
	"net/http"

	"github.com/symunona/samizdat/server/internal/store"
)

type settingsHandler struct{ q *store.Queries }

type settingsPayload struct {
	PollingEnabled bool `json:"polling_enabled"`
}

func (h *settingsHandler) get(w http.ResponseWriter, r *http.Request) {
	val, err := h.q.GetSetting(r.Context(), "polling_enabled")
	enabled := err != nil || val != "false"
	writeJSON(w, http.StatusOK, settingsPayload{PollingEnabled: enabled})
}

func (h *settingsHandler) put(w http.ResponseWriter, r *http.Request) {
	var body settingsPayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	val := "true"
	if !body.PollingEnabled {
		val = "false"
	}
	if err := h.q.UpsertSetting(r.Context(), store.UpsertSettingParams{
		Key:   "polling_enabled",
		Value: val,
	}); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	writeJSON(w, http.StatusOK, settingsPayload{PollingEnabled: body.PollingEnabled})
}
