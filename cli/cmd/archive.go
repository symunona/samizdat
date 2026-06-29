package cmd

import (
	"database/sql"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
	_ "modernc.org/sqlite"
)

const (
	red   = "\033[31m"
	bold  = "\033[1m"
	reset = "\033[0m"
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
	cfgPath, err := resolveConfigPath()
	if err != nil {
		return nil, err
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

	// Checkpoint WAL into main file so the copy is complete.
	fmt.Println("Checkpointing WAL...")
	if err := checkpointDB(cfg.DBPath); err != nil {
		return fmt.Errorf("checkpoint: %w", err)
	}

	ts := time.Now().Format("2006-01-02T15-04-05")
	dst := filepath.Join(archDir, fmt.Sprintf("app-%s.db", ts))

	fmt.Printf("Archives dir: %s\n", archDir)
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

// resetDB clears content tables in FK-safe order, keeps feeds/subscriptions/devices/settings/pipelines.
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
		var exists int
		if err := tx.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", t,
		).Scan(&exists); err != nil {
			return fmt.Errorf("check table %s: %w", t, err)
		}
		if exists == 0 {
			fmt.Printf("  skipped %s (not in schema)\n", t)
			continue
		}
		if _, err := tx.Exec("DELETE FROM " + t); err != nil { //nolint:gosec
			return fmt.Errorf("clear %s: %w", t, err)
		}
		fmt.Printf("  cleared %s\n", t)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	// Skip VACUUM: it rebuilds the DB from the main file, which may not yet
	// include WAL-only writes (e.g. polling_enabled) if the server is running.
	// Space is reclaimed on the next WAL checkpoint. Run VACUUM manually when
	// the server is stopped if compaction is needed.

	return nil
}

func checkpointDB(dbPath string) error {
	db, err := sql.Open("sqlite", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return fmt.Errorf("open DB: %w", err)
	}
	defer func() { _ = db.Close() }()
	// PASSIVE: safe with concurrent readers — doesn't truncate or block.
	// TRUNCATE with a live server → SQLITE_CORRUPT.
	var busy, total, done int
	if err := db.QueryRow("PRAGMA wal_checkpoint(PASSIVE)").Scan(&busy, &total, &done); err != nil {
		return fmt.Errorf("wal_checkpoint: %w", err)
	}
	if total != done {
		fmt.Printf("\n%s%sWARNING: server is running — only %d/%d WAL frames checkpointed.%s\n", red, bold, done, total, reset)
		fmt.Printf("%sArchive will be missing recent writes.%s\n\n", red, reset)
		fmt.Println("  [k] Kill server and archive cleanly")
		fmt.Println("  [c] Cancel")
		fmt.Print("\nChoice: ")
		var ans string
		fmt.Scanln(&ans) //nolint:errcheck
		switch strings.ToLower(strings.TrimSpace(ans)) {
		case "k":
			fmt.Println("Stopping server...")
			if err := stopServer(); err != nil {
				return fmt.Errorf("stop server: %w", err)
			}
			// Full checkpoint now that server is stopped.
			if _, err := db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
				return fmt.Errorf("wal_checkpoint after stop: %w", err)
			}
			fmt.Println("Server stopped, WAL fully checkpointed.")
		default:
			return fmt.Errorf("aborted: stop the server then retry")
		}
	}
	return nil
}

func stopServer() error {
	if err := exec.Command("pkill", "-TERM", "-x", "samizdat").Run(); err != nil {
		// exit 1 means no process found — already stopped
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return nil
		}
		return err
	}
	// Give the server a moment to flush and close the WAL.
	time.Sleep(500 * time.Millisecond)
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

	// Remove stale WAL/SHM so they don't corrupt the restored state.
	for _, suffix := range []string{"-wal", "-shm"} {
		p := cfg.DBPath + suffix
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Warning: could not remove %s: %v\n", p, err)
		}
	}

	fmt.Printf("Restored %s → %s\n", src, cfg.DBPath)
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("open src: %w", err)
	}
	defer func() { _ = in.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("open dst: %w", err)
	}
	defer func() { _ = out.Close() }()

	if _, err = io.Copy(out, in); err != nil {
		return fmt.Errorf("copy: %w", err)
	}
	return nil
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
