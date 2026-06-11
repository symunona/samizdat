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
		c.Prompt = "Summarize as caveman. Rules: drop all articles (a/an/the), drop filler words (just/really/basically/actually/simply/notably), drop hedges (seems/appears/might), no pleasantries, no intro, no outro. Fragments OK. Short synonyms (big not extensive, fix not implement a solution). Max 3 bullets. Pattern: [thing] [action] [why it matters]. Bold the key topic/name of each bullet: **keyword** where it naturally lands — one bold per bullet. Boring or thin = one line. Never start with 'This article'. IMPORTANT: if content is empty, image-only, or has no meaningful text to summarize, return exactly empty string — nothing else."
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
	if reply == "" {
		return StepResult{Done: true}, nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	meta, _ := json.Marshal(map[string]string{"model": c.Model})

	// Prepend hero image if one has been cached for this document.
	body := reply
	if assets, err2 := q.ListMediaAssetsByDocument(ctx, run.DocumentID); err2 == nil {
		for _, a := range assets {
			if a.Kind == "hero" {
				body = "![](/api/v1/media/" + a.ID + ")\n\n" + body
				break
			}
		}
	}

	_, err = q.InsertHighlight(ctx, store.InsertHighlightParams{
		ID:            uuid.NewString(),
		DocumentID:    run.DocumentID,
		PipelineRunID: run.ID,
		Kind:          "summary",
		Title:         doc.Title,
		Body:          body,
		Metadata:      string(meta),
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_summarize: insert highlight: %w", err)
	}

	return StepResult{Done: true}, nil
}
