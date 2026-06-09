package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

func init() {
	Register("extract_list_items", handleExtractListItems)
}

func handleExtractListItems(ctx context.Context, q *store.Queries, run store.PipelineRun, _ json.RawMessage, _ llm.Client) (StepResult, error) {
	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return StepResult{}, fmt.Errorf("extract_list_items: get document: %w", err)
	}

	items := extractListItems(doc.Markdown)
	if len(items) == 0 {
		return StepResult{Done: true}, nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	for _, body := range items {
		_, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
			ID:            uuid.NewString(),
			DocumentID:    run.DocumentID,
			PipelineRunID: run.ID,
			Kind:          "item",
			Body:          body,
			Metadata:      "{}",
			CreatedAt:     now,
			UpdatedAt:     now,
		})
		if err != nil {
			return StepResult{}, fmt.Errorf("extract_list_items: insert highlight: %w", err)
		}
	}

	return StepResult{Done: true}, nil
}

// extractListItems parses top-level markdown list items (- or *).
// Continuation lines (indented) are joined to their parent item.
func extractListItems(md string) []string {
	var items []string
	var current strings.Builder

	flush := func() {
		s := strings.TrimRightFunc(current.String(), unicode.IsSpace)
		if s != "" {
			items = append(items, s)
		}
		current.Reset()
	}

	for _, line := range strings.Split(md, "\n") {
		// Top-level list marker
		if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") {
			flush()
			current.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "- "), "* "))
			continue
		}
		// Continuation: indented non-empty line
		if current.Len() > 0 {
			trimmed := strings.TrimLeft(line, " \t")
			if trimmed != "" && (line[0] == ' ' || line[0] == '\t') {
				current.WriteByte('\n')
				current.WriteString(trimmed)
				continue
			}
			// Blank line while inside an item — keep collecting (multi-para items)
			if strings.TrimSpace(line) == "" {
				current.WriteByte('\n')
				continue
			}
		}
		// Non-list line with no active item — skip
	}
	flush()
	return items
}
