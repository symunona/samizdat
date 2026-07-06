package api

import (
	"encoding/json"
	"net/http"

	"github.com/symunona/samizdat/server/internal/langpref"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

type settingsHandler struct{ q *store.Queries }

type llmUsageSummary struct {
	TotalCalls        int64   `json:"total_calls"`
	TotalInputTokens  int64   `json:"total_input_tokens"`
	TotalOutputTokens int64   `json:"total_output_tokens"`
	TotalCostUSD      float64 `json:"total_cost_usd"`
}

type settingsPayload struct {
	PollingEnabled bool            `json:"polling_enabled"`
	AutoMarkRead   bool            `json:"auto_mark_read"`
	LanguagePrefs  langpref.Prefs  `json:"language_prefs"`
	LLMUsage       llmUsageSummary `json:"llm_usage"`
}

func (h *settingsHandler) get(w http.ResponseWriter, r *http.Request) {
	pollingVal, err := h.q.GetSetting(r.Context(), "polling_enabled")
	polling := err != nil || pollingVal != "false"

	autoVal, err := h.q.GetSetting(r.Context(), "auto_mark_read")
	autoMarkRead := err != nil || autoVal != "false"

	langRaw, _ := h.q.GetSetting(r.Context(), langpref.SettingKey)
	prefs := langpref.Parse(langRaw)

	usage := h.llmUsage(r)
	writeJSON(w, http.StatusOK, settingsPayload{PollingEnabled: polling, AutoMarkRead: autoMarkRead, LanguagePrefs: prefs, LLMUsage: usage})
}

func (h *settingsHandler) llmUsage(r *http.Request) llmUsageSummary {
	totals, err := h.q.GetLLMUsageTotals(r.Context())
	if err != nil {
		return llmUsageSummary{}
	}
	rows, err := h.q.GetLLMUsageTotalsByModel(r.Context())
	if err != nil {
		return llmUsageSummary{}
	}
	var totalCost float64
	for _, row := range rows {
		in := toInt64(row.InputTokens)
		out := toInt64(row.OutputTokens)
		totalCost += llm.EstimateCost(row.Model, int(in), int(out))
	}
	return llmUsageSummary{
		TotalCalls:        totals.TotalCalls,
		TotalInputTokens:  toInt64(totals.TotalInputTokens),
		TotalOutputTokens: toInt64(totals.TotalOutputTokens),
		TotalCostUSD:      totalCost,
	}
}

// toInt64 coerces SQLite's dynamic COALESCE/SUM result (interface{}) to int64.
func toInt64(v interface{}) int64 {
	switch x := v.(type) {
	case int64:
		return x
	case int:
		return int64(x)
	case float64:
		return int64(x)
	}
	return 0
}

// put merges only the boolean keys present in the request body — the app sends
// partial patches (one field at a time), so absent fields must be left as-is.
func (h *settingsHandler) put(w http.ResponseWriter, r *http.Request) {
	var body struct {
		PollingEnabled *bool           `json:"polling_enabled"`
		AutoMarkRead   *bool           `json:"auto_mark_read"`
		LanguagePrefs  *langpref.Prefs `json:"language_prefs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	upsert := func(key string, v *bool) bool {
		if v == nil {
			return true
		}
		val := "true"
		if !*v {
			val = "false"
		}
		return h.q.UpsertSetting(r.Context(), store.UpsertSettingParams{Key: key, Value: val}) == nil
	}
	if !upsert("polling_enabled", body.PollingEnabled) || !upsert("auto_mark_read", body.AutoMarkRead) {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if body.LanguagePrefs != nil {
		blob, _ := json.Marshal(body.LanguagePrefs)
		if h.q.UpsertSetting(r.Context(), store.UpsertSettingParams{Key: langpref.SettingKey, Value: string(blob)}) != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	h.get(w, r)
}
