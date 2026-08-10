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

func (c *anthropicClient) Complete(ctx context.Context, p Params, messages []Message) (reply string, u Usage, err error) {
	// Every return path feeds the provider-health registry (see health.go) — that
	// is the only place "Anthropic is out of credits" ever becomes visible.
	defer func() { Record("anthropic", "", err) }()

	model := p.Model
	if model == "" {
		model = c.defaultModel
	}
	if model == "" {
		model = "claude-haiku-4-5-20251001"
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
		Model       string   `json:"model"`
		MaxTokens   int      `json:"max_tokens"`
		Temperature *float64 `json:"temperature,omitempty"`
		Messages    []antMsg `json:"messages"`
	}

	msgs := make([]antMsg, len(messages))
	for i, m := range messages {
		msgs[i] = antMsg(m)
	}
	body, _ := json.Marshal(reqBody{Model: model, MaxTokens: maxTokens, Temperature: p.Temp, Messages: msgs})

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
		Usage struct {
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
		Temp:         p.Temp,
	}
	for _, c := range out.Content {
		if c.Type == "text" {
			return c.Text, usage, nil
		}
	}
	return "", usage, fmt.Errorf("anthropic: no text content in response")
}
