package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
	"golang.org/x/net/proxy"
)

// ytdlpStatusKey is the server_settings key holding the last successful probe time.
const ytdlpStatusKey = "ytdlp_proxy_last_ok_at"

// ytdlpStatus is the JSON shape returned by GET /api/v1/ytdlp/status.
type ytdlpStatus struct {
	Configured bool   `json:"configured"`         // a proxy is set in config
	Proxy      string `json:"proxy"`              // the configured proxy string
	OK         bool   `json:"ok"`                 // last probe succeeded
	ExitIP     string `json:"exit_ip"`            // public IP the proxy exits from
	Error      string `json:"error"`              // last probe error, if any
	CheckedAt  string `json:"checked_at"`         // RFC3339 of last probe
	LastOkAt   string `json:"last_ok_at"`         // RFC3339 of last success (persisted)
}

// ytdlpStatusHandler probes the yt-dlp SOCKS proxy and serves its health. A
// background goroutine re-checks every minute; GET also triggers a fresh probe
// so a page refresh auto-rechecks.
type ytdlpStatusHandler struct {
	q       *store.Queries
	proxy   string
	mu      sync.Mutex // guards last
	last    ytdlpStatus
	checkMu sync.Mutex // serializes probes (periodic vs on-demand)
}

func newYtdlpStatusHandler(ctx context.Context, q *store.Queries, proxyURL string) *ytdlpStatusHandler {
	h := &ytdlpStatusHandler{q: q, proxy: strings.TrimSpace(proxyURL)}
	h.last = ytdlpStatus{Configured: h.proxy != "", Proxy: h.proxy}
	// Seed last_ok_at from persistence so "last online" survives restarts.
	if v, err := q.GetSetting(ctx, ytdlpStatusKey); err == nil {
		h.last.LastOkAt = v
	}
	if h.proxy != "" {
		go h.loop(ctx)
	}
	return h
}

func (h *ytdlpStatusHandler) loop(ctx context.Context) {
	h.check(ctx)
	t := time.NewTicker(60 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.check(ctx)
		}
	}
}

// check probes the proxy by fetching api.ipify.org through it and records result.
func (h *ytdlpStatusHandler) check(ctx context.Context) {
	h.checkMu.Lock()
	defer h.checkMu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339)
	st := ytdlpStatus{Configured: h.proxy != "", Proxy: h.proxy, CheckedAt: now}
	h.mu.Lock()
	st.LastOkAt = h.last.LastOkAt
	h.mu.Unlock()

	if h.proxy == "" {
		st.Error = "no proxy configured"
		h.store(st)
		return
	}

	ip, err := probeProxy(ctx, h.proxy)
	if err != nil {
		st.OK = false
		st.Error = err.Error()
		h.store(st)
		return
	}
	st.OK = true
	st.ExitIP = ip
	st.LastOkAt = now
	if e := h.q.UpsertSetting(ctx, store.UpsertSettingParams{Key: ytdlpStatusKey, Value: now}); e != nil {
		logAPI.Errorf("persist ytdlp last_ok_at: %v", e)
	}
	h.store(st)
}

func (h *ytdlpStatusHandler) store(st ytdlpStatus) {
	h.mu.Lock()
	h.last = st
	h.mu.Unlock()
}

func (h *ytdlpStatusHandler) get(w http.ResponseWriter, r *http.Request) {
	// Fresh probe on demand (page refresh / manual recheck), bounded so the UI
	// never hangs; check() carries its own ~8s client timeout.
	h.check(r.Context())
	h.mu.Lock()
	st := h.last
	h.mu.Unlock()
	writeJSON(w, http.StatusOK, st)
}

// probeProxy dials api.ipify.org through the SOCKS5 proxy and returns the exit IP.
func probeProxy(ctx context.Context, proxyURL string) (string, error) {
	u, err := url.Parse(proxyURL)
	if err != nil {
		return "", fmt.Errorf("bad proxy url: %w", err)
	}
	// socks5h and socks5 both map to a SOCKS5 dialer (remote name resolution).
	dialer, err := proxy.SOCKS5("tcp", u.Host, nil, proxy.Direct)
	if err != nil {
		return "", fmt.Errorf("socks5 dialer: %w", err)
	}
	cd, ok := dialer.(proxy.ContextDialer)
	if !ok {
		return "", fmt.Errorf("dialer lacks context support")
	}
	client := &http.Client{
		Transport: &http.Transport{DialContext: cd.DialContext},
		Timeout:   8 * time.Second,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ipify.org", nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("proxy unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("probe http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}
	return strings.TrimSpace(string(body)), nil
}
