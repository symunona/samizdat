package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/auth"
	"github.com/symunona/samizdat/server/internal/pair"
	"github.com/symunona/samizdat/server/internal/store"
)

type pairHandler struct {
	db         *sql.DB
	q          *store.Queries
	serverURLs []string
}

func (h *pairHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Code == "" {
		writeErr(w, http.StatusBadRequest, "code required")
		return
	}

	if err := pair.Claim(r.Context(), h.db, h.q, body.Code); err != nil {
		writeErr(w, http.StatusUnauthorized, "invalid or expired code")
		return
	}

	plain, hash, err := auth.NewToken()
	if err != nil {
		log.Printf("new token: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}

	devID := uuid.New().String()
	name := body.Name
	if name == "" {
		name = fmt.Sprintf("Device-%s", devID[:8])
	}

	maxRev, err := h.q.MaxDeviceRev(r.Context())
	if err != nil {
		log.Printf("max rev: %v", err)
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
	_, err = h.q.InsertDevice(r.Context(), store.InsertDeviceParams{
		ID:        devID,
		Name:      name,
		TokenHash: hash,
		CreatedAt: now,
		UpdatedAt: now,
		Rev:       nextRev,
	})
	if err != nil {
		log.Printf("insert device: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"device_token": plain,
		"device_id":    devID,
		"server_urls":  h.serverURLs,
	})
}
