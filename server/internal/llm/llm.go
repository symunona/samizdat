package llm

import (
	"context"
	"errors"
	"fmt"

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

// Usage holds token counts returned by the provider, plus the model that
// actually served the call — the caller may have asked for none (the provider's
// default) or been re-routed to a fallback, and the audit log must record what
// ran, not what was requested.
type Usage struct {
	Provider     string
	Model        string
	InputTokens  int
	OutputTokens int
}

// Client is a provider-agnostic LLM interface. Routing lives one level up, in
// Router — a Client speaks to exactly one endpoint.
type Client interface {
	// Complete sends messages and returns the assistant reply plus token usage.
	Complete(ctx context.Context, model string, messages []Message) (string, Usage, error)
}
