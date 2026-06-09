package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

func init() {
	Register("extract_links", handleExtractLinks)
}

// extractLinksState is stored in pipeline_runs.state while this step is in progress.
type extractLinksState struct {
	Phase   string             `json:"phase"` // "" | "waiting" | "done"
	Pending []pendingLinkScrape `json:"pending,omitempty"`
	Done    []doneLink         `json:"done,omitempty"`
}

type pendingLinkScrape struct {
	URL     string `json:"url"`
	Text    string `json:"text"`
	JobID   string `json:"job_id"`
}

type doneLink struct {
	URL     string `json:"url"`
	Text    string `json:"text"`
	DocID   string `json:"doc_id"`
	Excerpt string `json:"excerpt"`
}

// mdLinkRe matches [text](url) in markdown — but not image links ![alt](url).
// We detect and skip image links by checking the preceding byte.
var mdLinkRe = regexp.MustCompile(`\[([^\]]+)\]\((https?://[^)\s]+)\)`)

func handleExtractLinks(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, _ llm.Client) (StepResult, error) {
	var state extractLinksState
	if run.State != "" && run.State != "{}" {
		if err := json.Unmarshal([]byte(run.State), &state); err != nil {
			return StepResult{}, fmt.Errorf("extract_links: parse state: %w", err)
		}
	}

	now := time.Now().UTC().Format(time.RFC3339)

	// Phase 1: initial extraction
	if state.Phase == "" {
		doc, err := q.GetDocumentByID(ctx, run.DocumentID)
		if err != nil {
			return StepResult{}, fmt.Errorf("extract_links: get document: %w", err)
		}

		links := extractMarkdownLinks(doc.Markdown)
		var pending []pendingLinkScrape
		var done []doneLink

		for _, link := range links {
			// Check if already scraped
			existing, err := q.GetDocumentByCanonicalURL(ctx, link.url)
			if err == nil && existing.ID != "" {
				done = append(done, doneLink{
					URL:     link.url,
					Text:    link.text,
					DocID:   existing.ID,
					Excerpt: existing.Excerpt,
				})
				continue
			}

			// Enqueue scrape job
			payload, _ := json.Marshal(map[string]string{"url": link.url})
			jobID := uuid.NewString()
			_, err = q.InsertJob(ctx, store.InsertJobParams{
				ID:        jobID,
				Kind:      "scrape_url",
				Payload:   string(payload),
				RunAfter:  now,
				CreatedAt: now,
				UpdatedAt: now,
			})
			if err != nil {
				continue
			}
			pending = append(pending, pendingLinkScrape{
				URL:   link.url,
				Text:  link.text,
				JobID: jobID,
			})
		}

		// Flush already-done links as highlights immediately
		for _, dl := range done {
			if err := createLinkHighlight(ctx, q, run, dl, now); err != nil {
				return StepResult{}, err
			}
		}

		if len(pending) == 0 {
			return StepResult{Done: true}, nil
		}

		state = extractLinksState{Phase: "waiting", Pending: pending, Done: done}
		stateJSON, _ := json.Marshal(state)
		return StepResult{Done: false, NewState: string(stateJSON)}, nil
	}

	// Phase 2: poll pending jobs
	if state.Phase == "waiting" {
		var stillPending []pendingLinkScrape

		for _, p := range state.Pending {
			job, err := q.GetJob(ctx, p.JobID)
			if err != nil {
				// Job gone — skip
				continue
			}
			switch job.Status {
			case "done":
				// Extract document_id from job result
				var result struct {
					DocumentID string `json:"document_id"`
				}
				_ = json.Unmarshal([]byte(job.Result), &result)
				if result.DocumentID == "" {
					continue
				}
				doc, err := q.GetDocumentByID(ctx, result.DocumentID)
				if err != nil {
					continue
				}
				dl := doneLink{
					URL:     p.URL,
					Text:    p.Text,
					DocID:   doc.ID,
					Excerpt: doc.Excerpt,
				}
				if err := createLinkHighlight(ctx, q, run, dl, now); err != nil {
					return StepResult{}, err
				}
			case "dead":
				// Failed — skip this link
			default:
				stillPending = append(stillPending, p)
			}
		}

		if len(stillPending) == 0 {
			return StepResult{Done: true}, nil
		}

		state.Pending = stillPending
		stateJSON, _ := json.Marshal(state)
		return StepResult{Done: false, NewState: string(stateJSON)}, nil
	}

	return StepResult{Done: true}, nil
}

func createLinkHighlight(ctx context.Context, q *store.Queries, run store.PipelineRun, dl doneLink, now string) error {
	body := fmt.Sprintf("**[%s](%s)**", dl.Text, dl.URL)
	if dl.Excerpt != "" {
		body += "\n\n" + dl.Excerpt
	}
	meta, _ := json.Marshal(map[string]string{"link_url": dl.URL, "linked_doc_id": dl.DocID})

	_, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
		ID:            uuid.NewString(),
		DocumentID:    run.DocumentID,
		PipelineRunID: run.ID,
		Kind:          "link",
		Title:         "",
		Body:          body,
		Metadata:      string(meta),
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	return err
}

type mdLink struct {
	text string
	url  string
}

// imageExts are URL patterns that indicate a media asset, not an article.
var imageExts = []string{".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".ico", "substackcdn.com", "substack-media", "/image/fetch/"}

func isMediaURL(u string) bool {
	lower := strings.ToLower(u)
	for _, ext := range imageExts {
		if strings.Contains(lower, ext) {
			return true
		}
	}
	return false
}

func extractMarkdownLinks(md string) []mdLink {
	locs := mdLinkRe.FindAllStringSubmatchIndex(md, -1)
	seen := map[string]bool{}
	var links []mdLink
	for _, loc := range locs {
		// loc[0] is start of full match — skip if preceded by '!'
		if loc[0] > 0 && md[loc[0]-1] == '!' {
			continue
		}
		text := strings.TrimSpace(md[loc[2]:loc[3]])
		url := strings.TrimSpace(md[loc[4]:loc[5]])
		if seen[url] || url == "" || isMediaURL(url) {
			continue
		}
		seen[url] = true
		links = append(links, mdLink{text: text, url: url})
	}
	return links
}
