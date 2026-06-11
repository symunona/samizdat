package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
)

var flagConfigPath string

var Root = &cobra.Command{
	Use:   "sam",
	Short: "Samizdat CLI",
}

func init() {
	Root.PersistentFlags().StringVar(&flagConfigPath, "config", "", "path to config.toml (default: ~/.samizdat/config.toml)")
	Root.AddCommand(setupCmd)
	Root.AddCommand(archiveCmd)
}

// resolveConfigPath returns the --config flag value if set, else the default path.
func resolveConfigPath() (string, error) {
	if flagConfigPath != "" {
		return flagConfigPath, nil
	}
	p, err := config.DefaultPath()
	if err != nil {
		return "", fmt.Errorf("default config path: %w", err)
	}
	return p, nil
}
