package llm

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/logger"
)

var logLLM = logger.New("llm")

// ErrTransport marks a transport-level failure (connection refused, timeout,
// DNS, or a 5xx response) as opposed to a real API error (4xx). The fallback
// chain only falls through to the next provider on ErrTransport; everything
// else propagates immediately.
var ErrTransport = errors.New("llm: transport failure")

// transportErr tags err as a transport failure for the fallback chain.
func transportErr(err error) error { return fmt.Errorf("%w: %w", ErrTransport, err) }

// Message is a single chat turn.
type Message struct {
	Role    string // "user" | "assistant"
	Content string
}

// Usage holds token counts returned by the provider.
type Usage struct {
	Provider     string
	InputTokens  int
	OutputTokens int
}

// Client is a provider-agnostic LLM interface.
type Client interface {
	// Complete sends messages and returns the assistant reply plus token usage.
	Complete(ctx context.Context, model string, messages []Message) (string, Usage, error)
}

// New constructs a Client from LLM config. Returns nil (no LLM) if provider is empty.
// API key falls back to ANTHROPIC_API_KEY / OPENAI_API_KEY env vars when empty in config.
//
// When cfg.Fallback is non-empty, the returned Client is a fallbackClient that tries
// the primary then each fallback in order on transport-level failures. With no fallbacks
// the single client is returned directly (no wrapper, no behavior change).
func New(cfg config.LLMSection) Client {
	primary := newSingle(cfg)
	if primary == nil || len(cfg.Fallback) == 0 {
		return primary
	}

	// Primary uses the caller's model (preserves tier routing). Each fallback
	// overrides with its own DefaultModel, since the caller's tier model won't
	// exist on a different provider.
	entries := []entry{{client: primary, model: ""}}
	for _, fb := range cfg.Fallback {
		c := newSingle(fb)
		if c == nil {
			continue
		}
		entries = append(entries, entry{client: c, model: fb.DefaultModel})
	}
	if len(entries) == 1 {
		return primary
	}
	return &fallbackClient{entries: entries}
}

// newSingle constructs a single (non-chaining) provider client, or nil if none.
func newSingle(cfg config.LLMSection) Client {
	switch cfg.Provider {
	case "anthropic":
		key := cfg.APIKey
		if key == "" {
			key = os.Getenv("ANTHROPIC_API_KEY")
		}
		return &anthropicClient{apiKey: key}
	case "openai_compat":
		key := cfg.APIKey
		if key == "" {
			key = os.Getenv("OPENAI_API_KEY")
		}
		base := cfg.BaseURL
		if base == "" {
			base = "http://localhost:11434/v1"
		}
		return &openAICompatClient{baseURL: base, apiKey: key}
	case "":
		// Auto-detect: try ANTHROPIC_API_KEY env
		if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
			return &anthropicClient{apiKey: key}
		}
		return nil
	default:
		panic(fmt.Sprintf("llm: unknown provider %q", cfg.Provider))
	}
}

// entry is one provider in a fallback chain. A non-empty model overrides the
// caller's model when this entry serves the request.
type entry struct {
	client Client
	model  string
}

// fallbackClient tries each entry in order, falling through to the next only on
// transport-level failures (ErrTransport). Real API errors propagate immediately.
type fallbackClient struct {
	entries []entry
}

func (f *fallbackClient) Complete(ctx context.Context, model string, msgs []Message) (string, Usage, error) {
	var errs []error
	for i, e := range f.entries {
		m := model
		if e.model != "" {
			m = e.model // provider-specific model (caller's tier model won't exist here)
		}
		reply, usage, err := e.client.Complete(ctx, m, msgs)
		if err == nil {
			if i > 0 {
				logLLM.Warnf("primary failed; served by fallback provider %d (%s)", i, usage.Provider)
			}
			return reply, usage, nil
		}
		if ctx.Err() != nil {
			return "", Usage{}, fmt.Errorf("llm: context: %w", ctx.Err()) // canceled by caller — don't burn fallbacks
		}
		errs = append(errs, err)
		if !errors.Is(err, ErrTransport) {
			return "", Usage{}, fmt.Errorf("llm: %w", err) // real error (4xx etc.) — do not try fallbacks
		}
		logLLM.Warnf("provider %d transport failure, trying next: %v", i, err)
	}
	return "", Usage{}, fmt.Errorf("all llm providers failed: %w", errors.Join(errs...))
}
