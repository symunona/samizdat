package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/symunona/samizdat/server/internal/store"
)

// backfillSettingKey guards the one-shot prompt backfill (server_settings).
const backfillSettingKey = "pipeline_step_prompts_backfilled"

// BackfillStepPrompts writes each step's catalog default prompt into its config
// JSON, once, so a pipeline built before prompts were configurable shows (and
// can edit) the prompt it actually runs. Behaviour is unchanged: the value
// written is exactly the default the step would have fallen back to.
//
// It lives here, not in store's migrate(), because the catalog lives in this
// package and pipeline already imports store — the server wires it right after
// store.Open. Idempotent twice over: the server_settings flag, and a step that
// already carries a prompt is left alone.
func BackfillStepPrompts(ctx context.Context, q *store.Queries) error {
	if v, err := q.GetSetting(ctx, backfillSettingKey); err == nil && v != "" {
		return nil
	}
	rows, err := q.ListPipelines(ctx)
	if err != nil {
		return fmt.Errorf("backfill prompts: list pipelines: %w", err)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, p := range rows {
		steps, ok := fillDefaultPrompts(p.Steps)
		if !ok {
			continue
		}
		if err := q.UpdatePipeline(ctx, store.UpdatePipelineParams{
			Name:      p.Name,
			Enabled:   p.Enabled,
			Trigger:   p.Trigger,
			Filter:    p.Filter,
			Steps:     steps,
			UpdatedAt: now,
			ID:        p.ID,
		}); err != nil {
			return fmt.Errorf("backfill prompts: update pipeline %s: %w", p.ID, err)
		}
	}
	if err := q.UpsertSetting(ctx, store.UpsertSettingParams{Key: backfillSettingKey, Value: now}); err != nil {
		return fmt.Errorf("backfill prompts: mark done: %w", err)
	}
	return nil
}

// fillDefaultPrompts returns the steps JSON with the catalog default prompt
// inserted into every step that has a prompt field but no value, and whether
// anything changed. Unparseable JSON is left untouched.
func fillDefaultPrompts(stepsJSON string) (string, bool) {
	steps, ok := decodeSteps(stepsJSON)
	if !ok {
		return stepsJSON, false
	}
	changed := false
	for _, step := range steps {
		def := defaultPrompt(stepKind(step))
		if def == "" {
			continue
		}
		cfg, ok := stepConfig(step)
		if !ok || hasPrompt(cfg) {
			continue
		}
		enc, err := json.Marshal(def)
		if err != nil {
			continue
		}
		cfg[promptKey] = enc
		if setStepConfig(step, cfg) {
			changed = true
		}
	}
	if !changed {
		return stepsJSON, false
	}
	return encodeSteps(steps, stepsJSON), true
}

// hasPrompt reports whether a step config already carries a non-empty prompt.
func hasPrompt(cfg map[string]json.RawMessage) bool {
	raw, ok := cfg[promptKey]
	if !ok {
		return false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return true // present but not a string — don't touch it
	}
	return s != ""
}
