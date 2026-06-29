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
}

type LLMSection struct {
	Provider     string `toml:"provider"` // "anthropic" | "openai_compat"
	APIKey       string `toml:"api_key"`
	BaseURL      string `toml:"base_url"`      // for openai_compat: e.g. "http://localhost:11434/v1"
	DefaultModel string `toml:"default_model"` // fallback when step config omits model
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
		YTDLP:         YTDLPSection{Path: "yt-dlp"},
	}
}

func Load(path string) (*Config, error) {
	cfg := Defaults()
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return cfg, nil
	}
	if _, err := toml.DecodeFile(path, cfg); err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	return cfg, nil
}
