package llm

import (
	"context"
	"errors"
	"testing"
)

// stubClient records the model it was called with and returns a canned result.
type stubClient struct {
	name      string
	err       error
	gotModel  string
	callCount int
}

func (s *stubClient) Complete(_ context.Context, model string, _ []Message) (string, Usage, error) {
	s.callCount++
	s.gotModel = model
	if s.err != nil {
		return "", Usage{}, s.err
	}
	return s.name + " reply", Usage{Provider: s.name}, nil
}

func TestFallbackFallsThroughOnTransport(t *testing.T) {
	primary := &stubClient{name: "ollama", err: transportErr(errors.New("connection refused"))}
	backup := &stubClient{name: "anthropic"}
	c := &fallbackClient{entries: []entry{
		{client: primary, model: ""},
		{client: backup, model: "claude-haiku-4-5-20251001"},
	}}

	reply, usage, err := c.Complete(context.Background(), "llama3.1", nil)
	if err != nil {
		t.Fatalf("want fallback success, got err: %v", err)
	}
	if usage.Provider != "anthropic" {
		t.Fatalf("want served by anthropic, got %q", usage.Provider)
	}
	if reply != "anthropic reply" {
		t.Fatalf("unexpected reply %q", reply)
	}
	// Primary gets the caller's model; fallback gets its own override.
	if primary.gotModel != "llama3.1" {
		t.Fatalf("primary model: want llama3.1, got %q", primary.gotModel)
	}
	if backup.gotModel != "claude-haiku-4-5-20251001" {
		t.Fatalf("fallback model: want claude-haiku-4-5-20251001, got %q", backup.gotModel)
	}
}

func TestFallbackPropagatesNonTransport(t *testing.T) {
	apiErr := errors.New("anthropic 400: bad request")
	primary := &stubClient{name: "ollama", err: apiErr}
	backup := &stubClient{name: "anthropic"}
	c := &fallbackClient{entries: []entry{
		{client: primary, model: ""},
		{client: backup, model: "claude-haiku-4-5-20251001"},
	}}

	_, _, err := c.Complete(context.Background(), "llama3.1", nil)
	if !errors.Is(err, apiErr) {
		t.Fatalf("want original 4xx error propagated, got %v", err)
	}
	if backup.callCount != 0 {
		t.Fatalf("fallback must not run on non-transport error, ran %d times", backup.callCount)
	}
}

func TestFallbackAllFail(t *testing.T) {
	primary := &stubClient{name: "ollama", err: transportErr(errors.New("refused"))}
	backup := &stubClient{name: "anthropic", err: transportErr(errors.New("timeout"))}
	c := &fallbackClient{entries: []entry{
		{client: primary, model: ""},
		{client: backup, model: "claude-haiku-4-5-20251001"},
	}}

	_, _, err := c.Complete(context.Background(), "llama3.1", nil)
	if err == nil {
		t.Fatal("want error when all providers fail")
	}
	if !errors.Is(err, ErrTransport) {
		t.Fatalf("want joined error to retain ErrTransport, got %v", err)
	}
	if backup.callCount != 1 {
		t.Fatalf("fallback should have been tried once, ran %d times", backup.callCount)
	}
}
