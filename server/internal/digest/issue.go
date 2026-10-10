package digest

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

// Ref points a DigestTopic at stored Highlight text. Bullet is the line index
// inside the Highlight body, -1 for the whole Highlight.
//
// The fields after Bullet are never stored: Resolve fills them for a reader.
type Ref struct {
	HighlightID string `json:"highlight_id"`
	Bullet      int    `json:"bullet"`
	// History marks earlier text a topic's Diff rests on: written before the
	// issue's window, not part of what the question was asked over.
	History bool `json:"history,omitempty"`

	Text           string `json:"text,omitempty"`
	HighlightTitle string `json:"highlight_title,omitempty"`
	DocumentID     string `json:"document_id,omitempty"`
	DocumentTitle  string `json:"document_title,omitempty"`
	FeedTitle      string `json:"feed_title,omitempty"`
	// Date is the day the Highlight was written.
	Date string `json:"date,omitempty"`
	// Missing: the Highlight row is gone, so there is no text to show.
	Missing bool `json:"missing,omitempty"`
}

// Topic is one grouped answer item. The model wrote Title and Why; everything a
// reader sees under it is stored Highlight text, reached through Refs.
//
// Previous and Diff are set by a History question: the earlier release the model
// compared against and what it says changed. They are model-written too, and are
// kept only alongside at least one History ref — the stored text they rest on.
type Topic struct {
	QuestionID    string `json:"question_id"`
	QuestionTitle string `json:"question_title"`
	Rank          int    `json:"rank"`
	Title         string `json:"title"`
	Why           string `json:"why"`
	Previous      string `json:"previous,omitempty"`
	Diff          string `json:"diff,omitempty"`
	Refs          []Ref  `json:"refs"`
}

// QuestionMeta is how one question's answer came to be.
type QuestionMeta struct {
	QuestionID string `json:"question_id"`
	pipeline.Provenance
	// Candidates is how many lines the window held, CandidatesSent how many fit
	// the endpoint. They differ exactly when Truncated is set.
	Candidates     int `json:"candidates"`
	CandidatesSent int `json:"candidates_sent"`
	// DroppedTopics counts topics the model returned with no ref that resolved.
	DroppedTopics int `json:"dropped_topics,omitempty"`
	// TrimmedRefs counts refs cut from topics citing more than maxTopicRefs.
	TrimmedRefs int `json:"trimmed_refs,omitempty"`
	// Diffs counts topics a History question gave a Diff, DroppedDiffs the ones
	// whose Diff was discarded: no earlier ref that resolved, no named previous
	// release, or no room for one earlier item.
	Diffs        int `json:"diffs,omitempty"`
	DroppedDiffs int `json:"dropped_diffs,omitempty"`
}

// IssueMeta is the DigestIssue's metadata JSON.
type IssueMeta struct {
	Questions []QuestionMeta `json:"questions"`
	// Error is why a failed issue failed.
	Error string `json:"error,omitempty"`
}

// Issue is a DigestIssue as the API serves it.
type Issue struct {
	ID          string    `json:"id"`
	DigestID    string    `json:"digest_id"`
	WindowStart string    `json:"window_start"`
	WindowEnd   string    `json:"window_end"`
	Status      string    `json:"status"`
	Topics      []Topic   `json:"topics"`
	Metadata    IssueMeta `json:"metadata"`
	CreatedAt   string    `json:"created_at"`
	UpdatedAt   string    `json:"updated_at"`
	Rev         int64     `json:"rev"`
	DeletedAt   *string   `json:"deleted_at"`
}

// IssueFromRow decodes a stored DigestIssue. Lists are never nil.
func IssueFromRow(row store.DigestIssue) Issue {
	is := Issue{
		ID:          row.ID,
		DigestID:    row.DigestID,
		WindowStart: row.WindowStart,
		WindowEnd:   row.WindowEnd,
		Status:      row.Status,
		Topics:      []Topic{},
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
		Rev:         row.Rev,
		DeletedAt:   row.DeletedAt,
	}
	_ = json.Unmarshal([]byte(row.Topics), &is.Topics)
	_ = json.Unmarshal([]byte(row.Metadata), &is.Metadata)
	if is.Metadata.Questions == nil {
		is.Metadata.Questions = []QuestionMeta{}
	}
	for i := range is.Topics {
		if is.Topics[i].Refs == nil {
			is.Topics[i].Refs = []Ref{}
		}
	}
	return is
}

// Resolve fills every ref with what it points at: the bullet text, its Document
// and its Feed.
func (is *Issue) Resolve(ctx context.Context, q *store.Queries) error {
	for t := range is.Topics {
		for r := range is.Topics[t].Refs {
			ref := &is.Topics[t].Refs[r]
			row, err := q.GetDigestRef(ctx, ref.HighlightID)
			if errors.Is(err, sql.ErrNoRows) {
				ref.Missing = true
				continue
			}
			if err != nil {
				return fmt.Errorf("resolve ref %s: %w", ref.HighlightID, err)
			}
			ref.Text = BulletText(row.Body, ref.Bullet)
			ref.HighlightTitle = row.Title
			ref.DocumentID = row.DocumentID
			ref.DocumentTitle = row.DocumentTitle
			ref.FeedTitle = store.FeedTitle(row.FeedTitle, row.FeedUrl)
			ref.Date = day(row.CreatedAt)
		}
	}
	return nil
}
