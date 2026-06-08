package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net"
	"net/http"

	"github.com/symunona/samizdat/server/internal/auth"
	"github.com/symunona/samizdat/server/internal/store"
)

type ctxKey int

const deviceKey ctxKey = 0

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func bearerAuth(q *store.Queries, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := ""
		if h := r.Header.Get("Authorization"); len(h) > 7 && h[:7] == "Bearer " {
			token = h[7:]
		}
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "missing token")
			return
		}
		hash := auth.HashToken(token)
		dev, err := q.GetDeviceByTokenHash(r.Context(), hash)
		if err == sql.ErrNoRows {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}
		if err != nil {
			log.Printf("auth db: %v", err)
			writeErr(w, http.StatusInternalServerError, "internal error")
			return
		}
		ctx := context.WithValue(r.Context(), deviceKey, dev)
		next(w, r.WithContext(ctx))
	}
}

func localhostOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			writeErr(w, http.StatusForbidden, "forbidden")
			return
		}
		ip := net.ParseIP(host)
		if ip == nil || (!ip.IsLoopback()) {
			writeErr(w, http.StatusForbidden, "admin endpoints are localhost-only")
			return
		}
		next(w, r)
	}
}

func deviceFromCtx(r *http.Request) store.Device {
	d, _ := r.Context().Value(deviceKey).(store.Device)
	return d
}
