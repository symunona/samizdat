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

// RequestTimeout bounds one completion, for both clients. A 12B model running
// mostly on CPU writes ~3 tok/s, so a normal local call takes minutes; 90s failed
// every one of them. It must stay under worker.stuckJobAge: a call outliving it
// gets its job requeued while still running — a second worker, double spend,
// duplicate Highlights (TestStuckJobAgeOutlivesLLMCall).
const RequestTimeout = 9 * time.Minute

var llmHTTPClient = &http.Client{Timeout: RequestTimeout}

type openAICompatClient struct {
	baseURL      string
	apiKey       string
	defaultModel string
	// noThinking asks a local box not to reason before answering. Ollama thinks by
	// default on a model that can (gemma4, qwen3.5): ~250 hidden tokens even for
	// one sentence, which at a CPU-bound 3 tok/s turned a 2-minute summary into 9.
	// Local only — OpenAI rejects reasoning_effort on a non-reasoning model.
	noThinking bool
}

func (c *openAICompatClient) Complete(ctx context.Context, p Params, messages []Message) (reply string, u Usage, err error) {
	// See anthropic.go: every return path feeds the provider-health registry.
	defer func() { Record("openai_compat", c.baseURL, err) }()

	model := p.Model
	if model == "" {
		model = c.defaultModel
	}
	if model == "" {
		// No sane default exists here — the box serves whatever was pulled onto it.
		return "", Usage{}, fmt.Errorf("openai_compat: no model (set llm.default_model for %s)", c.baseURL)
	}

	type oaiMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	// Both knobs are omitted when unset: a local box (Ollama / LM Studio) has its own
	// Modelfile defaults, and sending a made-up number would override them silently.
	type reqBody struct {
		Model       string   `json:"model"`
		MaxTokens   int      `json:"max_tokens,omitempty"`
		Temperature *float64 `json:"temperature,omitempty"`
		Reasoning   string   `json:"reasoning_effort,omitempty"`
		Messages    []oaiMsg `json:"messages"`
	}

	msgs := make([]oaiMsg, len(messages))
	for i, m := range messages {
		msgs[i] = oaiMsg(m)
	}
	rb := reqBody{Model: model, MaxTokens: max(p.MaxTokens, 0), Temperature: p.Temp, Messages: msgs}
	if c.noThinking {
		rb.Reasoning = "none"
	}
	body, _ := json.Marshal(rb)

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
			// FinishReason is "length" when the completion cap cut the reply off
			// mid-generation, "stop"/"tool_calls"/etc when the model finished on
			// its own. See Usage.Truncated. Ollama and other OpenAI-compat servers
			// follow the same enum.
			FinishReason string `json:"finish_reason"`
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
		Model:        model,
		InputTokens:  out.Usage.PromptTokens,
		OutputTokens: out.Usage.CompletionTokens,
		MaxTokens:    max(p.MaxTokens, 0),
		Temp:         p.Temp,
		Truncated:    out.Choices[0].FinishReason == "length",
	}
	return out.Choices[0].Message.Content, usage, nil
}
