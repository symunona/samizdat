package api

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/auth"
	"github.com/symunona/samizdat/server/internal/store"
)

// robotDeviceName is the single canonical device reused by all automated UI
// tests (agent-browser, e2e, curl scripts). Reusing one row keeps the dev DB
// from accumulating a fresh device per test run.
const robotDeviceName = "robot-automated-ui-tester"

type adminTestDeviceHandler struct {
	q          *store.Queries
	serverURLs []string
}

// ServeHTTP is idempotent: it returns a fresh token for the single
// robotDeviceName device, rotating the token on the existing row if present and
// creating the row only on first call. Repeated calls never add rows.
func (h *adminTestDeviceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	plain, hash, err := auth.NewToken()
	if err != nil {
		logPair.Errorf("test-device token: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)

	maxRev, err := h.q.MaxDeviceRev(r.Context())
	if err != nil {
		logPair.Errorf("test-device max rev: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}
	nextRev := int64(1)
	if v, ok := maxRev.(int64); ok {
		nextRev = v + 1
	}

	existing, err := h.q.GetDeviceByName(r.Context(), robotDeviceName)
	switch err {
	case nil:
		// Reuse the row — rotate its token in place.
		if uerr := h.q.UpdateDeviceToken(r.Context(), store.UpdateDeviceTokenParams{
			TokenHash: hash,
			UpdatedAt: now,
			Rev:       nextRev,
			ID:        existing.ID,
		}); uerr != nil {
			logPair.Errorf("test-device rotate token: %v", uerr)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"device_id":    existing.ID,
			"device_token": plain,
			"server_urls":  h.serverURLs,
		})
	case sql.ErrNoRows:
		devID := uuid.New().String()
		if _, ierr := h.q.InsertDevice(r.Context(), store.InsertDeviceParams{
			ID:        devID,
			Name:      robotDeviceName,
			TokenHash: hash,
			CreatedAt: now,
			UpdatedAt: now,
			Rev:       nextRev,
		}); ierr != nil {
			logPair.Errorf("test-device insert: %v", ierr)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"device_id":    devID,
			"device_token": plain,
			"server_urls":  h.serverURLs,
		})
	default:
		logPair.Errorf("test-device lookup: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
	}
}
