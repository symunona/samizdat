// Package pipeline defines the Pipeline/Step execution engine.
// Steps are registered Go handlers; new step kinds extend the registry.
package pipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/store"
)

type contextKey int

const (
	parentJobIDKey contextKey = iota
	dbKey
)

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

// WithDB injects the database handle so step handlers can run their highlight
// inserts in a transaction (see InsertTx).
func WithDB(ctx context.Context, db *sql.DB) context.Context {
	return context.WithValue(ctx, dbKey, db)
}

// dbFromCtx returns the *sql.DB stored by WithDB, or nil.
func dbFromCtx(ctx context.Context) *sql.DB {
	db, _ := ctx.Value(dbKey).(*sql.DB)
	return db
}

// InsertTx runs fn inside a single transaction when a *sql.DB is present in ctx,
// so a step's batch of highlight inserts is atomic: a mid-batch error rolls the
// whole batch back, and a job retry replaces rather than appends (no duplicates).
// Falls back to running fn directly with q when no DB is in ctx (e.g. tests that
// pass a plain *Queries). The closure MUST use the *Queries it receives for every
// DB call — the connection pool is single-writer, so touching the outer q would
// deadlock against the open transaction.
func InsertTx(ctx context.Context, q *store.Queries, fn func(*store.Queries) error) error {
	if db := dbFromCtx(ctx); db != nil {
		if err := store.InTx(ctx, db, fn); err != nil {
			return fmt.Errorf("pipeline tx: %w", err)
		}
		return nil
	}
	return fn(q)
}

// StepConfig is a single step from the pipeline.steps JSON array.
type StepConfig struct {
	Kind   string          `json:"kind"`
	Config json.RawMessage `json:"config"`
}

// PipelineFilter matches against a Document + its feed URL.
type PipelineFilter struct {
	FeedURLContains      string   `json:"feed_url_contains"`
	SourceFeedID         string   `json:"source_feed_id"`
	ExcludeFeedURLs      []string `json:"exclude_feed_url_contains"`
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
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("parse step config: %w", err)
	}
	return nil
}
