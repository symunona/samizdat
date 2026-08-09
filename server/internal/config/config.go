package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

type Config struct {
	DataDir       string        `toml:"data_dir"`
	VaultDir      string        `toml:"vault_dir"`
	DBPath        string        `toml:"db_path"`
	CacheDir      string        `toml:"cache_dir"`
	ExtractorsDir string        `toml:"extractors_dir"`
	Server        ServerSection `toml:"server"`
	LLM           LLMSection    `toml:"llm"`
	YTDLP         YTDLPSection  `toml:"ytdlp"`
	Export        ExportSection `toml:"export"`
}

// ExportSection configures the one-way auto-export of Documents + Annotations
// to a plain-markdown Obsidian vault on disk. DB → markdown only; files carrying
// our frontmatter id are overwritten, foreign files are never touched. This is a
// backup/observation view, distinct from the reserved (unused) VaultDir.
type ExportSection struct {
	Enabled  bool   `toml:"enabled"`  // run the exporter goroutine
	Dir      string `toml:"dir"`      // output vault folder (created if missing)
	Grouping string `toml:"grouping"` // date subfolders: none|daily|weekly|monthly (default weekly)
	// ImageLinks picks how image embeds are written: "wikilink" (default,
	// `![[<file>]]` — no path, Obsidian resolves by name, so notes survive being
	// moved) or "relative" (`![alt](../assets/<file>)`, portable to plain markdown).
	ImageLinks string `toml:"image_links"`
}

// YTDLPSection configures YouTube/podcast ingestion via yt-dlp. The VPS's
// datacenter IP is bot-blocked by YouTube, so Proxy (a residential SOCKS/HTTP
// proxy, e.g. a home node over Tailscale) is required for the happy path.
// See docs/youtube-ingest.md.
type YTDLPSection struct {
	Path    string `toml:"path"`    // yt-dlp binary; default "yt-dlp" (PATH lookup)
	Proxy   string `toml:"proxy"`   // e.g. "socks5h://100.x.y.z:1080"; empty = direct
	Cookies string `toml:"cookies"` // optional Netscape cookies.txt path (fallback/auth)
}

type ServerSection struct {
	Port         int    `toml:"port"`
	WebDir       string `toml:"web_dir"`
	ExtensionZip string `toml:"extension_zip"`
	// APKPath is THE location of the self-hosted Android APK, served at
	// /download/samizdat.apk with its sidecar at /api/v1/app/android/version.
	// Load() resolves it to an absolute path (see resolveAPKPath), so every
	// reader — the server, `samizdat config apk-path`, and through that every
	// build/deploy recipe — derives from this one setting.
	APKPath string `toml:"apk_path"`
}

type LLMSection struct {
	Provider     string `toml:"provider"` // "anthropic" | "openai_compat"
	APIKey       string `toml:"api_key"`
	BaseURL      string `toml:"base_url"`      // for openai_compat: e.g. "http://localhost:11434/v1"
	DefaultModel string `toml:"default_model"` // fallback when step config omits model

	// Fallback providers tried in order when the primary fails at the transport
	// level (connection refused, timeout, DNS, 5xx) — e.g. a local Ollama that
	// dies → Anthropic Haiku. Real API errors (4xx) propagate without falling
	// through. Each fallback entry's DefaultModel is the model it serves with,
	// since the caller's tier model won't exist on a different provider.
	Fallback []LLMSection `toml:"fallback"`
}

func DefaultPath() (string, error) {
	if _, err := os.Stat("config.toml"); err == nil {
		abs, err := filepath.Abs("config.toml")
		if err == nil {
			return abs, nil
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	return filepath.Join(home, ".samizdat", "config.toml"), nil
}

func Defaults() *Config {
	home, _ := os.UserHomeDir()
	data := filepath.Join(home, ".samizdat")
	return &Config{
		DataDir:       data,
		VaultDir:      filepath.Join(home, "samizdat"),
		DBPath:        filepath.Join(data, "app.db"),
		CacheDir:      filepath.Join(data, "cache"),
		ExtractorsDir: filepath.Join(home, "dev", "sam", "extractors"),
		Server:        ServerSection{Port: 8765},
		Export:        ExportSection{Grouping: "weekly", ImageLinks: "wikilink"},
		YTDLP:         YTDLPSection{Path: "yt-dlp"},
	}
}

// DefaultAPKRelPath is where `just build-android` puts the APK, relative to the
// instance root. Used when apk_path is unset — a fresh clone with no config still
// serves the build it just made.
const DefaultAPKRelPath = "dist/samizdat.apk"

// resolveAPKPath makes the served APK location independent of the working
// directory: a relative apk_path (and the default) resolves against the config
// file's own directory, which is the instance root. The systemd unit has no cwd
// guarantee the way a `just` recipe does, and the flag that used to paper over
// that is gone — this is the only place the path is decided.
func resolveAPKPath(p, cfgPath string) string {
	if p == "" {
		p = DefaultAPKRelPath
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	base := filepath.Dir(cfgPath)
	if abs, err := filepath.Abs(base); err == nil {
		base = abs
	}
	return filepath.Join(base, p)
}

func Load(path string) (*Config, error) {
	cfg := Defaults()
	if _, err := os.Stat(path); os.IsNotExist(err) {
		cfg.Server.APKPath = resolveAPKPath(cfg.Server.APKPath, path)
		return cfg, nil
	}
	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	cfg.Server.APKPath = resolveAPKPath(cfg.Server.APKPath, path)
	switch cfg.Export.Grouping {
	case "", "none", "daily", "weekly", "monthly":
		// "" means: user set no value but also wrote [export] — keep default.
		if cfg.Export.Grouping == "" {
			cfg.Export.Grouping = "weekly"
		}
	default:
		return nil, fmt.Errorf("export.grouping %q invalid: want none|daily|weekly|monthly", cfg.Export.Grouping)
	}
	switch cfg.Export.ImageLinks {
	case "wikilink", "relative":
	case "":
		cfg.Export.ImageLinks = "wikilink"
	default:
		return nil, fmt.Errorf("export.image_links %q invalid: want wikilink|relative", cfg.Export.ImageLinks)
	}
	return cfg, nil
}
