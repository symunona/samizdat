package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/tooling/linting"
)

func repoRoot() string {
	// Walk up from this binary's source location via __file__ equivalent.
	// In practice, run spec from the repo root or set REPO_ROOT.
	if r := os.Getenv("REPO_ROOT"); r != "" {
		return r
	}
	// Fallback: walk up from cwd until we find a justfile.
	dir, _ := os.Getwd()
	for {
		if _, err := os.Stat(filepath.Join(dir, "justfile")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "."
}

// suppress unused import warning for runtime on non-debug builds.
var _ = runtime.GOOS

func main() {
	root := &cobra.Command{
		Use:   "spec",
		Short: "Samizdat project-wide spec runner",
	}

	root.AddCommand(
		lintCmd(),
		diffReviewCmd(),
		libCheckCmd(),
		parityCmd(),
		allCmd(),
	)

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func lintCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "lint",
		Short: "Run golangci-lint on all Go projects",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return linting.RunLint(repoRoot())
		},
	}
}

func diffReviewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "diff-review",
		Short: "Per-subproject diff → Claude architecture review → optional CLAUDE.md update",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return linting.RunDiffReview(repoRoot())
		},
	}
}

func libCheckCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "lib-check",
		Short: "Detect new Go libraries added vs main and explain them",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return linting.RunLibCheck(repoRoot())
		},
	}
}

func parityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "parity",
		Short: "Check paired-renderer files (e.g. Highlight card RN vs WebView) stay in sync vs main",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return linting.RunParity(repoRoot())
		},
	}
}

func allCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "all",
		Short: "Run lint + lib-check + parity + diff-review",
		RunE: func(cmd *cobra.Command, _ []string) error {
			root := repoRoot()
			var errs []error
			if err := linting.RunLint(root); err != nil {
				errs = append(errs, err)
			}
			if err := linting.RunLibCheck(root); err != nil {
				errs = append(errs, err)
			}
			if err := linting.RunParity(root); err != nil {
				errs = append(errs, err)
			}
			if err := linting.RunDiffReview(root); err != nil {
				errs = append(errs, err)
			}
			if len(errs) > 0 {
				for _, e := range errs {
					fmt.Fprintln(os.Stderr, e)
				}
				os.Exit(1)
			}
			return nil
		},
	}
}
