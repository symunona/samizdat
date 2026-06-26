package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

func init() {
	Register("extract_images", handleExtractImages)
}

type extractImagesConfig struct {
	// MaxImages limits how many image highlights to create (0 = all).
	MaxImages int `json:"max_images"`
}

// mdImageRe matches ![alt](url) in markdown.
var mdImageRe = regexp.MustCompile(`!\[([^\]]*)\]\((https?://[^)\s]+)\)`)

func handleExtractImages(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, _ llm.Client) (StepResult, error) {
	var c extractImagesConfig
	_ = ParseStepConfig(cfg, &c)

	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("extract_images: get document: %w", err)
	}

	matches := mdImageRe.FindAllStringSubmatch(doc.Markdown, -1)
	now := time.Now().UTC().Format(time.RFC3339)

	// Insert all image highlights atomically so a mid-loop failure rolls back and
	// a retry replaces rather than appends (no duplicates).
	if err := InsertTx(ctx, q, func(q *store.Queries) error {
		seen := map[string]bool{}
		count := 0
		for _, m := range matches {
			url := m[2]
			if seen[url] {
				continue
			}
			seen[url] = true

			body := m[0] // the full ![alt](url) markdown

			meta, _ := json.Marshal(map[string]string{"image_url": url})
			if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
				ID:            uuid.NewString(),
				DocumentID:    run.DocumentID,
				PipelineRunID: run.ID,
				Kind:          "image",
				Title:         doc.Title,
				Body:          body,
				Metadata:      string(meta),
				CreatedAt:     now,
				UpdatedAt:     now,
			}); err != nil {
				return fmt.Errorf("extract_images: insert highlight: %w", err)
			}

			count++
			if c.MaxImages > 0 && count >= c.MaxImages {
				break
			}
		}
		return nil
	}); err != nil {
		return StepResult{}, err
	}

	return StepResult{Done: true}, nil
}
