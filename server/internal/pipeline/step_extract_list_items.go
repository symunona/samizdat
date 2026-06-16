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

// itemPhase tracks each list item independently through scrape → summary → enrich.
type itemPhase string

const (
	itemPhaseScraping    itemPhase = "scraping"
	itemPhaseSummarizing itemPhase = "summarizing"
	itemPhaseDone        itemPhase = "done"
	itemPhaseNoLink      itemPhase = "no_link" // item has no URL, highlight stays as-is
)

type trackedItem struct {
	Phase         itemPhase `json:"phase"`
	HighlightID   string    `json:"highlight_id"`
	URL           string    `json:"url,omitempty"`
	ScrapeJobID   string    `json:"scrape_job_id,omitempty"` // "existing:docID" sentinel when already scraped
	DocumentID    string    `json:"document_id,omitempty"`
	PipelineRunID string    `json:"pipeline_run_id,omitempty"`
}

type extractListItemsState struct {
	Items []trackedItem `json:"items"`
}

type extractListItemsConfig struct {
	// SkipNewScrapes: only enrich items whose URLs are already scraped; never enqueue new scrape jobs.
	SkipNewScrapes bool `json:"skip_new_scrapes"`
}

func handleExtractListItems(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, _ llm.Client) (StepResult, error) {
	var c extractListItemsConfig
	_ = ParseStepConfig(cfg, &c)
	var state extractListItemsState
	if run.State != "" && run.State != "{}" {
		if err := json.Unmarshal([]byte(run.State), &state); err != nil {
			return StepResult{}, fmt.Errorf("extract_list_items: parse state: %w", err)
		}
	}

	// First invocation: parse document and create initial items.
	if len(state.Items) == 0 {
		var err error
		state, err = initItems(ctx, q, run, c.SkipNewScrapes)
		if err != nil {
			return StepResult{}, err
		}
	}

	// Find the Summarizer pipeline once per tick.
	summarizerID, _ := findSummarizerPipeline(ctx, q)

	now := time.Now().UTC().Format(time.RFC3339)
	allDone := true

	for i := range state.Items {
		item := &state.Items[i]
		switch item.Phase {
		case itemPhaseNoLink, itemPhaseDone:
			// nothing to do

		case itemPhaseScraping:
			allDone = false
			advanceScraping(ctx, q, item, summarizerID)

		case itemPhaseSummarizing:
			allDone = false
			advanceSummarizing(ctx, q, item, run.ID, now)
		}
	}

	if allDone {
		return StepResult{Done: true}, nil
	}

	stateJSON, _ := json.Marshal(state)
	return StepResult{Done: false, NewState: string(stateJSON)}, nil
}

// initItems parses the document and creates one highlight + trackedItem per list entry.
func initItems(ctx context.Context, q *store.Queries, run store.PipelineRun, skipNewScrapes bool) (extractListItemsState, error) {
	doc, err := q.GetDocumentByID(ctx, run.DocumentID)
	if err != nil {
		return extractListItemsState{}, fmt.Errorf("extract_list_items: get document: %w", err)
	}

	rawItems := extractListItems(doc.Markdown)
	// Prose-only post: no bullet/list items found. Fall back to paragraph chunks
	// so the step produces at least some highlights instead of silently finishing
	// with nothing.
	if len(rawItems) == 0 {
		rawItems = extractProseParagraphs(doc.Markdown)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	var tracked []trackedItem

	for _, body := range rawItems {
		hlID := uuid.NewString()
		if _, err := q.InsertHighlight(ctx, store.InsertHighlightParams{
			ID:            hlID,
			DocumentID:    run.DocumentID,
			PipelineRunID: run.ID,
			Kind:          "item",
			Title:         doc.Title,
			Body:          body,
			Metadata:      "{}",
			CreatedAt:     now,
			UpdatedAt:     now,
		}); err != nil {
			return extractListItemsState{}, fmt.Errorf("extract_list_items: insert highlight: %w", err)
		}

		links := extractMarkdownLinks(body)
		if len(links) == 0 {
			tracked = append(tracked, trackedItem{Phase: itemPhaseNoLink, HighlightID: hlID})
			continue
		}
		url := links[0].url

		// Already scraped?
		existing, err := q.GetDocumentByCanonicalURL(ctx, url)
		if err == nil && existing.ID != "" {
			if skipNewScrapes {
				// skip_new_scrapes: don't poll the summarizer cycle; highlight
				// body already has the original list-item text — leave it as-is.
				tracked = append(tracked, trackedItem{Phase: itemPhaseDone, HighlightID: hlID})
			} else {
				tracked = append(tracked, trackedItem{
					Phase:       itemPhaseScraping,
					HighlightID: hlID,
					URL:         url,
					ScrapeJobID: "existing:" + existing.ID,
				})
			}
			continue
		}

		if skipNewScrapes {
			tracked = append(tracked, trackedItem{Phase: itemPhaseNoLink, HighlightID: hlID})
			continue
		}

		// Enqueue scrape job.
		payload, _ := json.Marshal(map[string]string{"url": url})
		jobID := uuid.NewString()
		if _, err := q.InsertJob(ctx, store.InsertJobParams{
			ID:          jobID,
			Kind:        "scrape_url",
			Payload:     string(payload),
			RunAfter:    now,
			CreatedAt:   now,
			UpdatedAt:   now,
			ParentJobID: ParentJobIDFromCtx(ctx),
		}); err != nil {
			// Enqueue failed — treat as no-link.
			tracked = append(tracked, trackedItem{Phase: itemPhaseNoLink, HighlightID: hlID})
			continue
		}
		tracked = append(tracked, trackedItem{
			Phase:       itemPhaseScraping,
			HighlightID: hlID,
			URL:         url,
			ScrapeJobID: jobID,
		})
	}

	return extractListItemsState{Items: tracked}, nil
}

// advanceScraping checks the scrape job; on completion resolves the document ID
// and transitions to itemPhaseSummarizing (finding the auto-triggered pipeline run).
func advanceScraping(ctx context.Context, q *store.Queries, item *trackedItem, summarizerID string) {
	// Resolve document ID.
	var docID string
	if after, ok := strings.CutPrefix(item.ScrapeJobID, "existing:"); ok {
		docID = after
	} else {
		job, err := q.GetJob(ctx, item.ScrapeJobID)
		if err != nil {
			return // job gone, keep waiting
		}
		switch job.Status {
		case "done":
			var res struct{ DocumentID string `json:"document_id"` }
			_ = json.Unmarshal([]byte(job.Result), &res)
			docID = res.DocumentID
		case "dead":
			item.Phase = itemPhaseDone // failed — leave highlight as-is
			return
		default:
			return // still running
		}
	}
	if docID == "" {
		item.Phase = itemPhaseDone
		return
	}
	item.DocumentID = docID

	if summarizerID == "" {
		item.Phase = itemPhaseDone // no summarizer, skip enrichment
		return
	}

	// Try to find the auto-triggered pipeline run.
	pr, err := q.GetPipelineRunByDocumentAndPipeline(ctx, store.GetPipelineRunByDocumentAndPipelineParams{
		DocumentID: docID,
		PipelineID: summarizerID,
	})
	if err != nil {
		// Not yet — triggerPipelines fires after scrape, may take one more tick.
		item.ScrapeJobID = "existing:" + docID // mark doc as resolved, just waiting for run
		return
	}
	item.PipelineRunID = pr.ID
	item.Phase = itemPhaseSummarizing
}

// advanceSummarizing polls the pipeline run; when done it enriches the highlight body.
func advanceSummarizing(ctx context.Context, q *store.Queries, item *trackedItem, runID, now string) {
	if item.PipelineRunID == "" {
		// Run ID not yet known — try to find it.
		summarizerID, _ := findSummarizerPipeline(ctx, q)
		if summarizerID == "" || item.DocumentID == "" {
			item.Phase = itemPhaseDone
			return
		}
		pr, err := q.GetPipelineRunByDocumentAndPipeline(ctx, store.GetPipelineRunByDocumentAndPipelineParams{
			DocumentID: item.DocumentID,
			PipelineID: summarizerID,
		})
		if err != nil {
			return // still not created
		}
		item.PipelineRunID = pr.ID
	}

	pr, err := q.GetPipelineRun(ctx, item.PipelineRunID)
	if err != nil {
		return // run gone, keep waiting
	}
	if pr.Status == "failed" {
		item.Phase = itemPhaseDone // summarizer failed, leave highlight as-is
		return
	}
	if pr.Status != "done" {
		return // still running
	}

	// Find the summary highlight for this document.
	hls, err := q.ListHighlightsByDocument(ctx, item.DocumentID)
	if err != nil {
		item.Phase = itemPhaseDone
		return
	}
	var summaryBody string
	for _, hl := range hls {
		if hl.Kind == "summary" && hl.DeletedAt == nil {
			summaryBody = hl.Body
			break
		}
	}
	if summaryBody == "" {
		item.Phase = itemPhaseDone // no summary produced, leave as-is
		return
	}

	// Fetch current highlight body and append summary.
	hlList, err := q.ListHighlightsByPipelineRun(ctx, runID)
	if err != nil {
		item.Phase = itemPhaseDone
		return
	}
	for _, hl := range hlList {
		if hl.ID == item.HighlightID {
			enriched := hl.Body + "\n\n---\n**Summary:** " + summaryBody
			_ = q.UpdateHighlightBody(ctx, store.UpdateHighlightBodyParams{
				Body:      enriched,
				UpdatedAt: now,
				ID:        item.HighlightID,
			})
			break
		}
	}
	item.Phase = itemPhaseDone
}

// findSummarizerPipeline returns the ID of the first enabled pipeline whose
// filter is "{}" and contains an llm_summarize step.
func findSummarizerPipeline(ctx context.Context, q *store.Queries) (string, error) {
	pipelines, err := q.ListEnabledPipelines(ctx)
	if err != nil {
		return "", err
	}
	for _, p := range pipelines {
		if p.Filter != "{}" && p.Filter != "" {
			continue
		}
		if strings.Contains(p.Steps, "llm_summarize") {
			return p.ID, nil
		}
	}
	return "", nil
}

// extractProseParagraphs splits markdown prose into non-empty paragraph chunks.
// Used as a fallback when the document contains no bullet/list items.
// A paragraph is a run of non-blank lines separated by one or more blank lines.
// Markdown headings (# lines) are treated as paragraph separators and are not
// included in the output. Short paragraphs (< 40 chars) are skipped to avoid
// stubs like lone image captions or empty section dividers.
func extractProseParagraphs(md string) []string {
	const minLen = 40
	var paragraphs []string
	var current strings.Builder

	flush := func() {
		s := strings.TrimSpace(current.String())
		if len(s) >= minLen {
			paragraphs = append(paragraphs, s)
		}
		current.Reset()
	}

	for _, line := range strings.Split(md, "\n") {
		// Heading or horizontal rule → paragraph break, skip the line itself.
		if strings.HasPrefix(line, "#") || strings.HasPrefix(line, "---") || strings.HasPrefix(line, "===") {
			flush()
			continue
		}
		// Blank line → paragraph boundary.
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if current.Len() > 0 {
			current.WriteByte(' ')
		}
		current.WriteString(strings.TrimSpace(line))
	}
	flush()
	return paragraphs
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
		if strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* ") {
			flush()
			current.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "- "), "* "))
			continue
		}
		if current.Len() > 0 {
			trimmed := strings.TrimLeft(line, " \t")
			if trimmed != "" && (line[0] == ' ' || line[0] == '\t') {
				current.WriteByte('\n')
				current.WriteString(trimmed)
				continue
			}
			if strings.TrimSpace(line) == "" {
				current.WriteByte('\n')
				continue
			}
		}
	}
	flush()
	return items
}
