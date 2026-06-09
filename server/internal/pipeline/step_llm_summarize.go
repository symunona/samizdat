package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

func init() {
	Register("llm_summarize", handleLLMSummarize)
}

type llmSummarizeConfig struct {
	Model    string `json:"model"`
	Prompt   string `json:"prompt"`
	Provider string `json:"provider"`   // optional: override global client provider
	BaseURL  string `json:"base_url"`   // optional: override base URL (for openai_compat)
	APIKey   string `json:"api_key"`    // optional: override API key
}

func handleLLMSummarize(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, globalClient llm.Client) (StepResult, error) {
	var c llmSummarizeConfig
	_ = ParseStepConfig(cfg, &c)
	if c.Model == "" {
		c.Model = "claude-haiku-4-5-20251001"
	}
	if c.Prompt == "" {
		c.Prompt = "Summarize this article in max 1 paragraph or 5 bullet points, whichever fits the content better."
	}

	// Use step-level provider if specified, otherwise fall back to global client.
	client := globalClient
	if c.Provider != "" {
		client = llm.New(config.LLMSection{
			Provider:     c.Provider,
			BaseURL:      c.BaseURL,
			APIKey:       c.APIKey,
			DefaultModel: c.Model,
		})
	}
	if client == nil {
		return StepResult{}, fmt.Errorf("llm_summarize: no LLM client configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_summarize: get document: %w", err)
	}

	content := doc.Markdown
	if len(content) > 12000 {
		content = content[:12000] + "\n\n[truncated]"
	}

	userMsg := c.Prompt + "\n\n# " + doc.Title + "\n\n" + content
	reply, err := client.Complete(ctx, c.Model, []llm.Message{
		{Role: "user", Content: userMsg},
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_summarize: llm call: %w", err)
	}

	reply = strings.TrimSpace(reply)
	now := time.Now().UTC().Format(time.RFC3339)
	meta, _ := json.Marshal(map[string]string{"model": c.Model})

	_, err = q.InsertHighlight(ctx, store.InsertHighlightParams{
		ID:            uuid.NewString(),
		DocumentID:    run.DocumentID,
		PipelineRunID: run.ID,
		Kind:          "summary",
		Body:          reply,
		Metadata:      string(meta),
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_summarize: insert highlight: %w", err)
	}

	return StepResult{Done: true}, nil
}
