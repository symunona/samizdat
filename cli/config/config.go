package config

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/BurntSushi/toml"
)

type Config struct {
	DataDir     string        `toml:"data_dir"`
	VaultDir    string        `toml:"vault_dir"`
	DBPath      string        `toml:"db_path"`
	DeviceToken string        `toml:"device_token,omitempty"` // cached local-trust bearer token for CLI→server calls
	LLM         LLMConfig     `toml:"llm"`
	Network     NetworkConfig `toml:"network"`
	Server      ServerConfig  `toml:"server"`
}

// LLMTier maps to one of the three routing tiers: triage, breakdown, digest.
type LLMTier struct {
	Provider string `toml:"provider"` // "anthropic" | "openai-compat"
	Endpoint string `toml:"endpoint,omitempty"`
	Model    string `toml:"model"`
	APIKey   string `toml:"api_key,omitempty"`
}

type LLMConfig struct {
	Triage    LLMTier `toml:"triage"`
	Breakdown LLMTier `toml:"breakdown"`
	Digest    LLMTier `toml:"digest"`
}

type NetworkConfig struct {
	Mode   string `toml:"mode"`   // "local" | "public" | "tailscale"
	Domain string `toml:"domain"` // empty = IP only
	Port   int    `toml:"port"`
	TLS    bool   `toml:"tls"`
}

type ServerConfig struct {
	Port   int    `toml:"port"`
	WebDir string `toml:"web_dir"`
}

func DefaultPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("user home dir: %w", err)
	}
	return filepath.Join(home, ".samizdat", "config.toml"), nil
}

func Defaults() *Config {
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".samizdat")
	return &Config{
		DataDir:  dataDir,
		VaultDir: filepath.Join(dataDir, "vault"),
		DBPath:   filepath.Join(dataDir, "app.db"),
		LLM: LLMConfig{
			Triage: LLMTier{
				Provider: "openai-compat",
				Endpoint: "http://localhost:11434",
				Model:    "llama3.2",
			},
			Breakdown: LLMTier{
				Provider: "anthropic",
				Model:    "claude-sonnet-4-6",
			},
			Digest: LLMTier{
				Provider: "anthropic",
				Model:    "claude-opus-4-8",
			},
		},
		Network: NetworkConfig{
			Mode: "local",
			Port: 8765,
			TLS:  false,
		},
		Server: ServerConfig{
			Port: 8765,
		},
	}
}

// Load reads config from path, returning defaults for any missing fields.
// Returns defaults (not error) if the file does not exist yet.
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

// Save writes cfg to path as TOML with 0600 permissions.
// Save re-serializes the WHOLE file from this struct, so it silently drops every
// key this struct does not model. That is fine for `sam setup`, which authors the
// file — and catastrophic for anything else: the server's config.toml has a richer
// schema ([llm] provider/base_url/fallback, [ytdlp], [export], …), and one Save
// against it wipes all of them. To persist a single value into a config you did
// not author, use SaveDeviceToken (or write another surgical helper like it).
func Save(cfg *Config, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return fmt.Errorf("mkdir config dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return fmt.Errorf("open config file: %w", err)
	}
	defer func() { _ = f.Close() }()
	if err := toml.NewEncoder(f).Encode(cfg); err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	return nil
}

// deviceTokenRe matches the cached-token line anywhere in a TOML file, at the top
// level (leading whitespace only — a line indented under a [table] would belong to
// that table, not to the root key we mean).
var deviceTokenRe = regexp.MustCompile(`(?m)^[ \t]*device_token[ \t]*=.*$`)

// SaveDeviceToken writes the cached local-trust token into path, touching NOTHING
// else: it rewrites the one line if present, else appends it. The CLI caches its
// token in whatever config it was pointed at — including the server's, whose schema
// this package does not model — so a full re-encode there would destroy the user's
// configuration. It did, once. Hence the surgical edit.
func SaveDeviceToken(path, token string) error {
	line := fmt.Sprintf("device_token = %q", token)

	raw, err := os.ReadFile(path) //nolint:gosec // path comes from --config / DefaultPath
	if err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("read config file: %w", err)
		}
		// No config yet: create a minimal one rather than a full Defaults() dump, so
		// a later hand-written config is never fighting keys it did not ask for.
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return fmt.Errorf("mkdir config dir: %w", err)
		}
		if err := os.WriteFile(path, []byte(line+"\n"), 0600); err != nil {
			return fmt.Errorf("write config file: %w", err)
		}
		return nil
	}

	out := string(raw)
	if deviceTokenRe.MatchString(out) {
		out = deviceTokenRe.ReplaceAllLiteralString(out, line)
	} else {
		// Prepend: appending would land inside whatever [table] ends the file, which
		// would make it that table's key instead of a root one.
		out = line + "\n" + out
	}
	if err := os.WriteFile(path, []byte(out), 0600); err != nil {
		return fmt.Errorf("write config file: %w", err)
	}
	return nil
}
