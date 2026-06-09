package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

func init() {
	Register("llm_summarize", handleLLMSummarize)
}

type llmSummarizeConfig struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
}

func handleLLMSummarize(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, llmClient llm.Client) (StepResult, error) {
	if llmClient == nil {
		return StepResult{}, fmt.Errorf("llm_summarize: no LLM client configured")
	}

	var c llmSummarizeConfig
	_ = ParseStepConfig(cfg, &c)
	if c.Model == "" {
		c.Model = "claude-haiku-4-5-20251001"
	}
	if c.Prompt == "" {
		c.Prompt = "Summarize this document in 3 concise bullet points. Focus on key insights and takeaways."
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
	reply, err := llmClient.Complete(ctx, c.Model, []llm.Message{
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
