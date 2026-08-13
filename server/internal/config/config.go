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

	// Summarize sizes every LLM pipeline step's input. See SummarizeSection.
	Summarize SummarizeSection `toml:"summarize"`
}

// SummarizeRole is one endpoint an LLM step may call, with the size of what it
// can be handed. Three roles exist: map (one chunk), reduce (the partials), big
// (documents past chunking, and the fallback when a role keeps failing).
type SummarizeRole struct {
	Provider  string `toml:"provider"`   // Router provider id; empty = the configured chain
	Model     string `toml:"model"`      // empty = the provider's default_model
	CtxTokens int    `toml:"ctx_tokens"` // the endpoint's context window
	MaxTokens int    `toml:"max_tokens"` // completion cap for this role
	Prompt    string `toml:"prompt"`     // empty = the step kind's built-in default
}

// SummarizeLimits are the size bands and the retry policy. Every LLM step reads
// them; a step kind may override any subset via SummarizeSection.Steps.
//
// The bands, in estimated input tokens: below ChunkAbove one plain call; below
// BigAbove chunk → map → reduce; otherwise one Big call, truncated to what Big
// holds. There is deliberately no constant for "too big to hold" — that is
// Big.CtxTokens, so raising the model raises the ceiling with it.
type SummarizeLimits struct {
	ChunkAbove   int `toml:"chunk_above"`
	BigAbove     int `toml:"big_above"`
	MaxChunks    int `toml:"max_chunks"` // exceeded → escalate to Big, never drop content
	OverlapRunes int `toml:"overlap_runes"`
	MaxTries     int `toml:"max_tries"` // per role, before falling back to Big

	Map    SummarizeRole `toml:"map"`
	Reduce SummarizeRole `toml:"reduce"`
	Big    SummarizeRole `toml:"big"`
}

// SummarizeSection is the shared defaults plus per-step-kind overrides. Steps
// holds only what differs — zero fields inherit, so a step that wants a bigger
// chunking ceiling writes one line, not a whole block. Overrides cannot nest:
// the map's value type carries no Steps of its own.
type SummarizeSection struct {
	SummarizeLimits
	Steps map[string]SummarizeLimits `toml:"steps"`
}

// ForStep returns the limits a step kind runs with: the shared defaults with the
// kind's non-zero overrides applied.
func (s SummarizeSection) ForStep(kind string) SummarizeLimits {
	base := s.SummarizeLimits
	ov, ok := s.Steps[kind]
	if !ok {
		return base
	}
	overrideInt(&base.ChunkAbove, ov.ChunkAbove)
	overrideInt(&base.BigAbove, ov.BigAbove)
	overrideInt(&base.MaxChunks, ov.MaxChunks)
	overrideInt(&base.OverlapRunes, ov.OverlapRunes)
	overrideInt(&base.MaxTries, ov.MaxTries)
	base.Map = overrideRole(base.Map, ov.Map)
	base.Reduce = overrideRole(base.Reduce, ov.Reduce)
	base.Big = overrideRole(base.Big, ov.Big)
	return base
}

func overrideInt(dst *int, v int) {
	if v != 0 {
		*dst = v
	}
}

func overrideStr(dst *string, v string) {
	if v != "" {
		*dst = v
	}
}

func overrideRole(base, ov SummarizeRole) SummarizeRole {
	overrideStr(&base.Provider, ov.Provider)
	overrideStr(&base.Model, ov.Model)
	overrideStr(&base.Prompt, ov.Prompt)
	overrideInt(&base.CtxTokens, ov.CtxTokens)
	overrideInt(&base.MaxTokens, ov.MaxTokens)
	return base
}

// DefaultSummarize is what an instance with no [llm.summarize] block runs. The
// roles name no provider or model on purpose: an unconfigured instance keeps
// using whatever the step and the Router already resolve, and only the SIZES
// change. Naming a model here would send a Claude id to someone's local box.
func DefaultSummarize() SummarizeSection {
	return SummarizeSection{SummarizeLimits: SummarizeLimits{
		ChunkAbove:   4000,
		BigAbove:     40000,
		MaxChunks:    12,
		OverlapRunes: 200,
		MaxTries:     3,
		Map:          SummarizeRole{CtxTokens: 7000, MaxTokens: 300},
		Reduce:       SummarizeRole{CtxTokens: 7000, MaxTokens: 600},
		Big:          SummarizeRole{CtxTokens: 200000, MaxTokens: 1024},
	}}
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
		LLM:           LLMSection{Summarize: DefaultSummarize()},
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
	if err := validateSummarize(cfg.LLM.Summarize); err != nil {
		return nil, err
	}
	return cfg, nil
}

// validateSummarize rejects band settings that can't be satisfied, at load time
// rather than at the first long document. An ordering mistake here silently
// routes every document to the wrong band, which reads as "the summarizer got
// worse" days later.
func validateSummarize(s SummarizeSection) error {
	check := func(what string, l SummarizeLimits) error {
		if l.ChunkAbove >= l.BigAbove {
			return fmt.Errorf("%s: chunk_above (%d) must be below big_above (%d)", what, l.ChunkAbove, l.BigAbove)
		}
		if l.MaxTries < 1 {
			return fmt.Errorf("%s: max_tries must be at least 1, got %d", what, l.MaxTries)
		}
		if l.MaxChunks < 1 {
			return fmt.Errorf("%s: max_chunks must be at least 1, got %d", what, l.MaxChunks)
		}
		if l.OverlapRunes < 0 {
			return fmt.Errorf("%s: overlap_runes must not be negative, got %d", what, l.OverlapRunes)
		}
		// Fixed order: a map here would report a different role each run.
		for _, r := range []struct {
			name string
			role SummarizeRole
		}{{"map", l.Map}, {"reduce", l.Reduce}, {"big", l.Big}} {
			if r.role.CtxTokens < 1 {
				return fmt.Errorf("%s.%s: ctx_tokens must be positive, got %d", what, r.name, r.role.CtxTokens)
			}
		}
		return nil
	}
	if err := check("llm.summarize", s.SummarizeLimits); err != nil {
		return err
	}
	for kind := range s.Steps {
		if err := check("llm.summarize.steps."+kind, s.ForStep(kind)); err != nil {
			return err
		}
	}
	return nil
}
