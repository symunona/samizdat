package llm

import (
	"context"
	"testing"
)

// A completion cut off at the OpenAI-compat cap reports finish_reason: "length" —
// Usage.Truncated must reflect it so a caller can tell "the model stopped" apart
// from "the cap stopped it".
func TestOpenAICompatReportsTruncation(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, map[string]any{
		"choices": []map[string]any{{
			"message":       map[string]string{"content": `{"summary": [`},
			"finish_reason": "length",
		}},
		"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 300},
	}, &sent)

	c := &openAICompatClient{baseURL: srv.URL + "/v1", defaultModel: "gemma3:4b"}
	_, u, err := c.Complete(context.Background(), Params{MaxTokens: 300}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if !u.Truncated {
		t.Fatalf("finish_reason=length must report Truncated=true, got %+v", u)
	}
}

// A completion that ends on its own (finish_reason: "stop") is a normal reply —
// Truncated must stay false.
func TestOpenAICompatNormalReplyIsNotTruncated(t *testing.T) {
	var sent map[string]any
	srv := captureBody(t, map[string]any{
		"choices": []map[string]any{{
			"message":       map[string]string{"content": "ok"},
			"finish_reason": "stop",
		}},
		"usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 3},
	}, &sent)

	c := &openAICompatClient{baseURL: srv.URL + "/v1", defaultModel: "gemma3:4b"}
	_, u, err := c.Complete(context.Background(), Params{}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if u.Truncated {
		t.Fatalf("finish_reason=stop must not report Truncated, got %+v", u)
	}
}

// Anthropic reports the same condition as stop_reason: "max_tokens".
func TestAnthropicReportsTruncation(t *testing.T) {
	srv := captureBody(t, map[string]any{
		"content":     []map[string]string{{"type": "text", "text": `{"summary": [`}},
		"stop_reason": "max_tokens",
		"usage":       map[string]int{"input_tokens": 10, "output_tokens": 1024},
	}, &map[string]any{})

	c := &anthropicClient{apiKey: "k", defaultModel: "claude-haiku-4-5-20251001", baseURL: srv.URL}
	_, u, err := c.Complete(context.Background(), Params{MaxTokens: 1024}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if !u.Truncated {
		t.Fatalf("stop_reason=max_tokens must report Truncated=true, got %+v", u)
	}
}

// A normal Anthropic completion ends on stop_reason: "end_turn".
func TestAnthropicNormalReplyIsNotTruncated(t *testing.T) {
	srv := captureBody(t, map[string]any{
		"content":     []map[string]string{{"type": "text", "text": "ok"}},
		"stop_reason": "end_turn",
		"usage":       map[string]int{"input_tokens": 5, "output_tokens": 2},
	}, &map[string]any{})

	c := &anthropicClient{apiKey: "k", defaultModel: "claude-haiku-4-5-20251001", baseURL: srv.URL}
	_, u, err := c.Complete(context.Background(), Params{}, nil)
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if u.Truncated {
		t.Fatalf("stop_reason=end_turn must not report Truncated, got %+v", u)
	}
}
