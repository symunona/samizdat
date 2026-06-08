package git

import (
	"fmt"
	"os/exec"
	"strings"
)

func CurrentBranch() (string, error) {
	out, err := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil {
		return "", fmt.Errorf("git rev-parse: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// DiffFromMain returns the unified diff of path since diverging from main.
func DiffFromMain(path string) (string, error) {
	out, err := exec.Command("git", "diff", "main...HEAD", "--", path).Output()
	if err != nil {
		return "", fmt.Errorf("git diff: %w", err)
	}
	return string(out), nil
}

// ChangedSubprojects returns which of the given dirs have code changes vs main.
func ChangedSubprojects(dirs []string) ([]string, error) {
	var changed []string
	for _, dir := range dirs {
		diff, err := DiffFromMain(dir)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(diff) != "" {
			changed = append(changed, dir)
		}
	}
	return changed, nil
}
