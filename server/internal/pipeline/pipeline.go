// Package pipeline defines the Pipeline/Step execution engine.
// Steps are registered Go handlers; new step kinds extend the registry.
package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

type contextKey int

const parentJobIDKey contextKey = iota

// WithParentJobID injects the driving job's ID into ctx so step handlers can
// set it as ParentJobID on any child jobs they enqueue.
func WithParentJobID(ctx context.Context, jobID string) context.Context {
	return context.WithValue(ctx, parentJobIDKey, jobID)
}

// ParentJobIDFromCtx returns the parent job ID stored by WithParentJobID, or
// nil if not set.
func ParentJobIDFromCtx(ctx context.Context) *string {
	v, _ := ctx.Value(parentJobIDKey).(string)
	if v == "" {
		return nil
	}
	return &v
}

// StepConfig is a single step from the pipeline.steps JSON array.
type StepConfig struct {
	Kind   string          `json:"kind"`
	Config json.RawMessage `json:"config"`
}

// PipelineFilter matches against a Document + its feed URL.
type PipelineFilter struct {
	FeedURLContains     string   `json:"feed_url_contains"`
	SourceFeedID        string   `json:"source_feed_id"`
	ExcludeFeedURLs     []string `json:"exclude_feed_url_contains"`
	ExcludeSourceFeedIDs []string `json:"exclude_source_feed_ids"`
}

// Result returned by a step handler.
type StepResult struct {
	Done     bool   // true = step complete, move to next
	NewState string // updated intermediate state for next call
}

// Handler is the function signature for a step kind.
type Handler func(ctx context.Context, q *store.Queries, run store.PipelineRun, cfg json.RawMessage, llmClient llm.Client) (StepResult, error)

var registry = map[string]Handler{}

// Register adds a step kind handler. Call from init().
func Register(kind string, h Handler) {
	registry[kind] = h
}

// Dispatch runs the current step for the given pipeline run.
func Dispatch(ctx context.Context, q *store.Queries, run store.PipelineRun, pipeline store.Pipeline, llmClient llm.Client) (StepResult, error) {
	var steps []StepConfig
	if err := json.Unmarshal([]byte(pipeline.Steps), &steps); err != nil {
		return StepResult{}, fmt.Errorf("parse steps: %w", err)
	}

	idx := int(run.StepIndex)
	if idx >= len(steps) {
		return StepResult{Done: true}, nil
	}

	step := steps[idx]
	h, ok := registry[step.Kind]
	if !ok {
		return StepResult{}, fmt.Errorf("unknown step kind %q", step.Kind)
	}
	return h(ctx, q, run, step.Config, llmClient)
}

// MatchesDocument checks whether the pipeline filter matches the given document + feed URL.
// An empty filter matches all documents.
func MatchesDocument(pipeline store.Pipeline, doc store.Document, feedURL string) bool {
	var f PipelineFilter
	if err := json.Unmarshal([]byte(pipeline.Filter), &f); err != nil {
		return false
	}
	if f.SourceFeedID != "" && (doc.SourceFeedID == nil || *doc.SourceFeedID != f.SourceFeedID) {
		return false
	}
	if f.FeedURLContains != "" && !strings.Contains(strings.ToLower(feedURL), strings.ToLower(f.FeedURLContains)) {
		return false
	}
	for _, ex := range f.ExcludeSourceFeedIDs {
		if doc.SourceFeedID != nil && *doc.SourceFeedID == ex {
			return false
		}
	}
	feedURLLower := strings.ToLower(feedURL)
	for _, ex := range f.ExcludeFeedURLs {
		if strings.Contains(feedURLLower, strings.ToLower(ex)) {
			return false
		}
	}
	return true
}

// ParseStepConfig unmarshals a step's config JSON into dst.
func ParseStepConfig(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}
