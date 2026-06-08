package setup

import (
	"fmt"

	"github.com/symunona/samizdat/cli/config"
)

// Step is one interactive screen in the setup wizard.
// Implement this interface for each onboarding concern.
type Step interface {
	// Name is a short human label shown in progress output.
	Name() string
	// ShouldSkip returns true if this step is already satisfied — safe to re-run idempotently.
	ShouldSkip(cfg *config.Config) bool
	// Run prompts the user and mutates cfg in place.
	Run(cfg *config.Config) error
}

// Runner executes steps in order, persisting config after each successful step.
type Runner struct {
	Steps   []Step
	CfgPath string
}

func (r *Runner) Run(cfg *config.Config) error {
	total := len(r.Steps)
	for i, s := range r.Steps {
		if s.ShouldSkip(cfg) {
			fmt.Printf("  [%d/%d] %s — already set\n", i+1, total, s.Name())
			continue
		}
		fmt.Printf("\n[%d/%d] %s\n", i+1, total, s.Name())
		if err := s.Run(cfg); err != nil {
			return fmt.Errorf("step %q: %w", s.Name(), err)
		}
		if err := config.Save(cfg, r.CfgPath); err != nil {
			return fmt.Errorf("save after %q: %w", s.Name(), err)
		}
	}
	return nil
}
