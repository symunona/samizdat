package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

// stepRetryDelay is how long to wait before re-queuing an in-progress step (fan-out wait).
const stepRetryDelay = 10 * time.Second

type runPipelinePayload struct {
	PipelineID    string `json:"pipeline_id"`
	DocumentID    string `json:"document_id"`
	PipelineName  string `json:"pipeline_name,omitempty"`
	DocumentTitle string `json:"document_title,omitempty"`
}

type runPipelineStepPayload struct {
	PipelineRunID string `json:"pipeline_run_id"`
	PipelineName  string `json:"pipeline_name,omitempty"`
	DocumentID    string `json:"document_id,omitempty"`
	DocumentTitle string `json:"document_title,omitempty"`
	StepIndex     int    `json:"step_index,omitempty"`
}

func handleRunPipeline(ctx context.Context, q *store.Queries, job store.Job, llmClient llm.Client) (string, error) {
	var p runPipelinePayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}

	logPipeline.Printf("starting pipeline %s for document %s", p.PipelineID[:8], p.DocumentID[:8])

	now := time.Now().UTC().Format(time.RFC3339)
	run, err := q.InsertPipelineRun(ctx, store.InsertPipelineRunParams{
		ID:         uuid.NewString(),
		PipelineID: p.PipelineID,
		DocumentID: p.DocumentID,
		CreatedAt:  now,
		UpdatedAt:  now,
	})
	if err != nil {
		return "", fmt.Errorf("insert pipeline run: %w", err)
	}

	logPipeline.Printf("run %s created for pipeline %s", run.ID[:8], p.PipelineID[:8])

	// Mark run as running and enqueue first step
	if err := q.UpdatePipelineRunProgress(ctx, store.UpdatePipelineRunProgressParams{
		Status:    "running",
		StepIndex: 0,
		State:     "{}",
		UpdatedAt: now,
		ID:        run.ID,
	}); err != nil {
		return "", fmt.Errorf("update run status: %w", err)
	}

	stepPayload, _ := json.Marshal(runPipelineStepPayload{
		PipelineRunID: run.ID,
		PipelineName:  p.PipelineName,
		DocumentID:    p.DocumentID,
		DocumentTitle: p.DocumentTitle,
		StepIndex:     0,
	})
	parentID := job.ID
	_, err = q.InsertJob(ctx, store.InsertJobParams{
		ID:          uuid.NewString(),
		Kind:        "run_pipeline_step",
		Payload:     string(stepPayload),
		RunAfter:    now,
		CreatedAt:   now,
		UpdatedAt:   now,
		ParentJobID: &parentID,
	})
	if err != nil {
		return "", fmt.Errorf("enqueue step: %w", err)
	}

	logPipeline.Printf("run %s step 0 enqueued", run.ID[:8])

	result, _ := json.Marshal(map[string]string{"pipeline_run_id": run.ID})
	return string(result), nil
}

func handleRunPipelineStep(ctx context.Context, q *store.Queries, job store.Job, llmClient llm.Client) (string, error) {
	var p runPipelineStepPayload
	if err := json.Unmarshal([]byte(job.Payload), &p); err != nil {
		return "", fmt.Errorf("bad payload: %w", err)
	}

	run, err := q.GetPipelineRun(ctx, p.PipelineRunID)
	if err != nil {
		return "", fmt.Errorf("get pipeline run: %w", err)
	}

	pl, err := q.GetPipeline(ctx, run.PipelineID)
	if err != nil {
		return "", fmt.Errorf("get pipeline: %w", err)
	}

	logPipeline.Printf("run %s pipeline %s (%s) step %d dispatching",
		run.ID[:8], pl.ID[:8], pl.Name, run.StepIndex)

	result, err := pipeline.Dispatch(ctx, q, run, pl, llmClient)
	if err != nil {
		return "", err
	}

	now := time.Now().UTC().Format(time.RFC3339)

	if result.Done {
		// Advance to next step
		nextIdx := run.StepIndex + 1
		var stepCount int
		var steps []pipeline.StepConfig
		_ = json.Unmarshal([]byte(pl.Steps), &steps)
		stepCount = len(steps)

		if int(nextIdx) >= stepCount {
			// All steps done
			if err := q.UpdatePipelineRunProgress(ctx, store.UpdatePipelineRunProgressParams{
				Status:    "done",
				StepIndex: nextIdx,
				State:     "{}",
				UpdatedAt: now,
				ID:        run.ID,
			}); err != nil {
				return "", fmt.Errorf("mark run done: %w", err)
			}
			logPipeline.Printf("run %s pipeline %s (%s) all %d steps done",
				run.ID[:8], pl.ID[:8], pl.Name, stepCount)
			return `{"status":"done"}`, nil
		}

		// Move to next step
		if err := q.UpdatePipelineRunProgress(ctx, store.UpdatePipelineRunProgressParams{
			Status:    "running",
			StepIndex: nextIdx,
			State:     "{}",
			UpdatedAt: now,
			ID:        run.ID,
		}); err != nil {
			return "", fmt.Errorf("advance step: %w", err)
		}

		logPipeline.Printf("run %s advancing to step %d/%d", run.ID[:8], nextIdx, stepCount)

		stepPayload, _ := json.Marshal(runPipelineStepPayload{
			PipelineRunID: run.ID,
			PipelineName:  p.PipelineName,
			DocumentID:    p.DocumentID,
			DocumentTitle: p.DocumentTitle,
			StepIndex:     int(nextIdx),
		})
		_, err = q.InsertJob(ctx, store.InsertJobParams{
			ID:          uuid.NewString(),
			Kind:        "run_pipeline_step",
			Payload:     string(stepPayload),
			RunAfter:    now,
			CreatedAt:   now,
			UpdatedAt:   now,
			ParentJobID: job.ParentJobID,
		})
		return `{"status":"advanced"}`, err
	}

	// Step not done — save updated state and re-queue with delay
	newState := result.NewState
	if newState == "" {
		newState = run.State
	}
	if err := q.UpdatePipelineRunProgress(ctx, store.UpdatePipelineRunProgressParams{
		Status:    "running",
		StepIndex: run.StepIndex,
		State:     newState,
		UpdatedAt: now,
		ID:        run.ID,
	}); err != nil {
		return "", fmt.Errorf("save step state: %w", err)
	}

	logPipeline.Printf("run %s step %d waiting (retry in %s)", run.ID[:8], run.StepIndex, stepRetryDelay)

	runAfter := time.Now().UTC().Add(stepRetryDelay).Format(time.RFC3339)
	stepPayload, _ := json.Marshal(runPipelineStepPayload{
		PipelineRunID: run.ID,
		PipelineName:  p.PipelineName,
		DocumentID:    p.DocumentID,
		DocumentTitle: p.DocumentTitle,
		StepIndex:     int(run.StepIndex),
	})
	_, err = q.InsertJob(ctx, store.InsertJobParams{
		ID:          uuid.NewString(),
		Kind:        "run_pipeline_step",
		Payload:     string(stepPayload),
		RunAfter:    runAfter,
		CreatedAt:   now,
		UpdatedAt:   now,
		ParentJobID: job.ParentJobID,
	})
	return `{"status":"waiting"}`, err
}
