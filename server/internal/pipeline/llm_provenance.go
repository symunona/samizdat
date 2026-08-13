package pipeline

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

// llmStepConfig is the config every LLM step shares. Steps embed it, so its JSON
// keys stay identical across kinds and a new knob lands on all of them at once.
type llmStepConfig struct {
	Model     string   `json:"model"`
	Provider  string   `json:"provider"` // optional: pin a Router provider (no fallback)
	Prompt    string   `json:"prompt"`
	MaxTokens int      `json:"max_tokens"` // 0 = the provider's own default
	Temp      *float64 `json:"temperature"`
}

// llmCommonFields is the catalog half of llmStepConfig — same keys, one place.
func llmCommonFields(promptDefault string) []FieldSpec {
	return []FieldSpec{
		{Key: "model", Label: "Model", Type: "model", Help: "Empty = the provider's default_model."},
		{Key: "provider", Label: "Provider", Type: "string", Help: "Router provider id (`just check-llm` lists them). Empty = the configured chain."},
		{Key: "max_tokens", Label: "Max tokens", Type: "int", Help: "0 = the provider's default (Anthropic: 4096)."},
		{Key: "temperature", Label: "Temperature", Type: "float", Help: "Empty = the provider's default. Lower = more literal."},
		{Key: promptKey, Label: "Prompt", Type: "text", Default: promptDefault},
	}
}

// highlightProvenance is what a Highlight's metadata JSON carries: how this
// machine-written body came to be. Every field is the value that ACTUALLY served
// the call, not the one the step asked for — an unset model resolves inside the
// client and a transport fallback may swap the provider entirely. Omitted fields
// mean "the endpoint applied its own"; inventing a provider's private default
// would read as a setting the user chose.
type highlightProvenance struct {
	Model     string   `json:"model"`
	Provider  string   `json:"provider,omitempty"`
	Step      string   `json:"step,omitempty"`
	MaxTokens int      `json:"max_tokens,omitempty"`
	Temp      *float64 `json:"temperature,omitempty"`
	TokensIn  int      `json:"tokens_in,omitempty"`
	TokensOut int      `json:"tokens_out,omitempty"`
	// PromptSHA fingerprints the prompt TEMPLATE (not the rendered message — that
	// carries the article and would differ per document). It answers the only
	// question a stored prompt would: "was this made before I changed the prompt?"
	PromptSHA string `json:"prompt_sha,omitempty"`
	// Chunks is how many pieces the document was cut into, 0 when it fit in one
	// call. Non-zero means TokensIn/TokensOut are sums over Calls calls and Model
	// names whoever wrote the final text, not whoever read the document.
	Chunks int `json:"chunks,omitempty"`
	Calls  int `json:"calls,omitempty"`
	// Truncated is set when even the big model could not hold the document, so
	// the tail was dropped. The body carries a visible note saying the same.
	Truncated bool `json:"truncated,omitempty"`
}

// llmCall is the one path from a step to the LLM: it routes the call, writes the
// llm_usages ledger row, and accumulates what was spent. Steps differ in how they
// parse a reply, never in how they call or account for it — and a chunked run's
// twelve calls are metered exactly the way a single call is.
//
// Steps do not call it directly: they go through llmStepCallLong, which decides
// how many calls the document needs. See llm_long.go.
func llmCall(ctx context.Context, q *store.Queries, run store.PipelineRun,
	kind string, c llmStepConfig, userMsg string, router *llm.Router, acc *usageAcc,
) (string, error) {
	route := llm.Route{
		Provider: c.Provider,
		Params:   llm.Params{Model: c.Model, MaxTokens: c.MaxTokens, Temp: c.Temp},
	}
	reply, usage, err := router.CompleteRoute(ctx, route, []llm.Message{{Role: "user", Content: userMsg}})
	if err != nil {
		return "", fmt.Errorf("%s: llm call: %w", kind, err)
	}

	model := servedModel(usage, c.Model)

	// Recorded regardless of whether the caller ends up using the reply — the
	// tokens are spent either way.
	_ = q.InsertLLMUsage(ctx, store.InsertLLMUsageParams{
		ID:            uuid.NewString(),
		JobID:         ParentJobIDFromCtx(ctx),
		PipelineRunID: &run.ID,
		Provider:      usage.Provider,
		Model:         model,
		InputTokens:   int64(usage.InputTokens),
		OutputTokens:  int64(usage.OutputTokens),
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	})

	acc.add(usage, c)
	return reply, nil
}

// usageAcc sums what a step spent across however many calls it took. A single
// call and a twelve-chunk run produce the same shape of provenance; only the
// Chunks/Calls fields tell them apart.
type usageAcc struct {
	calls     int
	tokensIn  int
	tokensOut int
	chunks    int
	truncated bool

	// last describes the call that produced the text the user will read — the
	// reduce, or the only call. The map calls read the document; this one wrote
	// the summary, and that is the model a reader is asking about.
	last    llm.Usage
	lastCfg llmStepConfig
}

func (a *usageAcc) add(u llm.Usage, c llmStepConfig) {
	a.calls++
	a.tokensIn += u.InputTokens
	a.tokensOut += u.OutputTokens
	a.last, a.lastCfg = u, c
}

// merge folds a previous tick's totals back in: a chunked run spans jobs, so the
// counts travel through the pipeline run's state, not through memory.
func (a *usageAcc) merge(calls, in, out int) {
	a.calls += calls
	a.tokensIn += in
	a.tokensOut += out
}

func (a *usageAcc) provenance(kind string, stepCfg llmStepConfig) string {
	c := a.lastCfg
	if a.calls == 0 {
		c = stepCfg
	}
	// Calls is only interesting next to Chunks. Emitting "calls: 1" on every
	// single-call summary would add a field to the card that says nothing.
	calls := 0
	if a.chunks > 0 {
		calls = a.calls
	}
	meta, _ := json.Marshal(highlightProvenance{
		Model:     servedModel(a.last, c.Model),
		Provider:  servedProvider(a.last, c.Provider),
		Step:      kind,
		MaxTokens: a.last.MaxTokens,
		Temp:      a.last.Temp,
		TokensIn:  a.tokensIn,
		TokensOut: a.tokensOut,
		PromptSHA: promptSHA(c.Prompt),
		Chunks:    a.chunks,
		Calls:     calls,
		Truncated: a.truncated,
	})
	return string(meta)
}

// servedProvider names the endpoint for a human. A pinned route never falls back
// (see Router.CompleteRoute), so the step's provider id IS what served the call —
// and "localhost:11434" says which box, where the adapter's transport name
// ("openai_compat") says only which protocol. Unpinned calls keep the transport
// name: the chain picked the endpoint and only it knows which one. The ledger row
// keeps the transport name either way — llm_status aggregates spend by it.
func servedProvider(u llm.Usage, pinned string) string {
	if pinned != "" {
		return pinned
	}
	return u.Provider
}

// promptSHA is the short fingerprint of a prompt template.
func promptSHA(prompt string) string {
	if prompt == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])[:8]
}
