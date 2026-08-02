package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// llmHealthKey holds the persisted provider-health snapshot, so a failure that
// happened overnight is still on the Settings screen after a restart (same
// pattern as ytdlp_proxy_last_ok_at).
const llmHealthKey = "llm_provider_health"

// llmProvider is one configured (or previously used) LLM endpoint. It never
// carries the API key — only whether one is present.
type llmProvider struct {
	Key      string `json:"key"`
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url,omitempty"`
	Model    string `json:"model,omitempty"`
	Role     string `json:"role"`   // primary | fallback | retired
	Status   string `json:"status"` // ok | error | unknown
	HasKey   bool   `json:"has_key"`
	Calls    int64  `json:"calls"`
	Errors   int64  `json:"errors"`
	// RoutedShare is this endpoint's fraction (0..1) of all calls across every
	// endpoint. Keyed per ENDPOINT, unlike the usage log below — "how much went to
	// the local box instead of the cloud" is the whole point of a local primary,
	// and two openai_compat boxes must not answer it as one row.
	RoutedShare   float64 `json:"routed_share"`
	LastOKAt      string  `json:"last_ok_at,omitempty"`
	LastErrorAt   string  `json:"last_error_at,omitempty"`
	LastError     string  `json:"last_error,omitempty"`
	LastErrorKind string  `json:"last_error_kind,omitempty"`
}

// llmProviderUsage is lifetime spend from the llm_usages audit log. It is keyed
// by provider NAME (that is all the log records), so two openai_compat boxes
// share one row here while keeping separate health rows above.
type llmProviderUsage struct {
	Provider     string  `json:"provider"`
	Calls        int64   `json:"calls"`
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CostUSD      float64 `json:"cost_usd"`
	LastCallAt   string  `json:"last_call_at,omitempty"`
}

type llmStatusPayload struct {
	Configured bool               `json:"configured"`
	Providers  []llmProvider      `json:"providers"`
	Usage      []llmProviderUsage `json:"usage"`
	Totals     llmUsageSummary    `json:"totals"`
}

type llmStatusHandler struct {
	q   *store.Queries
	cfg config.LLMSection
}

// newLLMStatusHandler restores the persisted health snapshot and installs the
// persist callback, so Record() survives a restart.
func newLLMStatusHandler(ctx context.Context, q *store.Queries, cfg config.LLMSection) *llmStatusHandler {
	h := &llmStatusHandler{q: q, cfg: cfg}
	h.restore(ctx)
	llm.SetPersist(func(rows []llm.ProviderHealth) {
		blob, err := json.Marshal(rows)
		if err != nil {
			return
		}
		// Detached context: the request that triggered the LLM call may already
		// be gone by the time the completion returns.
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := q.UpsertSetting(c, store.UpsertSettingParams{Key: llmHealthKey, Value: string(blob)}); err != nil {
			logAPI.Errorf("persist llm health: %v", err)
		}
	})
	return h
}

// restore merges the persisted snapshot into the registry. In-memory rows always
// win, so this is safe to re-run per request — which it is, so a row written by
// another process (or seeded by a test) shows up without a restart.
func (h *llmStatusHandler) restore(ctx context.Context) {
	raw, err := h.q.GetSetting(ctx, llmHealthKey)
	if err != nil || raw == "" {
		return
	}
	var rows []llm.ProviderHealth
	if err := json.Unmarshal([]byte(raw), &rows); err == nil {
		llm.Restore(rows)
	}
}

func (h *llmStatusHandler) get(w http.ResponseWriter, r *http.Request) {
	h.restore(r.Context())

	health := map[string]llm.ProviderHealth{}
	for _, ph := range llm.Snapshot() {
		health[ph.Key] = ph
	}

	var providers []llmProvider
	seen := map[string]bool{}
	for i, sec := range configuredSections(h.cfg) {
		role := "fallback"
		if i == 0 {
			role = "primary"
		}
		p := describeProvider(sec, role, health)
		seen[p.Key] = true
		providers = append(providers, p)
	}
	// A provider dropped from config keeps its row: its error is still the reason
	// yesterday's pipeline died, and its spend is still real.
	for _, ph := range llm.Snapshot() {
		if seen[ph.Key] {
			continue
		}
		providers = append(providers, mergeHealth(llmProvider{
			Key: ph.Key, Provider: ph.Provider, BaseURL: ph.BaseURL, Role: "retired",
		}, ph))
	}

	var totalRouted int64
	for _, p := range providers {
		totalRouted += p.Calls
	}
	if totalRouted > 0 {
		for i := range providers {
			providers[i].RoutedShare = float64(providers[i].Calls) / float64(totalRouted)
		}
	}

	usage, totals := h.usage(r.Context())
	writeJSON(w, http.StatusOK, llmStatusPayload{
		Configured: len(providers) > 0,
		Providers:  providers,
		Usage:      usage,
		Totals:     totals,
	})
}

// configuredSections flattens primary + fallbacks in the order the chain tries
// them. An empty provider with no key configured means "no LLM at all".
func configuredSections(cfg config.LLMSection) []config.LLMSection {
	if cfg.Provider == "" && cfg.APIKey == "" && len(cfg.Fallback) == 0 {
		return nil
	}
	return append([]config.LLMSection{cfg}, cfg.Fallback...)
}

func describeProvider(sec config.LLMSection, role string, health map[string]llm.ProviderHealth) llmProvider {
	provider := sec.Provider
	baseURL := sec.BaseURL
	// Mirror llm.newSingle's defaults so the row names the endpoint actually used.
	switch provider {
	case "":
		provider = "anthropic" // auto-detect path (ANTHROPIC_API_KEY)
	case "openai_compat":
		if baseURL == "" {
			baseURL = "http://localhost:11434/v1"
		}
	}
	if provider == "anthropic" {
		baseURL = ""
	}
	p := llmProvider{
		Key:      llm.ProviderKey(provider, baseURL),
		Provider: provider,
		BaseURL:  baseURL,
		Model:    sec.DefaultModel,
		Role:     role,
		HasKey:   llm.HasKey(sec), // config key, ANTHROPIC_API_KEY, or a keyless local box
		Status:   "unknown",
	}
	return mergeHealth(p, health[p.Key])
}

func mergeHealth(p llmProvider, ph llm.ProviderHealth) llmProvider {
	p.Calls = ph.Calls
	p.Errors = ph.Errors
	p.LastError = ph.LastError
	p.LastErrorKind = ph.LastErrorKind
	if !ph.LastOKAt.IsZero() {
		p.LastOKAt = ph.LastOKAt.Format(time.RFC3339)
	}
	if !ph.LastErrorAt.IsZero() {
		p.LastErrorAt = ph.LastErrorAt.Format(time.RFC3339)
	}
	switch {
	case ph.LastErrorAt.After(ph.LastOKAt):
		p.Status = "error"
	case !ph.LastOKAt.IsZero():
		p.Status = "ok"
	default:
		p.Status = "unknown"
	}
	return p
}

// usage aggregates the audit log per provider (cost is priced per model, then
// summed) and returns the same cumulative totals the settings payload carries.
func (h *llmStatusHandler) usage(ctx context.Context) ([]llmProviderUsage, llmUsageSummary) {
	rows, err := h.q.GetLLMUsageTotalsByProviderModel(ctx)
	if err != nil {
		return []llmProviderUsage{}, llmUsageSummary{}
	}
	byProvider := map[string]*llmProviderUsage{}
	var totals llmUsageSummary
	for _, row := range rows {
		in := toInt64(row.InputTokens)
		out := toInt64(row.OutputTokens)
		cost := llm.EstimateCost(row.Model, int(in), int(out))
		name := row.Provider
		if name == "" {
			name = "unknown"
		}
		u := byProvider[name]
		if u == nil {
			u = &llmProviderUsage{Provider: name}
			byProvider[name] = u
		}
		u.Calls += row.Calls
		u.InputTokens += in
		u.OutputTokens += out
		u.CostUSD += cost
		if last := toString(row.LastCallAt); last > u.LastCallAt {
			u.LastCallAt = last
		}
		totals.TotalCalls += row.Calls
		totals.TotalInputTokens += in
		totals.TotalOutputTokens += out
		totals.TotalCostUSD += cost
	}
	out := make([]llmProviderUsage, 0, len(byProvider))
	for _, u := range byProvider {
		out = append(out, *u)
	}
	return out, totals
}

// toString coerces SQLite's dynamic MAX() result to a string (see toInt64).
func toString(v interface{}) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case time.Time:
		return x.Format(time.RFC3339)
	}
	return ""
}
