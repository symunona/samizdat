package steps

import (
	"fmt"
	"os"

	"github.com/symunona/samizdat/cli/config"
)

type VaultDir struct{}

func (VaultDir) Name() string { return "Vault directory" }

func (VaultDir) ShouldSkip(cfg *config.Config) bool {
	if cfg.VaultDir == "" {
		return false
	}
	_, err := os.Stat(cfg.VaultDir)
	return err == nil
}

func (VaultDir) Run(cfg *config.Config) error {
	fmt.Println("Where is your Obsidian vault? (markdown files will be written here)")
	fmt.Printf("  Press Enter for default [%s]: ", cfg.VaultDir)

	line, err := readLine()
	if err != nil {
		return err
	}
	if line != "" {
		cfg.VaultDir = expandHome(line)
	}

	if err := os.MkdirAll(cfg.VaultDir, 0700); err != nil {
		return fmt.Errorf("create vault dir: %w", err)
	}
	fmt.Printf("  -> %s\n", cfg.VaultDir)
	return nil
}
