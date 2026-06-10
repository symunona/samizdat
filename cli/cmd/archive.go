package cmd

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
	_ "modernc.org/sqlite"
)

var archiveCmd = &cobra.Command{
	Use:   "archive",
	Short: "Manage DB archives",
}

var archiveCurrentCmd = &cobra.Command{
	Use:   "current",
	Short: "Archive current DB with timestamp, then reset (keeps feeds/subscriptions)",
	RunE:  runArchiveCurrent,
}

var archiveListCmd = &cobra.Command{
	Use:   "list",
	Short: "List archived DB files",
	RunE:  runArchiveList,
}

var archiveRestoreCmd = &cobra.Command{
	Use:   "restore [name]",
	Short: "Restore a DB archive; name is relative to archives dir unless absolute",
	Args:  cobra.ExactArgs(1),
	RunE:  runArchiveRestore,
}

func init() {
	archiveCmd.AddCommand(archiveCurrentCmd, archiveListCmd, archiveRestoreCmd)
}

func archivesDir(cfg *config.Config) string {
	return filepath.Join(cfg.DataDir, "archives")
}

func loadArchiveCfg() (*config.Config, error) {
	cfgPath, err := config.DefaultPath()
	if err != nil {
		return nil, fmt.Errorf("default config path: %w", err)
	}
	return config.Load(cfgPath)
}

func runArchiveCurrent(_ *cobra.Command, _ []string) error {
	cfg, err := loadArchiveCfg()
	if err != nil {
		return err
	}

	if _, err := os.Stat(cfg.DBPath); os.IsNotExist(err) {
		return fmt.Errorf("DB not found: %s", cfg.DBPath)
	}

	archDir := archivesDir(cfg)
	if err := os.MkdirAll(archDir, 0700); err != nil {
		return fmt.Errorf("create archives dir: %w", err)
	}

	ts := time.Now().Format("2006-01-02T15-04-05")
	dst := filepath.Join(archDir, fmt.Sprintf("app-%s.db", ts))

	if err := copyFile(cfg.DBPath, dst); err != nil {
		return fmt.Errorf("copy DB: %w", err)
	}
	fmt.Printf("Archived → %s\n", dst)

	fmt.Println("Resetting live DB (keeping feeds, subscriptions, devices, settings, pipelines)...")
	if err := resetDB(cfg.DBPath); err != nil {
		return fmt.Errorf("reset DB: %w", err)
	}
	fmt.Println("Reset complete.")
	return nil
}

// resetDB clears content tables in FK-safe order, keeps subscriptions/feeds/devices/settings/pipelines.
func resetDB(dbPath string) error {
	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return fmt.Errorf("open DB: %w", err)
	}
	defer func() { _ = db.Close() }()

	tables := []string{
		"highlight_tags",
		"annotation_tags",
		"document_tags",
		"highlights",
		"annotations",
		"pipeline_runs",
		"jobs",
		"read_states",
		"feed_items",
		"media_assets",
		"documents",
	}

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, t := range tables {
		if _, err := tx.Exec("DELETE FROM " + t); err != nil { //nolint:gosec
			return fmt.Errorf("clear %s: %w", t, err)
		}
		fmt.Printf("  cleared %s\n", t)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	if _, err := db.Exec("VACUUM"); err != nil {
		return fmt.Errorf("vacuum: %w", err)
	}

	return nil
}

func runArchiveList(_ *cobra.Command, _ []string) error {
	cfg, err := loadArchiveCfg()
	if err != nil {
		return err
	}

	archDir := archivesDir(cfg)
	fmt.Printf("User dir: %s\n\n", cfg.DataDir)

	entries, err := os.ReadDir(archDir)
	if os.IsNotExist(err) {
		fmt.Println("(no archives yet)")
		return nil
	}
	if err != nil {
		return fmt.Errorf("read archives dir: %w", err)
	}

	var files []os.DirEntry
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".db") {
			files = append(files, e)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() > files[j].Name() })

	if len(files) == 0 {
		fmt.Println("(no archives yet)")
		return nil
	}

	for _, f := range files {
		info, _ := f.Info()
		if info != nil {
			fmt.Printf("  %-40s  %s\n", f.Name(), formatBytes(info.Size()))
		} else {
			fmt.Printf("  %s\n", f.Name())
		}
	}
	return nil
}

func runArchiveRestore(_ *cobra.Command, args []string) error {
	cfg, err := loadArchiveCfg()
	if err != nil {
		return err
	}

	name := args[0]
	src := name
	if !filepath.IsAbs(name) {
		src = filepath.Join(archivesDir(cfg), name)
	}

	if _, err := os.Stat(src); os.IsNotExist(err) {
		return fmt.Errorf("archive not found: %s", src)
	}

	fmt.Printf("WARNING: This will overwrite %s with %s.\n", cfg.DBPath, src)
	fmt.Println("Server must be stopped before restoring.")
	fmt.Print("Proceed? [y/N] ")
	var ans string
	fmt.Scanln(&ans) //nolint:errcheck
	if strings.ToLower(strings.TrimSpace(ans)) != "y" {
		fmt.Println("Aborted.")
		return nil
	}

	if err := copyFile(src, cfg.DBPath); err != nil {
		return fmt.Errorf("restore: %w", err)
	}
	fmt.Printf("Restored %s → %s\n", src, cfg.DBPath)
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()

	_, err = io.Copy(out, in)
	return err
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
