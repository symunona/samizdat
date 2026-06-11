package llm

import (
	"context"
	"fmt"
	"os"

	"github.com/symunona/samizdat/server/internal/config"
)

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
func New(cfg config.LLMSection) Client {
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
