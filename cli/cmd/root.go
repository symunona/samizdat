package cmd

import (
	"github.com/spf13/cobra"
)

var Root = &cobra.Command{
	Use:   "sam",
	Short: "Samizdat CLI",
}

func init() {
	Root.AddCommand(setupCmd)
	Root.AddCommand(archiveCmd)
}
