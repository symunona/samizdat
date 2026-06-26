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
	Register("llm_ai_newsletter", handleLLMAINewsletter)
}

type aiNewsletterConfig struct {
	Model    string `json:"model"`
	Provider string `json:"provider"`
	BaseURL  string `json:"base_url"`
	APIKey   string `json:"api_key"`
}

type aiNewsletterHighlight struct {
	Kind  string          `json:"kind"`
	Title string          `json:"title"`
	Body  json.RawMessage `json:"body"`
}

// bodyString coerces body from either a JSON string or JSON array of strings into markdown.
func (h aiNewsletterHighlight) bodyString() string {
	if len(h.Body) == 0 {
		return ""
	}
	if h.Body[0] == '"' {
		var s string
		_ = json.Unmarshal(h.Body, &s)
		return s
	}
	var items []string
	_ = json.Unmarshal(h.Body, &items)
	return buildBullets(items)
}

type aiNewsletterResponse struct {
	Summary    []string                `json:"summary"`
	Highlights []aiNewsletterHighlight `json:"highlights"`
}

const aiNewsletterSystemPrompt = `You analyze AI/ML newsletters. Return ONLY valid JSON, no prose, no markdown fences.

Schema:
{
  "summary": string[],
  "highlights": [{"kind": string, "title": string, "body": string}]
}

SUMMARY RULES — ultra caveman:
- Max 7 bullets. Each: [thing] [action] [why it matters].
- Drop: articles (a/an/the), filler words (just/really/basically/actually/simply/notably), hedges (seems/appears/might), pleasantries, intros, outros.
- Fragments OK. Short synonyms (big not extensive, fix not implement solution).
- Only most relevant AI/ML topics. Boring/thin newsletter = fewer bullets.
- Bold the key topic/name of each bullet: **keyword** at start or where it naturally lands. One bold per bullet.

CONDITIONAL HIGHLIGHTS — include only if genuinely present in document:
Body of each highlight: bullet list, one bullet per WWWWH element where it makes sense (*Who* made it · *What* it is/does · *When/Where* available · *Why* it matters · *How* to use/get it). Caveman style. Italicize the WWWWH label (*Who*, *What*, etc); bold the sentence's keyword (**key name/term**) in each bullet. No prose paragraphs — bullets only.

1. kind="frontier_model" — new frontier/SOTA proprietary model announced (GPT-X, Claude X, Gemini X, Grok X, etc). Title: model name. Body: WWWWH + benchmark delta. Skip if just mentioned in passing.
2. kind="tool" — new tool/product/library/service worth knowing. Title: tool name. Body: WWWWH. One highlight per distinct tool.
3. kind="local_model" — new locally-hostable open-weight model worth trying (weights downloadable, runs on consumer GPU). Title: model name. Body: WWWWH + param size + how to run.
4. kind="opus_equivalent" — open-weight model that approximates Claude Opus 4.5 capability (top-tier reasoning, code, long context). Title: "⭐ [model name] ~ Opus 4.5". Body: WWWWH + benchmarks vs frontier. High bar — only include if genuinely competitive.

Return [] for highlights if none qualify. Never invent highlights not in document.

CAVEMAN COMMUNICATION GUIDELINES (apply to all output):
- Drop all articles: a, an, the
- Drop filler: just, really, basically, actually, simply, notably, essentially
- Drop hedges: seems, appears, might be, arguably
- Drop pleasantries, intros ("This article covers..."), outros ("In conclusion...")
- Fragments OK. Short synonyms. Pattern: [thing] [action] [why].
- Technical terms stay exact. Code/model names stay exact.`

func handleLLMAINewsletter(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, globalClient llm.Client) (StepResult, error) {
	var c aiNewsletterConfig
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
		return StepResult{}, fmt.Errorf("llm_ai_newsletter: no LLM client configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_ai_newsletter: get document: %w", err)
	}

	content := doc.Markdown
	if len(content) > 16000 {
		content = content[:16000] + "\n\n[truncated]"
	}

	userMsg := aiNewsletterSystemPrompt + "\n\n# " + doc.Title + "\n\n" + content
	reply, usage, err := client.Complete(ctx, c.Model, []llm.Message{
		{Role: "user", Content: userMsg},
	})
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_ai_newsletter: llm call: %w", err)
	}

	// Record LLM usage.
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
	// Strip markdown fences if model wrapped response anyway.
	if strings.HasPrefix(reply, "```") {
		reply = strings.TrimPrefix(reply, "```json")
		reply = strings.TrimPrefix(reply, "```")
		if idx := strings.LastIndex(reply, "```"); idx != -1 {
			reply = reply[:idx]
		}
		reply = strings.TrimSpace(reply)
	}

	var parsed aiNewsletterResponse
	if err := json.Unmarshal([]byte(reply), &parsed); err != nil {
		return StepResult{}, fmt.Errorf("llm_ai_newsletter: parse llm json: %w\nraw: %s", err, reply)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	meta, _ := json.Marshal(map[string]string{"model": c.Model})

	// Build summary highlight body: bullet list + optional hero image.
	summaryBody := buildBullets(parsed.Summary)
	if assets, err2 := q.ListMediaAssetsByDocument(ctx, run.DocumentID); err2 == nil {
		for _, a := range assets {
			if a.Kind == "hero" {
				summaryBody = "![](/api/v1/media/" + a.ID + ")\n\n" + summaryBody
				break
			}
		}
	}

	// Insert the summary + per-topic highlights atomically (idempotent on retry).
	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
			ID:            uuid.NewString(),
			DocumentID:    run.DocumentID,
			PipelineRunID: run.ID,
			Kind:          "summary",
			Title:         doc.Title,
			Body:          summaryBody,
			Metadata:      string(meta),
			CreatedAt:     now,
			UpdatedAt:     now,
		}); err != nil {
			return fmt.Errorf("llm_ai_newsletter: insert summary highlight: %w", err)
		}

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
				Body:          h.bodyString(),
				Metadata:      string(meta),
				CreatedAt:     now,
				UpdatedAt:     now,
			}); err != nil {
				return fmt.Errorf("llm_ai_newsletter: insert highlight %q: %w", h.Title, err)
			}
		}
		return nil
	}); err != nil {
		return StepResult{}, err
	}

	return StepResult{Done: true}, nil
}

func buildBullets(items []string) string {
	if len(items) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.HasPrefix(item, "- ") && !strings.HasPrefix(item, "* ") {
			sb.WriteString("- ")
		}
		sb.WriteString(item)
		sb.WriteString("\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}
