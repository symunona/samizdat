package steps

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/symunona/samizdat/cli/config"
)

// JustCompletion is a dev-setup step — suggests installing just tab completion.
type JustCompletion struct{}

func (JustCompletion) Name() string { return "just tab completion" }

func (JustCompletion) ShouldSkip(_ *config.Config) bool {
	// Skip if just isn't installed.
	_, err := exec.LookPath("just")
	return err != nil
}

func (JustCompletion) Run(_ *config.Config) error {
	shell := detectShell()
	target, installCmd := completionTarget(shell)
	if target == "" {
		fmt.Println("  Shell not recognized — run: just --completions <bash|zsh|fish>")
		return nil
	}

	fmt.Printf("  Install just tab completion for %s? [Y/n]: ", shell)
	line, err := readLine()
	if err != nil {
		return err
	}
	if strings.ToLower(line) == "n" {
		fmt.Println("  Skipped. Run manually:")
		fmt.Printf("    %s\n", installCmd)
		return nil
	}

	if err := runCompletionInstall(shell, target); err != nil {
		fmt.Printf("  Failed: %v\n  Run manually: %s\n", err, installCmd)
		return nil // non-fatal
	}
	fmt.Printf("  Installed -> %s\n  Restart your shell or source the file.\n", target)
	return nil
}

func detectShell() string {
	shell := os.Getenv("SHELL")
	switch {
	case strings.Contains(shell, "zsh"):
		return "zsh"
	case strings.Contains(shell, "fish"):
		return "fish"
	default:
		return "bash"
	}
}

func completionTarget(shell string) (target, cmd string) {
	home, _ := os.UserHomeDir()
	switch shell {
	case "zsh":
		t := filepath.Join(home, ".zfunc", "_just")
		return t, fmt.Sprintf("just --completions zsh > %s", t)
	case "fish":
		t := filepath.Join(home, ".config", "fish", "completions", "just.fish")
		return t, fmt.Sprintf("just --completions fish > %s", t)
	case "bash":
		if runtime.GOOS == "darwin" {
			t := filepath.Join(home, ".bash_completion")
			return t, fmt.Sprintf("just --completions bash >> %s", t)
		}
		t := filepath.Join(home, ".bash_completion")
		return t, fmt.Sprintf("just --completions bash >> %s", t)
	}
	return "", ""
}

func runCompletionInstall(shell, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	out, err := exec.Command("just", "--completions", shell).Output()
	if err != nil {
		return err
	}
	flag := os.O_CREATE | os.O_WRONLY
	if shell == "bash" {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}
	f, err := os.OpenFile(target, flag, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(out)
	return err
}
