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

const kindLLMTopics = "llm_topics"

func init() {
	Register(KindSpec{
		Kind:        kindLLMTopics,
		Label:       "Split into topics",
		Description: "One highlight per newsletter section, body kept verbatim.",
		Fields:      llmCommonFields(topicsDefaultPrompt),
	}, handleLLMTopics)
}

type topicHighlight struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type topicsResponse struct {
	Highlights []topicHighlight `json:"highlights"`
}

// topicsDefaultPrompt splits ANY newsletter into its distinct sections/topics. Unlike
// llm_summarize / llm_ai_newsletter, it does NOT summarize — each topic body is the
// section's original text, verbatim. Source language is preserved.
const topicsDefaultPrompt = `You split a newsletter into its distinct topics/sections. Return ONLY valid JSON, no prose, no markdown fences.

Schema:
{"highlights": [{"title": string, "body": string}]}

Rules:
- One highlight per distinct topic/section/story in the newsletter, in document order.
- title: the section's own headline/first line, trimmed to a short heading.
- body: that section's FULL text, VERBATIM. Do NOT summarize, paraphrase, shorten, translate, or add commentary. Copy the original wording exactly.
- Reply in the same language as the newsletter.
- Skip pure boilerplate (greeting salutations, unsubscribe footer, "view in browser").
- Return {"highlights": []} if there are no real topics.` + promptTemplateTail

func handleLLMTopics(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, router *llm.Router) (StepResult, error) {
	var c llmStepConfig
	_ = ParseStepConfig(cfg, &c)
	// Unset model = the configured provider's default_model (see step_llm_summarize).
	if c.Prompt == "" {
		c.Prompt = defaultPrompt(kindLLMTopics)
	}

	if !router.Configured() {
		return StepResult{}, fmt.Errorf("llm_topics: no LLM provider configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_topics: get document: %w", err)
	}

	// Unwrap the legacy ``` fence a plaintext email used to get so the model sees
	// prose, not one code literal.
	out, err := llmStepCallLong(ctx, q, run, longRequest{
		Kind:    kindLLMTopics,
		Cfg:     c,
		Title:   doc.Title,
		Content: StripCodeFence(doc.Markdown),
	}, router)
	if err != nil {
		return StepResult{}, err
	}
	if !out.Step.Done {
		return out.Step, nil
	}
	// out.Note is deliberately dropped: this step's reply is parsed as JSON and
	// splits into several Highlights, so there is no one body to disclose on. The
	// cut is still recorded in each Highlight's provenance (`truncated`).
	reply, meta := strings.TrimSpace(out.Reply), out.Meta
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
				Metadata:      meta,
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
