package llm

import (
	"os"

	"github.com/symunona/samizdat/server/internal/config"
)

// Discover builds the full provider set: what config declares, plus what the
// environment makes reachable anyway. The order is the routing order — primary
// first, then each fallback, then everything merely available.
//
// There is deliberately NO LAN scan. The LAN Ollama box is whatever `base_url`
// names in config; sweeping a subnet to find another would be slow, rude, and
// would invent endpoints the user never asked to send documents to.
func Discover(cfg config.LLMSection) []*Provider {
	var out []*Provider
	seen := map[string]bool{}

	add := func(p *Provider) {
		if seen[p.HealthKey()] {
			return
		}
		seen[p.HealthKey()] = true
		out = append(out, p)
	}

	if configured(cfg) {
		add(newProvider(cfg, "config", "primary"))
	}
	for _, fb := range cfg.Fallback {
		add(newProvider(fb, "fallback", "fallback"))
	}

	// An env key is a usable provider even when config never mentions it — that is
	// what makes the model picker and `just check-llm` show OpenRouter the moment a
	// key exists, with no config edit.
	for _, c := range envCandidates() {
		if resolveKey("", c.flavor) == "" {
			continue
		}
		add(newProvider(c.sec, "env", "available"))
	}

	// Always a candidate: the probe, not a guess, decides whether it is alive.
	add(newProvider(config.LLMSection{Provider: transportOpenAI, BaseURL: defaultOllamaBaseURL}, "well-known", "available"))

	return out
}

// configured reports whether the [llm] section says anything at all. An empty
// section with no env key means "no LLM", and must not mint an Anthropic row.
func configured(cfg config.LLMSection) bool {
	if cfg.Provider != "" || cfg.APIKey != "" || cfg.BaseURL != "" {
		return true
	}
	return os.Getenv(envAnthropicKey) != ""
}

// envCandidates maps each recognized env key to the section it would produce.
func envCandidates() []struct {
	flavor string
	sec    config.LLMSection
} {
	return []struct {
		flavor string
		sec    config.LLMSection
	}{
		{flavorAnthropic, config.LLMSection{Provider: transportAnthropic}},
		{flavorOpenRouter, config.LLMSection{Provider: transportOpenAI, BaseURL: "https://openrouter.ai/api/v1"}},
		{flavorOpenAI, config.LLMSection{Provider: transportOpenAI, BaseURL: "https://api.openai.com/v1"}},
	}
}
