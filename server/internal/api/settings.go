package api

import (
	"encoding/json"
	"net/http"

	"github.com/symunona/samizdat/server/internal/ctxmenu"
	"github.com/symunona/samizdat/server/internal/langpref"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/worker"
)

type settingsHandler struct{ q *store.Queries }

type llmUsageSummary struct {
	TotalCalls        int64   `json:"total_calls"`
	TotalInputTokens  int64   `json:"total_input_tokens"`
	TotalOutputTokens int64   `json:"total_output_tokens"`
	TotalCostUSD      float64 `json:"total_cost_usd"`
}

type settingsPayload struct {
	PollingEnabled     bool            `json:"polling_enabled"`
	AutoMarkRead       bool            `json:"auto_mark_read"`
	AutoArchiveEnabled bool            `json:"auto_archive_enabled"`
	LanguagePrefs      langpref.Prefs  `json:"language_prefs"`
	ContextMenu        ctxmenu.Prefs   `json:"context_menu"`
	LLMUsage           llmUsageSummary `json:"llm_usage"`
}

func (h *settingsHandler) get(w http.ResponseWriter, r *http.Request) {
	pollingVal, err := h.q.GetSetting(r.Context(), "polling_enabled")
	polling := err != nil || pollingVal != "false"

	autoVal, err := h.q.GetSetting(r.Context(), "auto_mark_read")
	autoMarkRead := err != nil || autoVal != "false"

	// Opt-in, unlike the two above: a sweep that archives on its own must never
	// be on for a server nobody asked.
	archiveVal, _ := h.q.GetSetting(r.Context(), worker.AutoArchiveSettingKey)
	autoArchive := archiveVal == "true"

	langRaw, _ := h.q.GetSetting(r.Context(), langpref.SettingKey)
	prefs := langpref.Parse(langRaw)

	menuRaw, _ := h.q.GetSetting(r.Context(), ctxmenu.SettingKey)
	menu := ctxmenu.Parse(menuRaw)

	usage := h.llmUsage(r)
	writeJSON(w, http.StatusOK, settingsPayload{
		PollingEnabled:     polling,
		AutoMarkRead:       autoMarkRead,
		AutoArchiveEnabled: autoArchive,
		LanguagePrefs:      prefs,
		ContextMenu:        menu,
		LLMUsage:           usage,
	})
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
		PollingEnabled     *bool           `json:"polling_enabled"`
		AutoMarkRead       *bool           `json:"auto_mark_read"`
		AutoArchiveEnabled *bool           `json:"auto_archive_enabled"`
		LanguagePrefs      *langpref.Prefs `json:"language_prefs"`
		ContextMenu        *ctxmenu.Prefs  `json:"context_menu"`
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
	if !upsert("polling_enabled", body.PollingEnabled) ||
		!upsert("auto_mark_read", body.AutoMarkRead) ||
		!upsert(worker.AutoArchiveSettingKey, body.AutoArchiveEnabled) {
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
	if body.ContextMenu != nil {
		// Normalized on the way in as well as on the way out: what is stored is what
		// every device will execute, so a row the sheet could not run never lands.
		blob, _ := json.Marshal(body.ContextMenu.Normalize())
		if h.q.UpsertSetting(r.Context(), store.UpsertSettingParams{Key: ctxmenu.SettingKey, Value: string(blob)}) != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}
	h.get(w, r)
}
