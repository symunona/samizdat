package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type anthropicClient struct {
	apiKey       string
	defaultModel string
	// baseURL is a field rather than a constant so probe tests can point it at an
	// httptest server. There is exactly one real value (anthropicBaseURL).
	baseURL string
}

// anthropicDefaultMaxTokens is required by the Messages API — unlike temperature
// there is no "omit it" option, so this IS the effective value when a caller sets none.
const anthropicDefaultMaxTokens = 4096

// anthropicDefaultModel serves a call that names no model on an endpoint with no
// default_model of its own.
const anthropicDefaultModel = "claude-haiku-5-5"

// anthropicModelCaps is how one model's Messages API surface differs from the
// Haiku 4.5 / Sonnet / Opus 4.x one this adapter was written against. The zero
// value is that baseline: send what the caller set, nothing more.
type anthropicModelCaps struct {
	// thinksByDefault: the model runs adaptive thinking unless told not to. It is
	// sent thinking:disabled, so hidden tokens neither bill nor eat max_tokens —
	// a 4096 cap a JSON step's reply already brushes (toleratesTruncatedReply).
	thinksByDefault bool
	// fixedSampling: any non-default temperature is a 400, so Params.Temp is
	// dropped and Usage reports it unset.
	fixedSampling bool
	// replySchema: Params.ReplySchema goes out as output_config.format, so the
	// reply is constrained to the step's JSON (a Haiku 4.5 llm_ai_newsletter
	// reply was invalid JSON on its first attempt, 2026-10-11).
	replySchema bool
}

// anthropicCaps is the one place a model id changes what goes on the wire.
func anthropicCaps(model string) anthropicModelCaps {
	if model == "claude-haiku-5-5" {
		return anthropicModelCaps{thinksByDefault: true, fixedSampling: true, replySchema: true}
	}
	return anthropicModelCaps{}
}

// anthropicThinking and anthropicOutputConfig are the request fields only a
// model with the matching anthropicModelCaps is sent.
type anthropicThinking struct {
	Type string `json:"type"`
}

type anthropicOutputConfig struct {
	Format anthropicReplyFormat `json:"format"`
}

type anthropicReplyFormat struct {
	Type   string          `json:"type"`
	Schema json.RawMessage `json:"schema"`
}

func (c *anthropicClient) Complete(ctx context.Context, p Params, messages []Message) (reply string, u Usage, err error) {
	// Every return path feeds the provider-health registry (see health.go) — that
	// is the only place "Anthropic is out of credits" ever becomes visible.
	defer func() { Record("anthropic", "", err) }()

	model := p.Model
	if model == "" {
		model = c.defaultModel
	}
	if model == "" {
		model = anthropicDefaultModel
	}
	maxTokens := p.MaxTokens
	if maxTokens <= 0 {
		maxTokens = anthropicDefaultMaxTokens
	}

	type antMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type reqBody struct {
		Model        string                 `json:"model"`
		MaxTokens    int                    `json:"max_tokens"`
		Temperature  *float64               `json:"temperature,omitempty"`
		Thinking     *anthropicThinking     `json:"thinking,omitempty"`
		OutputConfig *anthropicOutputConfig `json:"output_config,omitempty"`
		Messages     []antMsg               `json:"messages"`
	}

	msgs := make([]antMsg, len(messages))
	for i, m := range messages {
		msgs[i] = antMsg(m)
	}
	rb := reqBody{Model: model, MaxTokens: maxTokens, Temperature: p.Temp, Messages: msgs}
	caps := anthropicCaps(model)
	if caps.thinksByDefault {
		rb.Thinking = &anthropicThinking{Type: "disabled"}
	}
	if caps.fixedSampling {
		rb.Temperature = nil
	}
	if caps.replySchema && len(p.ReplySchema) > 0 {
		rb.OutputConfig = &anthropicOutputConfig{Format: anthropicReplyFormat{Type: "json_schema", Schema: p.ReplySchema}}
	}
	body, err := json.Marshal(rb)
	if err != nil {
		return "", Usage{}, fmt.Errorf("anthropic: encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		trimSlash(c.baseURL)+"/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", Usage{}, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := llmHTTPClient.Do(req)
	if err != nil {
		return "", Usage{}, transportErr(fmt.Errorf("anthropic request: %w", err))
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		err := fmt.Errorf("anthropic %d: %s", resp.StatusCode, string(data))
		if resp.StatusCode >= 500 {
			return "", Usage{}, transportErr(err)
		}
		return "", Usage{}, err
	}

	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		// StopReason is "max_tokens" when the completion cap cut the reply off
		// mid-generation, "end_turn"/"stop_sequence"/etc when the model finished
		// on its own. See Usage.Truncated.
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", Usage{}, fmt.Errorf("anthropic parse: %w", err)
	}
	usage := Usage{
		Provider:     "anthropic",
		Model:        model,
		InputTokens:  out.Usage.InputTokens,
		OutputTokens: out.Usage.OutputTokens,
		MaxTokens:    maxTokens,
		Temp:         rb.Temperature,
		Truncated:    out.StopReason == "max_tokens",
	}
	for _, c := range out.Content {
		if c.Type == "text" {
			return c.Text, usage, nil
		}
	}
	return "", usage, fmt.Errorf("anthropic: no text content in response")
}
