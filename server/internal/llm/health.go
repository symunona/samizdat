package llm

import (
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Provider health: the outcome of the LAST real call to each provider. There is
// no active probe — a cloud completion costs tokens, so asking "is Anthropic up?"
// would burn money on every Settings render. The one thing that matters (my key
// ran out of credits mid-pipeline) is exactly what the last call already knows.
//
// The registry is package-level so a client minted ad-hoc inside a pipeline step
// (step_llm_*.go calls llm.New per step) records without any wiring.

// Error kinds, most-actionable first. quota/auth mean "fix your account"; the
// others mean "the box or the request was wrong".
const (
	KindQuota     = "quota"
	KindAuth      = "auth"
	KindTransport = "transport"
	KindAPI       = "api"
)

// ProviderHealth is one provider's last-known state plus lifetime counters.
type ProviderHealth struct {
	Key           string    `json:"key"`
	Provider      string    `json:"provider"`
	BaseURL       string    `json:"base_url,omitempty"`
	Calls         int64     `json:"calls"`
	Errors        int64     `json:"errors"`
	LastOKAt      time.Time `json:"last_ok_at,omitempty"`
	LastErrorAt   time.Time `json:"last_error_at,omitempty"`
	LastError     string    `json:"last_error,omitempty"`
	LastErrorKind string    `json:"last_error_kind,omitempty"`
}

var (
	healthMu   sync.Mutex
	healthByID = map[string]*ProviderHealth{}
	persist    func([]ProviderHealth)
)

// ProviderKey identifies a provider instance. Two openai_compat boxes (a local
// Ollama and a cloud endpoint) must not share one health row, so the base URL is
// part of the identity.
func ProviderKey(provider, baseURL string) string {
	if baseURL == "" {
		return provider
	}
	return provider + "@" + strings.TrimRight(baseURL, "/")
}

// Record stores the outcome of one completion. err == nil marks a success.
func Record(provider, baseURL string, err error) {
	key := ProviderKey(provider, baseURL)
	now := time.Now().UTC()

	healthMu.Lock()
	h := healthByID[key]
	if h == nil {
		h = &ProviderHealth{Key: key, Provider: provider, BaseURL: baseURL}
		healthByID[key] = h
	}
	h.Calls++
	if err != nil {
		h.Errors++
		h.LastErrorAt = now
		h.LastError = truncErr(err.Error())
		h.LastErrorKind = classify(err)
	} else {
		h.LastOKAt = now
		// Keep last_error for history; status is decided by which timestamp is newer.
	}
	snap := snapshotLocked()
	p := persist
	healthMu.Unlock()

	if p != nil {
		p(snap)
	}
}

// Snapshot returns every known provider's health, newest activity first.
func Snapshot() []ProviderHealth {
	healthMu.Lock()
	defer healthMu.Unlock()
	return snapshotLocked()
}

// Restore rehydrates the registry at boot from persisted state, so an overnight
// failure is still visible after a restart. Existing in-memory rows win (a call
// already recorded this process is fresher than anything on disk).
func Restore(rows []ProviderHealth) {
	healthMu.Lock()
	defer healthMu.Unlock()
	for _, r := range rows {
		if r.Key == "" || healthByID[r.Key] != nil {
			continue
		}
		row := r
		healthByID[r.Key] = &row
	}
}

// SetPersist installs the callback that saves a snapshot after every Record.
func SetPersist(fn func([]ProviderHealth)) {
	healthMu.Lock()
	persist = fn
	healthMu.Unlock()
}

func snapshotLocked() []ProviderHealth {
	out := make([]ProviderHealth, 0, len(healthByID))
	for _, h := range healthByID {
		out = append(out, *h)
	}
	sort.Slice(out, func(i, j int) bool {
		return lastActivity(out[i]).After(lastActivity(out[j]))
	})
	return out
}

func lastActivity(h ProviderHealth) time.Time {
	if h.LastErrorAt.After(h.LastOKAt) {
		return h.LastErrorAt
	}
	return h.LastOKAt
}

// quotaRe matches the ways a provider says "you have no money / no headroom
// left" — Anthropic answers a spent balance with a plain 400, so the status code
// alone cannot tell it apart from a malformed request.
var quotaRe = regexp.MustCompile(`(?i)credit balance|insufficient[_ ](quota|credit|funds)|quota exceeded|billing|rate[_ ]limit|out of credit`)

var authRe = regexp.MustCompile(`(?i)\b(401|403)\b|invalid[_ ]api[_ ]key|authentication[_ ]error|unauthorized|permission[_ ]error`)

// classify maps an error to a KindX constant.
func classify(err error) string {
	msg := err.Error()
	switch {
	case quotaRe.MatchString(msg) || strings.Contains(msg, "429"):
		return KindQuota
	case authRe.MatchString(msg):
		return KindAuth
	case errors.Is(err, ErrTransport):
		return KindTransport
	default:
		return KindAPI
	}
}

// truncErr keeps a provider's error readable in a settings row (and small in the
// settings blob) — the useful part of an LLM error body is always at the front.
func truncErr(s string) string {
	s = strings.TrimSpace(s)
	const max = 400
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}
