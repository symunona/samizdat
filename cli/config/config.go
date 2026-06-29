package config

import (
	"fmt"
	"os"
	"path/filepath"

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
