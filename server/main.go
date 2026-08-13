package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/server/internal/api"
	cfg "github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/logger"
	"github.com/symunona/samizdat/server/internal/network"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
	"github.com/symunona/samizdat/server/internal/worker"
)

var logServer = logger.New("server")

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

var (
	flagConfig       string
	flagPort         int
	flagWebDir       string
	flagExtensionZip string
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

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Report resolved configuration values",
}

// The build/deploy side (justfile recipes, tools/verify-apk.sh) must write the APK
// exactly where the server reads it. Rather than re-implement the resolution in
// shell, they ask the server binary — `just _apk-path` wraps this — so there is
// one resolver and nothing to keep in sync.
var configAPKPathCmd = &cobra.Command{
	Use:   "apk-path",
	Short: "Print the absolute path of the served Android APK ([server] apk_path)",
	RunE: func(_ *cobra.Command, _ []string) error {
		c, err := cfg.Load(flagConfig)
		if err != nil {
			return fmt.Errorf("load config: %w", err)
		}
		fmt.Println(c.Server.APKPath)
		return nil
	},
}

func init() {
	defaultCfg, _ := cfg.DefaultPath()
	rootCmd.PersistentFlags().StringVar(&flagConfig, "config", defaultCfg, "config file")
	rootCmd.PersistentFlags().IntVar(&flagPort, "port", 0, "override listen port")
	rootCmd.PersistentFlags().StringVar(&flagWebDir, "webdir", "", "path to Expo web build")
	rootCmd.PersistentFlags().StringVar(&flagExtensionZip, "extension-zip", "", "path to built Chrome extension zip (served at /extension/sam-chrome.zip)")
	configCmd.AddCommand(configAPKPathCmd)
	rootCmd.AddCommand(serveCmd, configCmd)
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
	extensionZip := c.Server.ExtensionZip
	if flagExtensionZip != "" {
		extensionZip = flagExtensionZip
	}
	db, err := store.Open(c.DBPath)
	if err != nil {
		return fmt.Errorf("open db: %w", err)
	}
	defer func() { _ = db.Close() }()

	// Data migration that needs the step catalog (which imports store, so it
	// cannot run inside store's migrate()): write each step's default prompt
	// into its config so it becomes visible + editable. One-shot, self-guarded.
	if err := pipeline.BackfillStepPrompts(context.Background(), store.New(db)); err != nil {
		return fmt.Errorf("backfill step prompts: %w", err)
	}

	// Same shape: video bodies written before the roll-up fix hold every spoken line
	// three times. The cached .vtt files make that repairable offline.
	if err := worker.BackfillTranscripts(context.Background(), store.New(db), c.CacheDir); err != nil {
		return fmt.Errorf("backfill transcripts: %w", err)
	}

	if err := os.MkdirAll(c.CacheDir+"/media", 0755); err != nil {
		return fmt.Errorf("create cache dir: %w", err)
	}

	urls := network.DetectURLs(port)

	addr := fmt.Sprintf("0.0.0.0:%d", port)
	handler := api.New(context.Background(), db, webDir, extensionZip, c.Server.APKPath, urls, c.DataDir, c.CacheDir, c.ExtractorsDir, c.YTDLP, c.Export, c.LLM)

	logServer.Printf("samizdat %s (%s) listening on %s", api.Version(), api.Build(), addr)
	logServer.Printf("reachable at:\n  %s", strings.Join(urls, "\n  "))
	if webDir != "" {
		logServer.Printf("web app served from %s", webDir)
	}

	if err := http.ListenAndServe(addr, handler); err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	return nil
}
