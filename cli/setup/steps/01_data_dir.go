package steps

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/symunona/samizdat/cli/config"
)

type DataDir struct{}

func (DataDir) Name() string { return "Data directory" }

func (DataDir) ShouldSkip(cfg *config.Config) bool {
	_, err := os.Stat(cfg.DataDir)
	return err == nil
}

func (DataDir) Run(cfg *config.Config) error {
	fmt.Printf("Where should Samizdat store its data?\n")
	fmt.Printf("  Press Enter for default [%s]: ", cfg.DataDir)

	line, err := readLine()
	if err != nil {
		return err
	}
	if line != "" {
		cfg.DataDir = expandHome(line)
		cfg.VaultDir = cfg.DataDir + "/vault"
		cfg.DBPath = cfg.DataDir + "/app.db"
	}

	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	if err := os.MkdirAll(cfg.VaultDir, 0700); err != nil {
		return fmt.Errorf("create vault dir: %w", err)
	}

	fmt.Printf("  -> %s\n", cfg.DataDir)
	return nil
}

func readLine() (string, error) {
	r := bufio.NewReader(os.Stdin)
	line, err := r.ReadString('\n')
	return strings.TrimSpace(line), err
}

func expandHome(path string) string {
	if !strings.HasPrefix(path, "~/") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return home + path[1:]
}
