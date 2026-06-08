package main

import (
	"fmt"
	"os"

	"github.com/symunona/samizdat/cli/cmd"
)

func main() {
	if err := cmd.Root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
