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
	Register("llm_topics", handleLLMTopics)
}

type topicsConfig struct {
	Model    string `json:"model"`
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
}

type topicHighlight struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type topicsResponse struct {
	Highlights []topicHighlight `json:"highlights"`
}

// topicsSystemPrompt splits ANY newsletter into its distinct sections/topics. Unlike
// llm_summarize / llm_ai_newsletter, it does NOT summarize — each topic body is the
// section's original text, verbatim. Source language is preserved.
const topicsSystemPrompt = `You split a newsletter into its distinct topics/sections. Return ONLY valid JSON, no prose, no markdown fences.

Schema:
{"highlights": [{"title": string, "body": string}]}

Rules:
- One highlight per distinct topic/section/story in the newsletter, in document order.
- title: the section's own headline/first line, trimmed to a short heading.
- body: that section's FULL text, VERBATIM. Do NOT summarize, paraphrase, shorten, translate, or add commentary. Copy the original wording exactly.
- Reply in the same language as the newsletter.
- Skip pure boilerplate (greeting salutations, unsubscribe footer, "view in browser").
- Return {"highlights": []} if there are no real topics.`

func handleLLMTopics(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, globalClient llm.Client) (StepResult, error) {
	var c topicsConfig
	_ = ParseStepConfig(cfg, &c)
	// Unset model = the configured provider's default_model (see step_llm_summarize).

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
		return StepResult{}, fmt.Errorf("llm_topics: no LLM client configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_topics: get document: %w", err)
	}

	// Unwrap the legacy ``` fence a plaintext email used to get so the model sees
	// prose, not one code literal.
	content := StripCodeFence(doc.Markdown)
	if len(content) > 16000 {
		content = content[:16000] + "\n\n[truncated]"
	}

	userMsg := topicsSystemPrompt + "\n\n# " + doc.Title + "\n\n" + content
	reply, usage, err := client.Complete(ctx, c.Model, []llm.Message{
		{Role: "user", Content: userMsg},
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_topics: llm call: %w", err)
	}

	model := servedModel(usage, c.Model)

	_ = q.InsertLLMUsage(ctx, store.InsertLLMUsageParams{
		ID:            uuid.NewString(),
		JobID:         ParentJobIDFromCtx(ctx),
		PipelineRunID: &run.ID,
		Provider:      usage.Provider,
		Model:         model,
		InputTokens:   int64(usage.InputTokens),
		OutputTokens:  int64(usage.OutputTokens),
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	})

	reply = strings.TrimSpace(reply)
	if strings.HasPrefix(reply, "```") {
		reply = strings.TrimPrefix(reply, "```json")
		reply = strings.TrimPrefix(reply, "```")
		if idx := strings.LastIndex(reply, "```"); idx != -1 {
			reply = reply[:idx]
		}
		reply = strings.TrimSpace(reply)
	}

	var parsed topicsResponse
	if err := json.Unmarshal([]byte(reply), &parsed); err != nil {
		return StepResult{}, fmt.Errorf("llm_topics: parse llm json: %w\nraw: %s", err, reply)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	meta, _ := json.Marshal(map[string]string{"model": model})

	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		for _, h := range parsed.Highlights {
			title := strings.TrimSpace(h.Title)
			body := strings.TrimSpace(h.Body)
			if title == "" || body == "" {
				continue
			}
			if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
				ID:            uuid.NewString(),
				DocumentID:    run.DocumentID,
				PipelineRunID: run.ID,
				Kind:          "topic",
				Title:         title,
				Body:          body,
				Metadata:      string(meta),
				CreatedAt:     now,
				UpdatedAt:     now,
			}); err != nil {
				return fmt.Errorf("llm_topics: insert highlight %q: %w", title, err)
			}
		}
		return nil
	}); err != nil {
		return StepResult{}, err
	}

	return StepResult{Done: true}, nil
}
