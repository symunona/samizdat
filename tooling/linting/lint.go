package linting

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// GoProjects are the Go submodules relative to repo root.
var GoProjects = []string{"server", "cli", "tooling"}

// RunLint executes golangci-lint for each Go project.
// repoRoot is the absolute path to the repository root.
func RunLint(repoRoot string) error {
	if _, err := exec.LookPath("golangci-lint"); err != nil {
		return fmt.Errorf("golangci-lint not found — install from https://golangci-lint.run/usage/install/")
	}

	var failed []string
	for _, proj := range GoProjects {
		dir := filepath.Join(repoRoot, proj)
		if _, err := os.Stat(dir); os.IsNotExist(err) {
			continue
		}
		fmt.Printf("lint: %s/\n", proj)
		cmd := exec.Command("golangci-lint", "run", "--config", filepath.Join(repoRoot, ".golangci.yml"), "./...")
		cmd.Dir = dir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			failed = append(failed, proj)
		}
	}

	if len(failed) > 0 {
		return fmt.Errorf("lint failed in: %v", failed)
	}
	return nil
}
