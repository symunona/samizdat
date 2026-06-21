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
	Register("llm_321_newsletter", handleLLM321Newsletter)
}

type nl321Config struct {
	Model    string `json:"model"`
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
}

type nl321Highlight struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

type nl321Response struct {
	Highlights []nl321Highlight `json:"highlights"`
}

const nl321SystemPrompt = `You parse James Clear's 3-2-1 newsletter. Return ONLY valid JSON, no prose, no markdown fences.

Schema:
{"highlights": [{"kind": string, "title": string, "body": string}]}

Extract exactly these 6 highlights in order:
- 3x kind="idea" — James Clear's 3 short ideas. Title: first 8 words of the idea. Body: full idea text verbatim.
- 2x kind="quote" — the 2 quotes from others. Title: attribution (author name). Body: full quote verbatim.
- 1x kind="question" — the 1 question. Title: "Question". Body: full question verbatim.

If the newsletter has a different structure, extract as many as exist. Preserve verbatim text — do not paraphrase.
Return [] if no highlights found.`

func handleLLM321Newsletter(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, globalClient llm.Client) (StepResult, error) {
	var c nl321Config
	_ = ParseStepConfig(cfg, &c)
	if c.Model == "" {
		c.Model = "claude-haiku-4-5-20251001"
	}

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
		return StepResult{}, fmt.Errorf("llm_321_newsletter: no LLM client configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_321_newsletter: get document: %w", err)
	}

	content := doc.Markdown
	if len(content) > 16000 {
		content = content[:16000] + "\n\n[truncated]"
	}

	userMsg := nl321SystemPrompt + "\n\n# " + doc.Title + "\n\n" + content
	reply, usage, err := client.Complete(ctx, c.Model, []llm.Message{
		{Role: "user", Content: userMsg},
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_321_newsletter: llm call: %w", err)
	}

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
	if strings.HasPrefix(reply, "```") {
		reply = strings.TrimPrefix(reply, "```json")
		reply = strings.TrimPrefix(reply, "```")
		if idx := strings.LastIndex(reply, "```"); idx != -1 {
			reply = reply[:idx]
		}
		reply = strings.TrimSpace(reply)
	}

	var parsed nl321Response
	if err := json.Unmarshal([]byte(reply), &parsed); err != nil {
		return StepResult{}, fmt.Errorf("llm_321_newsletter: parse llm json: %w\nraw: %s", err, reply)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	meta, _ := json.Marshal(map[string]string{"model": c.Model})

	for _, h := range parsed.Highlights {
		if h.Kind == "" || h.Title == "" {
			continue
		}
		if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
			ID:            uuid.NewString(),
			DocumentID:    run.DocumentID,
			PipelineRunID: run.ID,
			Kind:          h.Kind,
			Title:         h.Title,
			Body:          h.Body,
			Metadata:      string(meta),
			CreatedAt:     now,
			UpdatedAt:     now,
		}); err != nil {
			return StepResult{}, fmt.Errorf("llm_321_newsletter: insert highlight %q: %w", h.Title, err)
		}
	}

	return StepResult{Done: true}, nil
}
