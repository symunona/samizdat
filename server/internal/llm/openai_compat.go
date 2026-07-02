package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const llmRequestTimeout = 90 * time.Second

var llmHTTPClient = &http.Client{Timeout: llmRequestTimeout}

type openAICompatClient struct {
	baseURL string
	apiKey  string
}

func (c *openAICompatClient) Complete(ctx context.Context, model string, messages []Message) (string, Usage, error) {
	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type reqBody struct {
		Model    string   `json:"model"`
		Messages []oaiMsg `json:"messages"`
	}

	msgs := make([]oaiMsg, len(messages))
	for i, m := range messages {
		msgs[i] = oaiMsg(m)
	}
	body, _ := json.Marshal(reqBody{Model: model, Messages: msgs})

	url := strings.TrimRight(c.baseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return "", Usage{}, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}

	resp, err := llmHTTPClient.Do(req)
	if err != nil {
		return "", Usage{}, transportErr(fmt.Errorf("openai_compat request: %w", err))
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		err := fmt.Errorf("openai_compat %d: %s", resp.StatusCode, string(data))
		if resp.StatusCode >= 500 {
			return "", Usage{}, transportErr(err)
		}
		return "", Usage{}, err
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", Usage{}, fmt.Errorf("openai_compat parse: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", Usage{}, fmt.Errorf("openai_compat: no choices in response")
	}
	usage := Usage{
		Provider:     "openai_compat",
		InputTokens:  out.Usage.PromptTokens,
		OutputTokens: out.Usage.CompletionTokens,
	}
	return out.Choices[0].Message.Content, usage, nil
}
