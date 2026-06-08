package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
	"github.com/symunona/samizdat/cli/setup"
	"github.com/symunona/samizdat/cli/setup/steps"
)

var setupCmd = &cobra.Command{
	Use:   "setup",
	Short: "Interactive first-run configuration wizard",
	RunE:  runSetup,
}

func runSetup(cmd *cobra.Command, _ []string) error {
	cfgPath, err := config.DefaultPath()
	if err != nil {
		return fmt.Errorf("default config path: %w", err)
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	runner := &setup.Runner{
		CfgPath: cfgPath,
		Steps: []setup.Step{
			steps.DataDir{},
			steps.VaultDir{},
			// steps.LLM{},     — coming next
			// steps.Network{}, — coming next
		},
	}

	fmt.Println("Samizdat setup")
	fmt.Printf("Config will be saved to: %s\n", cfgPath)

	if err := runner.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "Setup failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\nSetup complete. Run: sam server start")
	return nil
}
