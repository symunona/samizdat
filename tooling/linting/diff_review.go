package linting

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/symunona/samizdat/tooling/internal/claude"
	"github.com/symunona/samizdat/tooling/internal/git"
)

// Subprojects are all top-level dirs that carry a CLAUDE.md.
var Subprojects = []string{"server", "cli", "app", "clipper", "tooling"}

// RunDiffReview checks if we're on main, then for each changed subproject
// fires a Claude architecture review and optionally updates CLAUDE.md.
func RunDiffReview(repoRoot string) error {
	branch, err := git.CurrentBranch()
	if err != nil {
		return fmt.Errorf("git branch: %w", err)
	}
	if branch == "main" {
		fmt.Println("diff-review: on main — nothing to review")
		return nil
	}
	fmt.Printf("diff-review: branch %q vs main\n\n", branch)

	ai, err := claude.New()
	if err != nil {
		return fmt.Errorf("claude: %w (set ANTHROPIC_API_KEY to enable reviews)", err)
	}

	changed, err := git.ChangedSubprojects(Subprojects)
	if err != nil {
		return err
	}
	if len(changed) == 0 {
		fmt.Println("No subproject changes found.")
		return nil
	}

	for _, proj := range changed {
		if err := reviewProject(repoRoot, proj, ai); err != nil {
			fmt.Fprintf(os.Stderr, "review %s: %v\n", proj, err)
		}
	}
	return nil
}

func reviewProject(repoRoot, proj string, ai *claude.Client) error {
	fmt.Printf("=== reviewing %s/ ===\n", proj)

	diff, err := git.DiffFromMain(proj)
	if err != nil || strings.TrimSpace(diff) == "" {
		return err
	}

	claudeMDPath := filepath.Join(repoRoot, proj, "CLAUDE.md")
	claudeMD, _ := os.ReadFile(claudeMDPath) // ok if missing

	prompt := buildReviewPrompt(proj, string(claudeMD), diff)
	result, err := ai.Complete(context.Background(), claude.ModelSonnet, prompt)
	if err != nil {
		return err
	}

	update, notes, updatedMD := parseReviewResponse(result)

	fmt.Println("Review notes:")
	fmt.Println(notes)

	if !update || updatedMD == "" {
		fmt.Println("  No CLAUDE.md changes suggested.")
		return nil
	}

	showClaudeMDDiff(string(claudeMD), updatedMD)
	fmt.Printf("\nUpdate %s/CLAUDE.md? [Y/n]: ", proj)

	r := bufio.NewReader(os.Stdin)
	line, _ := r.ReadString('\n')
	if strings.ToLower(strings.TrimSpace(line)) == "n" {
		fmt.Println("Skipped.")
		return nil
	}

	if err := os.WriteFile(claudeMDPath, []byte(updatedMD), 0644); err != nil {
		return fmt.Errorf("write CLAUDE.md: %w", err)
	}
	fmt.Printf("Updated %s/CLAUDE.md\n", proj)
	return nil
}

func buildReviewPrompt(proj, claudeMD, diff string) string {
	return fmt.Sprintf(`You are reviewing a code diff for the "%s" subproject of Samizdat (a self-hosted read/curate/publish pipeline).

## Current CLAUDE.md:
%s

## Diff (vs main):
%s

## Task:
Analyze the diff for:
1. New library or dependency additions that should be documented
2. New patterns, conventions, or architectural decisions established
3. Deviations from documented patterns (flag as concern)
4. Missing documentation of important decisions

Respond in exactly this format:

NEEDS_UPDATE: yes|no
UPDATED_CLAUDE_MD:
<full updated CLAUDE.md content, or empty if no update needed>
END_CLAUDE_MD
REVIEW_NOTES:
<brief bullet-point notes>`, proj, claudeMD, diff)
}

func parseReviewResponse(raw string) (needsUpdate bool, notes, updatedMD string) {
	lines := strings.Split(raw, "\n")
	var section string
	var mdLines, noteLines []string

	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "NEEDS_UPDATE:"):
			needsUpdate = strings.Contains(strings.ToLower(line), "yes")
		case strings.HasPrefix(line, "UPDATED_CLAUDE_MD:"):
			section = "md"
		case strings.TrimSpace(line) == "END_CLAUDE_MD":
			section = ""
		case strings.HasPrefix(line, "REVIEW_NOTES:"):
			section = "notes"
		default:
			switch section {
			case "md":
				mdLines = append(mdLines, line)
			case "notes":
				noteLines = append(noteLines, line)
			}
		}
	}

	return needsUpdate, strings.TrimSpace(strings.Join(noteLines, "\n")), strings.TrimSpace(strings.Join(mdLines, "\n"))
}

func showClaudeMDDiff(old, new string) {
	fmt.Println("\n--- CLAUDE.md (current)")
	fmt.Println("+++ CLAUDE.md (proposed)")
	oldLines := strings.Split(old, "\n")
	newLines := strings.Split(new, "\n")

	oldSet := make(map[string]bool, len(oldLines))
	for _, l := range oldLines {
		oldSet[l] = true
	}
	newSet := make(map[string]bool, len(newLines))
	for _, l := range newLines {
		newSet[l] = true
	}

	for _, l := range oldLines {
		if !newSet[l] {
			fmt.Printf("- %s\n", l)
		}
	}
	for _, l := range newLines {
		if !oldSet[l] {
			fmt.Printf("+ %s\n", l)
		}
	}
}
