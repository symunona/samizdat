package linting

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/symunona/samizdat/tooling/internal/claude"
	"github.com/symunona/samizdat/tooling/internal/git"
)

// parityPair is two files that render the SAME UI in two runtimes that cannot
// share a rendered component. A change to one usually must be mirrored in the
// other. Each such pair is declared concretely — no generic registry; if a new
// pair appears, add another parityPair and another check, don't abstract.
type parityPair struct {
	name      string
	invariant string
	files     [2]string
}

// highlightCardPair: the Highlight card exists twice — the feed renders it in
// React Native, the document body renders it as raw DOM inside a WebView (React
// does not run there). Same actions/icons/layout, two runtimes. See app/CLAUDE.md.
var highlightCardPair = parityPair{
	name: "highlight-card UI",
	files: [2]string{
		"app/src/HighlightCard.tsx",
		"app/src/webview/document-viewer.ts",
	},
	invariant: `Both files render the SAME Highlight card — same action set (pin, tags, annotate, delete), same icons, same layout — but in two runtimes that CANNOT share a rendered component:
- app/src/HighlightCard.tsx       React Native (feed list; native + RN-Web)
- app/src/webview/document-viewer.ts   raw DOM inside a WebView (document body; React does not run here)
A change to the action set, an icon, a label, or the card layout in one MUST be mirrored in the other. Icons differ in FORM only (Ionicons component on the RN side vs inline SVG of the same glyph in the WebView) — the glyph, size and meaning must match.`,
}

// RunParity verifies that paired-renderer files stay in sync vs main. No-op on
// main (nothing to diff). Currently one concrete pair: the Highlight card.
func RunParity(repoRoot string) error {
	branch, err := git.CurrentBranch()
	if err != nil {
		return fmt.Errorf("git branch: %w", err)
	}
	if branch == "main" {
		fmt.Println("parity: on main — nothing to check")
		return nil
	}
	return checkPair(repoRoot, highlightCardPair)
}

func checkPair(repoRoot string, p parityPair) error {
	diffA, err := git.DiffFromMain(p.files[0])
	if err != nil {
		return fmt.Errorf("git diff %s: %w", p.files[0], err)
	}
	diffB, err := git.DiffFromMain(p.files[1])
	if err != nil {
		return fmt.Errorf("git diff %s: %w", p.files[1], err)
	}
	changedA := strings.TrimSpace(diffA) != ""
	changedB := strings.TrimSpace(diffB) != ""

	if !changedA && !changedB {
		fmt.Printf("parity: %s — both files unchanged vs main\n", p.name)
		return nil
	}

	fmt.Printf("=== parity: %s ===\n", p.name)
	fmt.Printf("  %s: %s\n", changedLabel(changedA), p.files[0])
	fmt.Printf("  %s: %s\n", changedLabel(changedB), p.files[1])

	ai, err := claude.New()
	if err != nil {
		// Graceful degrade (like lib-check): can't judge without a key, so just
		// remind the human. Non-fatal — don't block a branch on a missing key.
		fmt.Printf("\nparity: %v — verify the change is reflected in BOTH files manually.\n", err)
		return nil
	}

	srcA, _ := os.ReadFile(filepath.Join(repoRoot, p.files[0]))
	srcB, _ := os.ReadFile(filepath.Join(repoRoot, p.files[1]))

	prompt := buildParityPrompt(p, diffA, diffB, string(srcA), string(srcB))
	result, err := ai.Complete(context.Background(), claude.ModelSonnet, prompt)
	if err != nil {
		return fmt.Errorf("claude complete: %w", err)
	}

	inSync, notes := parseParityResponse(result)
	fmt.Println("\nParity notes:")
	fmt.Println(notes)

	if inSync {
		fmt.Println("\nparity: OK — changes are mirrored.")
		return nil
	}
	return fmt.Errorf("parity: %s out of sync — see notes above", p.name)
}

func changedLabel(changed bool) string {
	if changed {
		return "CHANGED  "
	}
	return "unchanged"
}

func buildParityPrompt(p parityPair, diffA, diffB, srcA, srcB string) string {
	return fmt.Sprintf(`You are checking PARITY between two files in the Samizdat app that render the same UI in two different runtimes.

## Invariant (what must stay true):
%s

## %s — current full source:
%s

## %s — current full source:
%s

## Diff vs main for %s:
%s

## Diff vs main for %s:
%s

## Task:
Decide whether the two files are still in sync AFTER these changes. A change to the action set, an icon (glyph/meaning), a label, or the card layout in one file must be mirrored in the other. Pure-implementation differences (RN Pressable vs DOM button, Ionicons component vs inline SVG of the same glyph) are EXPECTED and fine — only flag a real divergence in what the user sees or can do.

Respond in exactly this format:

IN_SYNC: yes|no
NOTES:
<brief bullet points: if out of sync, name exactly what changed in one file and is missing/different in the other, and what edit would restore parity. If in sync, one line confirming.>`,
		p.invariant,
		p.files[0], srcA,
		p.files[1], srcB,
		p.files[0], diffA,
		p.files[1], diffB,
	)
}

func parseParityResponse(raw string) (inSync bool, notes string) {
	lines := strings.Split(raw, "\n")
	var inNotes bool
	var noteLines []string
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "IN_SYNC:"):
			inSync = strings.Contains(strings.ToLower(line), "yes")
		case strings.HasPrefix(line, "NOTES:"):
			inNotes = true
		default:
			if inNotes {
				noteLines = append(noteLines, line)
			}
		}
	}
	return inSync, strings.TrimSpace(strings.Join(noteLines, "\n"))
}
