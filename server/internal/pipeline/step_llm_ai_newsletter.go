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

const kindLLMAINewsletter = "llm_ai_newsletter"

func init() {
	Register(KindSpec{
		Kind:        kindLLMAINewsletter,
		Label:       "AI newsletter",
		Description: "Caveman summary plus per-item highlights (models, tools, local models), deduped against recent issues.",
		Fields: append(llmCommonFields(aiNewsletterDefaultPrompt),
			FieldSpec{Key: "skip_summary", Label: "Skip summary", Type: "bool", Default: false, Help: "Emit only the item highlights, no bulleted summary."},
			FieldSpec{Key: "dedup_lookback_days", Label: "Dedup lookback (days)", Type: "int", Default: 7, Help: "How far back to look for already-covered items. 0 = 7."},
		),
	}, handleLLMAINewsletter)
}

type aiNewsletterConfig struct {
	llmStepConfig
	// SkipSummary emits only the topic highlights, no bulleted "summary" highlight.
	SkipSummary bool `json:"skip_summary"`
	// DedupLookbackDays: feed the model the topic highlights from this feed's issues
	// over the last N days so it doesn't re-extract stories already covered. 0 = 7.
	DedupLookbackDays int `json:"dedup_lookback_days"`
}

// dedupItemLimit caps how many recent headlines are injected (token budget).
const dedupItemLimit = 40

// recentlyCoveredBlock builds the "ALREADY COVERED" prompt section from the topic
// highlights of this feed's other recent documents: title + first body line each.
// Empty string when there's nothing to dedup against.
func recentlyCoveredBlock(ctx context.Context, q *store.Queries, doc store.Document, lookbackDays int) string {
	if doc.SourceFeedID == nil {
		return ""
	}
	if lookbackDays <= 0 {
		lookbackDays = 7
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -lookbackDays).Format(time.RFC3339)
	rows, err := q.ListRecentTopicHighlightsByFeed(ctx, store.ListRecentTopicHighlightsByFeedParams{
		SourceFeedID: doc.SourceFeedID,
		DocumentID:   doc.ID,
		CreatedAt:    cutoff,
		Limit:        dedupItemLimit,
	})
	if err != nil || len(rows) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("\n\nALREADY COVERED in recent issues — do NOT create a highlight for any item already on this list (match fuzzily on the name/model/tool, ignoring wording). Only extract genuinely NEW items, or an existing one that has materially new information:\n")
	for _, r := range rows {
		first := r.Body
		if nl := strings.IndexByte(first, '\n'); nl >= 0 {
			first = first[:nl]
		}
		first = strings.TrimSpace(strings.TrimLeft(first, "-* "))
		line := "- [" + r.Kind + "] " + r.Title
		if first != "" {
			line += " — " + first
		}
		sb.WriteString(line)
		sb.WriteString("\n")
	}
	return strings.TrimRight(sb.String(), "\n")
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

const aiNewsletterDefaultPrompt = `You analyze AI/ML newsletters. Return ONLY valid JSON, no prose, no markdown fences.

Schema:
{
  "summary": string[],
  "highlights": [{"kind": string, "title": string, "body": string[]}]
}
body is an ARRAY of strings — one bullet per element. Never a single string. Each element is one WWWWH bullet.

SUMMARY RULES — ultra caveman:
- Max 7 bullets. Each: [thing] [action] [why it matters].
- Drop: articles (a/an/the), filler words (just/really/basically/actually/simply/notably), hedges (seems/appears/might), pleasantries, intros, outros.
- Fragments OK. Short synonyms (big not extensive, fix not implement solution).
- Only most relevant AI/ML topics. Boring/thin newsletter = fewer bullets.
- Bold the key topic/name of each bullet: **keyword** at start or where it naturally lands. One bold per bullet.

CONDITIONAL HIGHLIGHTS — include only if genuinely present in document:
body is a string ARRAY, one element per WWWWH bullet where it makes sense (*Who* made it · *What* it is/does · *When/Where* available · *Why* it matters · *How* to use/get it). Caveman style. Each array element = one bullet, do NOT prefix with "- " and do NOT join into one string. Italicize the WWWWH label (*Who*, *What*, etc); bold the sentence's keyword (**key name/term**) in each bullet. No prose paragraphs — bullets only.

1. kind="frontier_model" — new frontier/SOTA proprietary model announced (GPT-X, Claude X, Gemini X, Grok X, etc). Title: model name. Body: WWWWH + benchmark delta. Skip if just mentioned in passing.
2. kind="tool" — new tool/product/library/service worth knowing. Title: tool name. Body: WWWWH. One highlight per distinct tool.
3. kind="local_model" — new locally-hostable open-weight model worth trying (weights downloadable, runs on consumer GPU). Title: model name. Body: WWWWH + param size + how to run.
4. kind="opus_equivalent" — open-weight model that approximates Claude Opus 4.5 capability (top-tier reasoning, code, long context). Title: "⭐ [model name] ~ Opus 4.5". Body: WWWWH + benchmarks vs frontier. High bar — only include if genuinely competitive.

Return [] for highlights if none qualify. Never invent highlights not in document.
If an "ALREADY COVERED" list is provided below the schema, treat it as items from recent issues that are ALREADY captured: do NOT emit a highlight for anything on it (match fuzzily on the name/model/tool). Only emit genuinely new items, or a listed one that has materially new information.

CAVEMAN COMMUNICATION GUIDELINES (apply to all output):
- Drop all articles: a, an, the
- Drop filler: just, really, basically, actually, simply, notably, essentially
- Drop hedges: seems, appears, might be, arguably
- Drop pleasantries, intros ("This article covers..."), outros ("In conclusion...")
- Fragments OK. Short synonyms. Pattern: [thing] [action] [why].
- Technical terms stay exact. Code/model names stay exact.` + promptTemplateTail

func handleLLMAINewsletter(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, router *llm.Router) (StepResult, error) {
	var c aiNewsletterConfig
	_ = ParseStepConfig(cfg, &c)
	// Unset model = the configured provider's default_model (see step_llm_summarize).
	if c.Prompt == "" {
		c.Prompt = defaultPrompt(kindLLMAINewsletter)
	}

	if !router.Configured() {
		return StepResult{}, fmt.Errorf("llm_ai_newsletter: no LLM provider configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_ai_newsletter: get document: %w", err)
	}

	content := doc.Markdown
	if len(content) > 16000 {
		content = content[:16000] + "\n\n[truncated]"
	}

	seen := recentlyCoveredBlock(ctx, q, doc, c.DedupLookbackDays)
	userMsg := renderPrompt(c.Prompt, map[string]string{
		"title": doc.Title, "content": content, "recently_covered": seen,
	})
	reply, meta, err := llmStepCall(ctx, q, run, kindLLMAINewsletter, c.llmStepConfig, userMsg, router)
	if err != nil {
		return StepResult{}, err
	}

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

	// Build summary highlight body: bullet list + optional hero image. Strip a
	// leading title echo so the card doesn't double the title.
	summaryBody := StripLeadingTitle(buildBullets(parsed.Summary), doc.Title)
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
		// skip_summary pipelines (e.g. Latent Space) want topic highlights only.
		if !c.SkipSummary && summaryBody != "" {
			if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
				ID:            uuid.NewString(),
				DocumentID:    run.DocumentID,
				PipelineRunID: run.ID,
				Kind:          "summary",
				Title:         doc.Title,
				Body:          summaryBody,
				Metadata:      meta,
				CreatedAt:     now,
				UpdatedAt:     now,
			}); err != nil {
				return fmt.Errorf("llm_ai_newsletter: insert summary highlight: %w", err)
			}
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
				Metadata:      meta,
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
