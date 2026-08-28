package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/symunona/samizdat/server/internal/proxypool"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/ytdlp"
)

// ytdlpStatus is the JSON shape returned by GET /api/v1/ytdlp/status. The flat
// fields describe the ACTIVE proxy and predate the pool — APKs already in the
// field parse exactly this shape, so they stay, and Proxies carries the list.
type ytdlpStatus struct {
	Configured bool               `json:"configured"` // at least one proxy is set in config
	Proxy      string             `json:"proxy"`      // the active proxy string
	OK         bool               `json:"ok"`         // active proxy's last probe succeeded
	ExitIP     string             `json:"exit_ip"`    // public IP the active proxy exits from
	Error      string             `json:"error"`      // active proxy's last probe error, if any
	CheckedAt  string             `json:"checked_at"` // RFC3339 of last probe
	LastOkAt   string             `json:"last_ok_at"` // RFC3339 of last success (persisted)
	Proxies    []proxypool.Status `json:"proxies"`    // every configured proxy, in order
	// Ytdlp is the binary's own version state. It sits beside the proxies on
	// purpose: a stale yt-dlp fails every ingest on every egress IP, which reads
	// as "the proxy broke" unless the card says otherwise.
	Ytdlp ytdlp.Info `json:"ytdlp"`
}

// settingsPersist adapts store.Queries to proxypool.Persist, keeping the pool
// package free of the sqlc types.
type settingsPersist struct{ q *store.Queries }

func (s settingsPersist) Get(ctx context.Context, key string) (string, error) {
	v, err := s.q.GetSetting(ctx, key)
	if err != nil {
		return "", fmt.Errorf("get setting %s: %w", key, err)
	}
	return v, nil
}

func (s settingsPersist) Set(ctx context.Context, key, value string) error {
	if err := s.q.UpsertSetting(ctx, store.UpsertSettingParams{Key: key, Value: value}); err != nil {
		return fmt.Errorf("upsert setting %s: %w", key, err)
	}
	return nil
}

// ytdlpStatusHandler serves the proxy pool's health. The pool re-probes every
// entry each minute on its own; GET triggers a fresh sweep too, so a page
// refresh auto-rechecks.
type ytdlpStatusHandler struct {
	pool *proxypool.Pool
	ver  *ytdlp.Checker
}

func newYtdlpStatusHandler(ctx context.Context, pool *proxypool.Pool, ver *ytdlp.Checker) *ytdlpStatusHandler {
	if pool.Configured() {
		go pool.Run(ctx, 60*time.Second)
	}
	return &ytdlpStatusHandler{pool: pool, ver: ver}
}

func (h *ytdlpStatusHandler) get(w http.ResponseWriter, r *http.Request) {
	// Fresh sweep on demand (page refresh / manual recheck). Every entry is
	// probed concurrently, so this costs one probe timeout, not one per proxy.
	h.pool.Check(r.Context())
	st := h.status()
	st.Ytdlp = h.ver.Get(r.Context()) // cached; the release list is checked at most every 6h
	writeJSON(w, http.StatusOK, st)
}

func (h *ytdlpStatusHandler) status() ytdlpStatus {
	list := h.pool.Statuses()
	st := ytdlpStatus{Configured: h.pool.Configured(), Proxies: list}
	if !st.Configured {
		st.Error = "no proxy configured"
		return st
	}
	for _, p := range list {
		if !p.Active {
			continue
		}
		st.Proxy, st.OK, st.ExitIP, st.Error = p.Proxy, p.OK, p.ExitIP, p.Error
		st.CheckedAt, st.LastOkAt = p.CheckedAt, p.LastOkAt
		break
	}
	return st
}
