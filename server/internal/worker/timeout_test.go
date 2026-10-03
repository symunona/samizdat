package worker

import (
	"testing"

	"github.com/symunona/samizdat/server/internal/llm"
)

// A single completion must end before ResetStuckJobs gives up on its job: the
// reset would hand a still-running step to a second worker.
func TestStuckJobAgeOutlivesLLMCall(t *testing.T) {
	if llm.RequestTimeout >= stuckJobAge {
		t.Fatalf("llm.RequestTimeout %v must be < stuckJobAge %v", llm.RequestTimeout, stuckJobAge)
	}
}
