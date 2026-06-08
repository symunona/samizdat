package linting

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/symunona/samizdat/tooling/internal/claude"
)

// GoModFiles are go.mod paths relative to repo root.
var GoModFiles = []string{"cli/go.mod", "server/go.mod", "tooling/go.mod"}

// RunLibCheck detects newly added Go libraries vs main and explains them via Claude.
func RunLibCheck(repoRoot string) error {
	added, err := findAddedLibraries()
	if err != nil {
		return fmt.Errorf("find added libraries: %w", err)
	}
	if len(added) == 0 {
		fmt.Println("lib-check: no new Go libraries added")
		return nil
	}

	fmt.Printf("lib-check: %d new librar%s added:\n\n", len(added), plural(len(added), "y", "ies"))
	for _, lib := range added {
		fmt.Printf("  + %s\n", lib)
	}
	fmt.Println()

	ai, err := claude.New()
	if err != nil {
		fmt.Printf("(set ANTHROPIC_API_KEY for explanations — skipping)\n")
		return fmt.Errorf("claude client: %w", err)
	}

	explanations, err := explainLibraries(ai, added)
	if err != nil {
		fmt.Printf("explanation failed: %v\n", err)
		return nil
	}

	fmt.Println("--- Library explanations ---")
	fmt.Println(explanations)
	return nil
}

// findAddedLibraries parses `git diff main...HEAD -- */go.mod` for new require lines.
func findAddedLibraries() ([]string, error) {
	args := append([]string{"diff", "main...HEAD", "--"}, GoModFiles...)
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		// exit code 1 just means diff found — not an error
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			out = exitErr.Stderr
		} else {
			return nil, fmt.Errorf("git diff go.mod: %w", err)
		}
	}

	var added []string
	seen := make(map[string]bool)

	for _, line := range strings.Split(string(out), "\n") {
		// Match lines like: +	github.com/foo/bar v1.2.3
		if !strings.HasPrefix(line, "+") || strings.HasPrefix(line, "+++") {
			continue
		}
		trimmed := strings.TrimPrefix(line, "+")
		trimmed = strings.TrimSpace(trimmed)

		// Skip Go directives, blank lines, indirect marker lines
		if trimmed == "" || strings.HasPrefix(trimmed, "//") ||
			strings.HasPrefix(trimmed, "module") || strings.HasPrefix(trimmed, "go ") ||
			strings.HasPrefix(trimmed, "require") || strings.HasPrefix(trimmed, ")") {
			continue
		}

		// Expect "module/path vX.Y.Z" format
		parts := strings.Fields(trimmed)
		if len(parts) < 2 || !strings.Contains(parts[0], "/") {
			continue
		}
		lib := parts[0]
		if !seen[lib] {
			seen[lib] = true
			added = append(added, lib+" "+parts[1])
		}
	}
	return added, nil
}

func explainLibraries(ai *claude.Client, libs []string) (string, error) {
	list := strings.Join(libs, "\n")
	prompt := fmt.Sprintf(`These Go libraries were just added to Samizdat, a self-hosted read/curate/publish pipeline (Go server + SQLite + Expo app + Chrome extension):

%s

For each library:
1. What it does (one sentence)
2. Whether it fits this project and why
3. Any concerns (or "none")

Be concise — one short paragraph per library.`, list)

	result, err := ai.Complete(context.Background(), claude.ModelHaiku, prompt)
	if err != nil {
		return "", fmt.Errorf("claude complete: %w", err)
	}
	return result, nil
}

func plural(n int, singular, pluralForm string) string {
	if n == 1 {
		return singular
	}
	return pluralForm
}
