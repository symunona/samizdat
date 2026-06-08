package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

type Config struct {
	DataDir  string        `toml:"data_dir"`
	VaultDir string        `toml:"vault_dir"`
	DBPath   string        `toml:"db_path"`
	Server   ServerSection `toml:"server"`
}

type ServerSection struct {
	Port   int    `toml:"port"`
	WebDir string `toml:"web_dir"`
}

func DefaultPath() (string, error) {
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
		DataDir:  data,
		VaultDir: filepath.Join(home, "samizdat"),
		DBPath:   filepath.Join(data, "app.db"),
		Server:   ServerSection{Port: 8765},
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
