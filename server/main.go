package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/server/internal/api"
	cfg "github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/network"
	"github.com/symunona/samizdat/server/internal/store"
)

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

var (
	flagConfig string
	flagPort   int
	flagWebDir string
)

var rootCmd = &cobra.Command{
	Use:   "samizdat",
	Short: "Samizdat server",
	RunE:  runServe,
}

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the HTTP server",
	RunE:  runServe,
}

func init() {
	defaultCfg, _ := cfg.DefaultPath()
	rootCmd.PersistentFlags().StringVar(&flagConfig, "config", defaultCfg, "config file")
	rootCmd.PersistentFlags().IntVar(&flagPort, "port", 0, "override listen port")
	rootCmd.PersistentFlags().StringVar(&flagWebDir, "webdir", "", "path to Expo web build")
	rootCmd.AddCommand(serveCmd)
}

func runServe(_ *cobra.Command, _ []string) error {
	c, err := cfg.Load(flagConfig)
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	port := c.Server.Port
	if flagPort != 0 {
		port = flagPort
	}
	webDir := c.Server.WebDir
	if flagWebDir != "" {
		webDir = flagWebDir
	}

	db, err := store.Open(c.DBPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer db.Close()

	urls := network.DetectURLs(port)

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	handler := api.New(db, webDir, urls)

	log.Printf("samizdat %s listening on %s", api.Version(), addr)
	log.Printf("reachable at:\n  %s", strings.Join(urls, "\n  "))
	if webDir != "" {
		log.Printf("web app served from %s", webDir)
	}

	return http.ListenAndServe(addr, handler)
}
