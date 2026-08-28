package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// askMaxRunes caps one ad-hoc prompt. A reader's selection plus its surrounding
// context is a few thousand runes; anything past this is a paste accident, and an
// unbounded prompt is an unbounded bill.
const askMaxRunes = 40000

// askTimeout bounds one call. A local box that stopped answering must fail the
// popout, not hold a request open until the client gives up.
const askTimeout = 120 * time.Second

type askRequest struct {
	Prompt string `json:"prompt"`
	// System is the user's master prompt. It is PREPENDED to the user message
	// rather than sent as a system turn: the Anthropic Messages API takes no
	// `system` role in the messages array (it 400s), and the two adapters share
	// one Message shape. Composing here keeps both providers on one code path.
	System    string   `json:"system"`
	Provider  string   `json:"provider"`
	Model     string   `json:"model"`
	MaxTokens int      `json:"max_tokens"`
	Temp      *float64 `json:"temperature"`
}

type askResponse struct {
	Reply     string `json:"reply"`
	Model     string `json:"model"`
	Provider  string `json:"provider"`
	TokensIn  int    `json:"tokens_in"`
	TokensOut int    `json:"tokens_out"`
}

// ask serves one ad-hoc completion for the reader's selection context menu
// (translate / ask a question). It is the ONE path from a UI to the Router:
// routing rules, metering and error shape are identical to a pipeline step's —
// a named provider is pinned (no fallback), an empty one uses the chain.
func (h *llmStatusHandler) ask(w http.ResponseWriter, r *http.Request) {
	var body askRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	prompt := strings.TrimSpace(body.Prompt)
	if prompt == "" {
		writeErr(w, http.StatusBadRequest, "prompt is required")
		return
	}
	msg := prompt
	if sys := strings.TrimSpace(body.System); sys != "" {
		msg = sys + "\n\n" + prompt
	}
	if len([]rune(msg)) > askMaxRunes {
		writeErr(w, http.StatusRequestEntityTooLarge, "prompt too long")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), askTimeout)
	defer cancel()

	route := llm.Route{
		Provider: body.Provider,
		Params:   llm.Params{Model: body.Model, MaxTokens: body.MaxTokens, Temp: body.Temp},
	}
	reply, usage, err := h.router.CompleteRoute(ctx, route, []llm.Message{{Role: "user", Content: msg}})
	if err != nil {
		if errors.Is(err, llm.ErrNoProvider) {
			writeErr(w, http.StatusServiceUnavailable, "no LLM provider configured")
			return
		}
		logAPI.Errorf("llm ask: %v", err)
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	// Metered exactly like a pipeline call — an ad-hoc ask spends real money, so it
	// belongs in the same ledger the Settings spend summary reads. Both FK columns
	// are nil: this call belongs to no job and no pipeline run.
	_ = h.q.InsertLLMUsage(ctx, store.InsertLLMUsageParams{
		ID:           uuid.NewString(),
		Provider:     usage.Provider,
		Model:        usage.Model,
		InputTokens:  int64(usage.InputTokens),
		OutputTokens: int64(usage.OutputTokens),
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
	})

	// Provider: the pin when there was one (it cannot have fallen back, and
	// "localhost:11434" says which box where "openai_compat" says only which
	// protocol) — same rule as a Highlight's provenance.
	provider := usage.Provider
	if body.Provider != "" {
		provider = body.Provider
	}
	writeJSON(w, http.StatusOK, askResponse{
		Reply:     reply,
		Model:     usage.Model,
		Provider:  provider,
		TokensIn:  usage.InputTokens,
		TokensOut: usage.OutputTokens,
	})
}
