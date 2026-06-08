package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/symunona/samizdat/cli/config"
)

func TestDefaultsNotEmpty(t *testing.T) {
	cfg := config.Defaults()
	if cfg.DataDir == "" {
		t.Fatal("DataDir empty")
	}
	if cfg.LLM.Breakdown.Model == "" {
		t.Fatal("breakdown model empty")
	}
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	orig := config.Defaults()
	orig.LLM.Triage.Model = "my-custom-model"
	orig.Network.Domain = "example.com"

	if err := config.Save(orig, path); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded.LLM.Triage.Model != "my-custom-model" {
		t.Errorf("triage model: got %q", loaded.LLM.Triage.Model)
	}
	if loaded.Network.Domain != "example.com" {
		t.Errorf("domain: got %q", loaded.Network.Domain)
	}
}

func TestLoadMissingReturnsDefaults(t *testing.T) {
	cfg, err := config.Load("/nonexistent/path/config.toml")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Server.Port == 0 {
		t.Fatal("expected default port")
	}
}

func TestSavePerms(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	if err := config.Save(config.Defaults(), path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Errorf("perm: got %o, want 0600", info.Mode().Perm())
	}
}
