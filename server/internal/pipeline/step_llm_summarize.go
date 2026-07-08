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

// notParseableToken is the sentinel the summarizer emits when it judges the input
// to be a bot page / login wall / empty stub rather than real article content —
// the LLM layer of false-parse detection, catching cases the heuristic misses.
const notParseableToken = "__NOT_PARSEABLE__"

type llmSummarizeConfig struct {
	Model    string `json:"model"`
	Prompt   string `json:"prompt"`
	Provider string `json:"provider"` // optional: override global client provider
	BaseURL  string `json:"base_url"` // optional: override base URL (for openai_compat)
	APIKey   string `json:"api_key"`  // optional: override API key
}

func handleLLMSummarize(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, globalClient llm.Client) (StepResult, error) {
	var c llmSummarizeConfig
	_ = ParseStepConfig(cfg, &c)
	if c.Model == "" {
		c.Model = "claude-haiku-4-5-20251001"
	}
	if c.Prompt == "" {
		c.Prompt = "Summarize as caveman. Rules: drop all articles (a/an/the), drop filler words (just/really/basically/actually/simply/notably), drop hedges (seems/appears/might), no pleasantries, no intro, no outro. Fragments OK. Short synonyms (big not extensive, fix not implement a solution). Max 3 bullets. Pattern: [thing] [action] [why it matters]. Bold the key topic/name of each bullet: **keyword** where it naturally lands — one bold per bullet. Boring or thin = one line. Never start with 'This article'. NO heading and NO title line — do not repeat or restate the article title; start straight with the first bullet (the title is shown separately). IMPORTANT: if content is empty, image-only, or has no meaningful text to summarize, return exactly empty string — nothing else. If the input is NOT a real article — a bot check ('checking your browser', 'verify you are human'), a login or paywall wall, a CAPTCHA, or an error/teaser stub with no article body — respond with EXACTLY " + notParseableToken + " on a single line and nothing else."
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
	reply, usage, err := client.Complete(ctx, c.Model, []llm.Message{
		{Role: "user", Content: userMsg},
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_summarize: llm call: %w", err)
	}

	// Record LLM usage regardless of whether we use the reply.
	_ = q.InsertLLMUsage(ctx, store.InsertLLMUsageParams{
		ID:            uuid.NewString(),
		JobID:         ParentJobIDFromCtx(ctx),
		PipelineRunID: &run.ID,
		Provider:      usage.Provider,
		Model:         c.Model,
		InputTokens:   int64(usage.InputTokens),
		OutputTokens:  int64(usage.OutputTokens),
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	})

	reply = strings.TrimSpace(reply)

	// LLM layer of false-parse detection: the model flagged this as a bot page /
	// login wall / empty stub. Flag the Document and fail permanently — no highlight,
	// and the worker won't retry (re-running would just re-burn tokens).
	if strings.HasPrefix(reply, notParseableToken) {
		now := time.Now().UTC().Format(time.RFC3339)
		if err := q.MarkDocumentError(ctx, store.MarkDocumentErrorParams{
			ErrorReason: ReasonUnparseable,
			UpdatedAt:   now,
			ID:          run.DocumentID,
		}); err != nil {
			return StepResult{}, fmt.Errorf("llm_summarize: mark document error: %w", err)
		}
		return StepResult{}, &FalseParseError{Reason: ReasonUnparseable}
	}

	// Drop any leading heading / echoed title so the card doesn't show a double
	// title (the Highlight.Title field already carries doc.Title).
	reply = StripLeadingTitle(reply, doc.Title)
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

	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		_, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
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
			return fmt.Errorf("insert summary highlight: %w", err)
		}
		return nil
	}); err != nil {
		return StepResult{}, fmt.Errorf("llm_summarize: insert highlight: %w", err)
	}

	return StepResult{Done: true}, nil
}
