package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

const kindLLM321Newsletter = "llm_321_newsletter"

func init() {
	Register(KindSpec{
		Kind:        kindLLM321Newsletter,
		Label:       "3-2-1 newsletter",
		Description: "Extracts James Clear's 3 ideas, 2 quotes and 1 question as highlights.",
		Fields:      llmCommonFields(nl321DefaultPrompt),
	}, handleLLM321Newsletter)
}

type nl321Highlight struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

const nl321DefaultPrompt = `You parse James Clear's 3-2-1 newsletter. Return ONLY valid JSON, no prose, no markdown fences.

Schema:
{"highlights": [{"kind": string, "title": string, "body": string}]}

Extract exactly these 6 highlights in order:
- 3x kind="idea" — James Clear's 3 short ideas. Title: the first sentence of the idea, at most 10 words. Body: full idea text verbatim.
- 2x kind="quote" — the 2 quotes from others. Title: attribution (author name). Body: full quote verbatim.
- 1x kind="question" — the 1 question. Title: "Question". Body: full question verbatim.

If the newsletter has a different structure, extract as many as exist. Preserve verbatim text — do not paraphrase.
Return [] if no highlights found.` + promptTemplateTail

func handleLLM321Newsletter(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, router *llm.Router) (StepResult, error) {
	var c llmStepConfig
	_ = ParseStepConfig(cfg, &c)
	// Unset model = the configured provider's default_model (see step_llm_summarize).
	if c.Prompt == "" {
		c.Prompt = defaultPrompt(kindLLM321Newsletter)
	}

	if !router.Configured() {
		return StepResult{}, fmt.Errorf("llm_321_newsletter: no LLM provider configured")
	}

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("llm_321_newsletter: get document: %w", err)
	}

	out, err := llmStepCallLong(ctx, q, run, longRequest{
		Kind:    kindLLM321Newsletter,
		Cfg:     c,
		Title:   doc.Title,
		Content: doc.Markdown,
	}, router)
	if err != nil {
		return StepResult{}, err
	}
	if !out.Step.Done {
		return out.Step, nil
	}
	// out.Note dropped for the same reason as llm_topics: a parsed reply, many
	// Highlights, no single body to disclose on. Provenance keeps `truncated`.
	meta := out.Meta
	// AllReplies is one reply (small/big band) or one per chunk (partition band,
	// the default for this step — see chunkStrategyFor); either way every reply
	// is decoded and the results unioned, never folded.
	var highlights []nl321Highlight
	for _, reply := range out.AllReplies() {
		hs, err := DecodeLLMList[nl321Highlight](reply, "highlights", "llm_321_newsletter")
		if err != nil {
			return StepResult{}, err
		}
		highlights = append(highlights, hs...)
	}
	// Chunk overlap can hand the same idea/quote to two adjacent chunk calls.
	highlights = dedupeByBody(highlights, func(h nl321Highlight) string { return h.Body })

	now := time.Now().UTC().Format(time.RFC3339)

	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		for _, h := range highlights {
			if h.Kind == "" || h.Title == "" {
				continue
			}
			// Ideas: title = first sentence, capped at 10 words (enforced here so it
			// can't drift even if the model over-runs). Quotes keep the attribution,
			// the question keeps "Question".
			if h.Kind == "idea" {
				if t := firstSentenceTitle(h.Body, 10); t != "" {
					h.Title = t
				}
			}
			if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
				ID:            uuid.NewString(),
				DocumentID:    run.DocumentID,
				PipelineRunID: run.ID,
				Kind:          h.Kind,
				Title:         h.Title,
				Body:          h.Body,
				Metadata:      meta,
				CreatedAt:     now,
				UpdatedAt:     now,
			}); err != nil {
				return fmt.Errorf("llm_321_newsletter: insert highlight %q: %w", h.Title, err)
			}
		}
		return nil
	}); err != nil {
		return StepResult{}, err
	}

	return StepResult{Done: true}, nil
}
