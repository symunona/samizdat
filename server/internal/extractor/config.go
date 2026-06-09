package extractor

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

// ExtractorConfig is the parsed feed.yaml for a domain.
type ExtractorConfig struct {
	// Kind is the adapter type: rss | html_links | js_script
	Kind string `yaml:"kind"`

	// html_links fields
	Selector   string `yaml:"selector,omitempty"`
	URLPattern string `yaml:"url_pattern,omitempty"`
	BaseURL    string `yaml:"base_url,omitempty"`
	MaxURLs    int    `yaml:"max_urls,omitempty"`

	// rss fields
	FeedURL string `yaml:"feed_url,omitempty"`

	// js_script: script loaded separately as ScriptBytes
	ScriptBytes []byte `yaml:"-"`
}

// Registry maps lowercase domain names to their ExtractorConfig.
type Registry map[string]ExtractorConfig

// LoadAll walks extractors/<domain>/feed.yaml relative to dir and builds a Registry.
// dir is the path to the extractors/ root directory.
func LoadAll(dir string) (Registry, error) {
	reg := make(Registry)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return reg, nil
		}
		return nil, fmt.Errorf("read extractors dir %q: %w", dir, err)
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == "_template" {
			continue
		}
		domain := e.Name()
		yamlPath := filepath.Join(dir, domain, "feed.yaml")
		data, err := os.ReadFile(yamlPath)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, fmt.Errorf("read %q: %w", yamlPath, err)
		}
		var cfg ExtractorConfig
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return nil, fmt.Errorf("parse %q: %w", yamlPath, err)
		}
		if cfg.MaxURLs == 0 {
			cfg.MaxURLs = 100
		}
		if cfg.Kind == "js_script" {
			jsPath := filepath.Join(dir, domain, "extractor.js")
			script, err := os.ReadFile(jsPath)
			if err != nil && !os.IsNotExist(err) {
				return nil, fmt.Errorf("read script %q: %w", jsPath, err)
			}
			cfg.ScriptBytes = script
		}
		reg[domain] = cfg
	}
	return reg, nil
}

// SaveConfig writes cfg to extractorsDir/<domain>/feed.yaml and registers it in memory.
func (r Registry) SaveConfig(extractorsDir, domain string, cfg ExtractorConfig) error {
	dir := filepath.Join(extractorsDir, domain)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %q: %w", dir, err)
	}
	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}
	path := filepath.Join(dir, "feed.yaml")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return fmt.Errorf("write %q: %w", path, err)
	}
	r[domain] = cfg
	return nil
}

// LookupByURL resolves the domain from rawURL and looks it up in the registry.
func (r Registry) LookupByURL(rawURL string) (ExtractorConfig, bool) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ExtractorConfig{}, false
	}
	host := u.Hostname() // strips port
	cfg, ok := r[host]
	return cfg, ok
}
