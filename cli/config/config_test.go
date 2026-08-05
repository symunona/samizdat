package config_test

import (
	"os"
	"path/filepath"
	"strings"
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

// The bug this exists to prevent: the CLI caching its device token into the
// SERVER's config.toml re-encoded the whole file through the CLI's struct and
// dropped every key that struct does not model — [llm], [ytdlp], [export], the
// lot. SaveDeviceToken must touch exactly one line.
func TestSaveDeviceTokenPreservesForeignKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	original := `data_dir = "/home/u/.samizdat"

# Local box first.
[llm]
provider      = "openai_compat"
base_url      = "http://100.111.210.47:11434/v1"
default_model = "qwen3:4b-instruct-ctx7k"

[[llm.fallback]]
provider      = "anthropic"

[export]
enabled = true
dir     = "/home/u/vault"
`
	if err := os.WriteFile(path, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err := config.SaveDeviceToken(path, "tok-123"); err != nil {
		t.Fatalf("SaveDeviceToken: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(raw)
	for _, want := range []string{
		"[llm]", `base_url      = "http://100.111.210.47:11434/v1"`, "[[llm.fallback]]",
		"[export]", `dir     = "/home/u/vault"`, "# Local box first.",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("SaveDeviceToken dropped %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, `device_token = "tok-123"`) {
		t.Errorf("token not written:\n%s", out)
	}
	// It must be a ROOT key: appended at the end it would land inside [export].
	if strings.Index(out, "device_token") > strings.Index(out, "[llm]") {
		t.Errorf("device_token landed inside a table:\n%s", out)
	}
}

// Re-caching a rotated token replaces the line instead of stacking another one.
func TestSaveDeviceTokenReplacesInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("device_token = \"old\"\n\n[server]\nport = 8765\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := config.SaveDeviceToken(path, "new"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(raw)
	if strings.Count(out, "device_token") != 1 {
		t.Errorf("want exactly one device_token line:\n%s", out)
	}
	if !strings.Contains(out, `device_token = "new"`) || strings.Contains(out, `"old"`) {
		t.Errorf("token not replaced:\n%s", out)
	}
	if !strings.Contains(out, "port = 8765") {
		t.Errorf("rest of the file lost:\n%s", out)
	}
}

// A missing config must not be born as a full Defaults() dump — that is how a
// hand-written config ends up fighting keys nobody asked for.
func TestSaveDeviceTokenCreatesMinimalFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "config.toml")
	if err := config.SaveDeviceToken(path, "tok"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "device_token = \"tok\"\n" {
		t.Errorf("want just the token line, got:\n%s", raw)
	}
}
