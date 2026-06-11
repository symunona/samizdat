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
	apiKey string
}

func (c *anthropicClient) Complete(ctx context.Context, model string, messages []Message) (string, Usage, error) {
	if model == "" {
		model = "claude-haiku-4-5-20251001"
	}

	type antMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type reqBody struct {
		Model     string   `json:"model"`
		MaxTokens int      `json:"max_tokens"`
		Messages  []antMsg `json:"messages"`
	}

	msgs := make([]antMsg, len(messages))
	for i, m := range messages {
		msgs[i] = antMsg{Role: m.Role, Content: m.Content}
	}
	body, _ := json.Marshal(reqBody{Model: model, MaxTokens: 4096, Messages: msgs})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", Usage{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := llmHTTPClient.Do(req)
	if err != nil {
		return "", Usage{}, fmt.Errorf("anthropic request: %w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", Usage{}, fmt.Errorf("anthropic %d: %s", resp.StatusCode, string(data))
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
		InputTokens:  out.Usage.InputTokens,
		OutputTokens: out.Usage.OutputTokens,
	}
	for _, c := range out.Content {
		if c.Type == "text" {
			return c.Text, usage, nil
		}
	}
	return "", usage, fmt.Errorf("anthropic: no text content in response")
}
