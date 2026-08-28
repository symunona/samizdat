// Package proxypool owns the ordered list of residential egress proxies yt-dlp
// runs behind, and their health. The VPS's datacenter IP is bot-blocked by
// YouTube, so a proxy is the happy path — and a single-valued one made every
// ingest fail the moment that one home node blinked. The pool keeps a live
// health view of every configured entry, hands the worker an ordered list to
// try, and lets it demote an IP that trips the bot wall mid-job.
package proxypool

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/proxy"
)

// LastOKKey is the server_settings key holding {proxy: rfc3339} of last success.
const LastOKKey = "ytdlp_proxy_last_ok"

// LegacyLastOKKey is the pre-pool scalar key, read once to seed LastOKKey so
// "last online" survives the upgrade from a single-valued [ytdlp].proxy.
const LegacyLastOKKey = "ytdlp_proxy_last_ok_at"

// probeTimeout bounds one entry's health check. Every entry is probed
// concurrently, so a whole sweep costs one timeout, not len(list) of them.
const probeTimeout = 8 * time.Second

// Status is one proxy's health, as served to the app.
type Status struct {
	Proxy     string `json:"proxy"`      // the full proxy URL
	Label     string `json:"label"`      // short host name, e.g. "piri"
	OK        bool   `json:"ok"`         // last probe succeeded
	ExitIP    string `json:"exit_ip"`    // public IP this proxy exits from
	Error     string `json:"error"`      // last probe error, if any
	CheckedAt string `json:"checked_at"` // RFC3339 of last probe
	LastOkAt  string `json:"last_ok_at"` // RFC3339 of last success (persisted)
	Active    bool   `json:"active"`     // the entry jobs currently route through
}

// Persist is the slice of settings storage the pool needs. Keeping it to two
// methods lets the package stay free of the store/sqlc types.
type Persist interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key, value string) error
}

// Pool holds the configured proxies in preference order plus their health.
type Pool struct {
	list    []string // configured order; never mutated after New
	persist Persist

	mu     sync.RWMutex
	state  map[string]*Status
	active string // sticky: stays put while healthy, so probes don't flap it

	checkMu sync.Mutex // serializes sweeps (periodic vs on-demand)
}

// New builds a pool from the configured list, dropping blanks and duplicates so
// the same node listed twice is not "two" proxies. persist may be nil.
func New(list []string, persist Persist) *Pool {
	p := &Pool{persist: persist, state: map[string]*Status{}}
	seen := map[string]bool{}
	for _, raw := range list {
		s := strings.TrimSpace(raw)
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		p.list = append(p.list, s)
		p.state[s] = &Status{Proxy: s, Label: Label(s)}
	}
	return p
}

// Seed loads persisted last-success times. The legacy scalar key is applied to
// the first entry only — that is the proxy it was recorded for.
func (p *Pool) Seed(ctx context.Context) {
	if p.persist == nil || len(p.list) == 0 {
		return
	}
	saved := map[string]string{}
	if v, err := p.persist.Get(ctx, LastOKKey); err == nil && v != "" {
		_ = json.Unmarshal([]byte(v), &saved)
	} else if v, err := p.persist.Get(ctx, LegacyLastOKKey); err == nil && v != "" {
		saved[p.list[0]] = v
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for proxyURL, ts := range saved {
		if st, ok := p.state[proxyURL]; ok {
			st.LastOkAt = ts
		}
	}
}

// Configured reports whether any proxy is set. False means yt-dlp runs direct.
func (p *Pool) Configured() bool { return len(p.list) > 0 }

// Current is the proxy jobs should route through: the sticky active entry while
// it is healthy, else the first healthy one, else the first configured one (an
// unprobed pool must still be usable — a probe failure is not proof yt-dlp
// fails, and refusing to try would be worse than trying). "" when unconfigured.
func (p *Pool) Current() string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.currentLocked()
}

func (p *Pool) currentLocked() string {
	if len(p.list) == 0 {
		return ""
	}
	if p.active != "" {
		if st, ok := p.state[p.active]; ok && st.OK {
			return p.active
		}
	}
	for _, s := range p.list {
		if p.state[s].OK {
			return s
		}
	}
	return p.list[0]
}

// Attempts is the order a job should try proxies in: the current one first, then
// the remaining healthy entries, then the unhealthy ones as a last resort — a
// stale probe must never take the whole pool out of service. Empty when
// unconfigured, which the caller runs as a single direct attempt.
func (p *Pool) Attempts() []string {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if len(p.list) == 0 {
		return nil
	}
	cur := p.currentLocked()
	out := []string{cur}
	for _, s := range p.list {
		if s != cur && p.state[s].OK {
			out = append(out, s)
		}
	}
	for _, s := range p.list {
		if s != cur && !p.state[s].OK {
			out = append(out, s)
		}
	}
	return out
}

// MarkFailed demotes a proxy a job just saw fail (a bot wall, not a dial error)
// and moves the active pointer off it, so the next job starts somewhere else
// instead of re-walking the same blocked IP.
func (p *Pool) MarkFailed(proxyURL, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	st, ok := p.state[proxyURL]
	if !ok {
		return
	}
	st.OK = false
	st.Error = reason
	st.CheckedAt = nowRFC3339()
	if p.active == proxyURL {
		p.active = ""
	}
}

// Statuses returns every entry's health in configured order.
func (p *Pool) Statuses() []Status {
	p.mu.RLock()
	defer p.mu.RUnlock()
	cur := p.currentLocked()
	out := make([]Status, 0, len(p.list))
	for _, s := range p.list {
		st := *p.state[s]
		st.Active = s == cur
		out = append(out, st)
	}
	return out
}

// Run probes immediately, then every interval until ctx ends.
func (p *Pool) Run(ctx context.Context, interval time.Duration) {
	p.Check(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.Check(ctx)
		}
	}
}

// Check probes every configured proxy concurrently and records the results.
func (p *Pool) Check(ctx context.Context) {
	p.checkMu.Lock()
	defer p.checkMu.Unlock()
	if len(p.list) == 0 {
		return
	}

	now := nowRFC3339()
	type result struct {
		proxy string
		ip    string
		err   error
	}
	results := make([]result, len(p.list))
	var wg sync.WaitGroup
	for i, s := range p.list {
		wg.Add(1)
		go func(i int, s string) {
			defer wg.Done()
			ip, err := Probe(ctx, s)
			results[i] = result{proxy: s, ip: ip, err: err}
		}(i, s)
	}
	wg.Wait()

	p.mu.Lock()
	for _, r := range results {
		st := p.state[r.proxy]
		st.CheckedAt = now
		if r.err != nil {
			st.OK = false
			st.Error = r.err.Error()
			st.ExitIP = ""
			if p.active == r.proxy {
				p.active = ""
			}
			continue
		}
		st.OK = true
		st.Error = ""
		st.ExitIP = r.ip
		st.LastOkAt = now
	}
	if p.active == "" {
		p.active = p.currentLocked()
	}
	lastOK := map[string]string{}
	for _, s := range p.list {
		if ts := p.state[s].LastOkAt; ts != "" {
			lastOK[s] = ts
		}
	}
	p.mu.Unlock()

	if p.persist != nil && len(lastOK) > 0 {
		if b, err := json.Marshal(lastOK); err == nil {
			_ = p.persist.Set(ctx, LastOKKey, string(b))
		}
	}
}

// Probe dials api.ipify.org through the proxy and returns its public exit IP —
// the one fact that distinguishes two nodes sharing a household connection from
// two genuinely independent egresses.
func Probe(ctx context.Context, proxyURL string) (string, error) {
	u, err := url.Parse(proxyURL)
	if err != nil {
		return "", fmt.Errorf("bad proxy url: %w", err)
	}
	transport, err := transportFor(u)
	if err != nil {
		return "", err
	}
	client := &http.Client{Transport: transport, Timeout: probeTimeout}
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

// transportFor builds the right transport for a proxy scheme. yt-dlp accepts
// both SOCKS and HTTP proxies, so the health check must too — probing an http://
// entry with a SOCKS dialer would report a working proxy as dead.
func transportFor(u *url.URL) (http.RoundTripper, error) {
	switch strings.ToLower(u.Scheme) {
	case "socks5", "socks5h", "socks4", "socks4a", "":
		// socks5h/socks5 both map to a SOCKS5 dialer (remote name resolution).
		var auth *proxy.Auth
		if u.User != nil {
			pw, _ := u.User.Password()
			auth = &proxy.Auth{User: u.User.Username(), Password: pw}
		}
		dialer, err := proxy.SOCKS5("tcp", u.Host, auth, proxy.Direct)
		if err != nil {
			return nil, fmt.Errorf("socks5 dialer: %w", err)
		}
		cd, ok := dialer.(proxy.ContextDialer)
		if !ok {
			return nil, fmt.Errorf("dialer lacks context support")
		}
		return &http.Transport{DialContext: cd.DialContext}, nil
	case "http", "https":
		return &http.Transport{Proxy: http.ProxyURL(u)}, nil
	default:
		return nil, fmt.Errorf("unsupported proxy scheme %q", u.Scheme)
	}
}

// Label shortens a proxy URL to the node name the fleet knows it by:
// "socks5h://piri.tail7f475e.ts.net:1080" → "piri". Falls back to host:port for
// anything that is not a tailnet name (a bare IP keeps its address).
func Label(proxyURL string) string {
	u, err := url.Parse(proxyURL)
	if err != nil || u.Host == "" {
		return proxyURL
	}
	host := u.Host
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if net.ParseIP(host) != nil {
		return u.Host
	}
	if i := strings.Index(host, "."); i > 0 {
		return host[:i]
	}
	return host
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }
