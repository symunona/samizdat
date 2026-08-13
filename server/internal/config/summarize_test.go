package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

// A partial [llm.summarize] block must keep every default it doesn't mention —
// including the ones on the embedded SummarizeLimits, which the TOML decoder has
// to treat as inline keys of the section rather than as a nested table.
func TestSummarizePartialBlockKeepsDefaults(t *testing.T) {
	cfg, err := Load(writeConfig(t, `
[llm.summarize]
big_above = 60000

[llm.summarize.map]
provider = "xayah"
model = "qwen3:4b-instruct-ctx7k"
`))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	s := cfg.LLM.Summarize
	if s.BigAbove != 60000 {
		t.Fatalf("big_above not decoded: %d", s.BigAbove)
	}
	if s.ChunkAbove != 4000 || s.MaxTries != 3 || s.MaxChunks != 12 {
		t.Fatalf("unset limits lost their defaults: %+v", s.SummarizeLimits)
	}
	if s.Map.Provider != "xayah" || s.Map.MaxTokens != 300 {
		t.Fatalf("map role merge wrong: %+v", s.Map)
	}
	if s.Big.CtxTokens != 200000 {
		t.Fatalf("big role lost its default ctx: %+v", s.Big)
	}
}

// No config file at all still yields usable bands.
func TestSummarizeDefaultsWithoutFile(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.toml"))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := validateSummarize(cfg.LLM.Summarize); err != nil {
		t.Fatalf("defaults do not validate: %v", err)
	}
}

func TestSummarizeForStepOverrides(t *testing.T) {
	cfg, err := Load(writeConfig(t, `
[llm.summarize]
big_above = 40000

[llm.summarize.reduce]
provider = "xayah"
max_tokens = 600

[llm.summarize.steps.llm_ai_newsletter]
big_above = 60000

[llm.summarize.steps.llm_ai_newsletter.reduce]
max_tokens = 900
`))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	base := cfg.LLM.Summarize.ForStep("llm_summarize")
	if base.BigAbove != 40000 || base.Reduce.MaxTokens != 600 {
		t.Fatalf("unlisted step should inherit: %+v", base)
	}
	ov := cfg.LLM.Summarize.ForStep("llm_ai_newsletter")
	if ov.BigAbove != 60000 {
		t.Fatalf("step override not applied: %d", ov.BigAbove)
	}
	if ov.Reduce.MaxTokens != 900 {
		t.Fatalf("role override not applied: %+v", ov.Reduce)
	}
	if ov.Reduce.Provider != "xayah" {
		t.Fatalf("role override must not clear inherited keys: %+v", ov.Reduce)
	}
	if ov.ChunkAbove != 4000 {
		t.Fatalf("override leaked into unrelated key: %d", ov.ChunkAbove)
	}
	// The base must be unchanged by a ForStep call — merge works on a copy.
	if cfg.LLM.Summarize.BigAbove != 40000 {
		t.Fatalf("ForStep mutated the shared defaults: %d", cfg.LLM.Summarize.BigAbove)
	}
}

func TestSummarizeValidationRejectsBadBands(t *testing.T) {
	_, err := Load(writeConfig(t, `
[llm.summarize]
chunk_above = 50000
big_above = 40000
`))
	if err == nil {
		t.Fatal("chunk_above above big_above must fail to load")
	}
}

func TestSummarizeValidationCoversStepOverrides(t *testing.T) {
	_, err := Load(writeConfig(t, `
[llm.summarize.steps.llm_summarize]
chunk_above = 90000
`))
	if err == nil {
		t.Fatal("a step override that inverts the bands must fail to load")
	}
}
