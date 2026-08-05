package llm

import (
	"net/url"
	"os"
	"strings"

	"github.com/symunona/samizdat/server/internal/config"
)

// A Provider is one LLM endpoint the server knows about — from config, from an
// env key, or from a well-known local address. It is the unit the Router routes
// to, the unit `just check-llm` probes, and the unit the model picker groups by.
//
// Transport is which of the two clients speaks to it; Flavor is what the endpoint
// *is*, which only ever drives probing and model listing. Two openai_compat boxes
// (a local Ollama and OpenRouter) share a transport and share nothing else.
type Provider struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Transport string `json:"transport"`
	Flavor    string `json:"flavor"`
	BaseURL   string `json:"base_url,omitempty"`
	Model     string `json:"model,omitempty"` // the section's default_model
	Source    string `json:"source"`          // config | fallback | env | well-known
	Role      string `json:"role"`            // primary | fallback | available
	HasKey    bool   `json:"has_key"`
	NeedsKey  bool   `json:"needs_key"`

	// apiKey is unexported: it is never serialized, and a Provider copy handed to
	// an API handler cannot leak it (design rule 5).
	apiKey string
}

// Transports.
const (
	transportAnthropic = "anthropic"
	transportOpenAI    = "openai_compat"
)

// Flavors. Everything that is not a known cloud endpoint is "local": a box that
// serves whatever was pulled onto it and needs no credentials.
const (
	flavorAnthropic  = "anthropic"
	flavorOpenRouter = "openrouter"
	flavorOpenAI     = "openai"
	flavorLocal      = "local"
)

// defaultOllamaBaseURL is the well-known local candidate. It is always offered as
// a provider; the probe decides whether anything is listening.
const defaultOllamaBaseURL = "http://localhost:11434/v1"

// anthropicBaseURL is a var, not a const, so probe/router tests can point it at a
// local httptest server (same trick as extractor.substackAPIBase). There is
// exactly one real value.
var anthropicBaseURL = "https://api.anthropic.com"

// Env vars consulted during discovery, in addition to the config file.
const (
	envAnthropicKey  = "ANTHROPIC_API_KEY"
	envOpenAIKey     = "OPENAI_API_KEY"
	envOpenRouterKey = "OPENROUTER_API_KEY"
)

// newProvider builds a Provider from a config section, resolving the transport
// defaults exactly as the clients do — a row must name the endpoint that will
// actually be called, not the one that was written down.
func newProvider(sec config.LLMSection, source, role string) *Provider {
	transport := sec.Provider
	if transport == "" {
		transport = transportAnthropic // auto-detect path: ANTHROPIC_API_KEY
	}
	baseURL := sec.BaseURL
	switch transport {
	case transportAnthropic:
		baseURL = "" // one endpoint; a base URL here would be a second identity for it
	case transportOpenAI:
		if baseURL == "" {
			baseURL = defaultOllamaBaseURL
		}
	}

	flavor := flavorFor(transport, baseURL)
	p := &Provider{
		Transport: transport,
		Flavor:    flavor,
		BaseURL:   baseURL,
		Model:     sec.DefaultModel,
		Source:    source,
		Role:      role,
		NeedsKey:  flavor != flavorLocal,
		apiKey:    resolveKey(sec.APIKey, flavor),
	}
	p.ID = providerID(transport, baseURL, flavor)
	p.Label = providerLabel(p.ID, flavor)
	p.HasKey = p.apiKey != ""
	return p
}

// resolveKey applies the env fallback per flavor. A local box legitimately has no
// key, so an empty one there is not a gap.
func resolveKey(configured, flavor string) string {
	if configured != "" {
		return configured
	}
	switch flavor {
	case flavorAnthropic:
		return os.Getenv(envAnthropicKey)
	case flavorOpenRouter:
		return os.Getenv(envOpenRouterKey)
	case flavorOpenAI:
		return os.Getenv(envOpenAIKey)
	}
	return ""
}

func flavorFor(transport, baseURL string) string {
	if transport == transportAnthropic {
		return flavorAnthropic
	}
	switch hostOf(baseURL) {
	case "openrouter.ai":
		return flavorOpenRouter
	case "api.openai.com":
		return flavorOpenAI
	}
	return flavorLocal
}

// providerID is the stable, human-typeable name a pipeline step stores. Cloud
// endpoints get their brand; anything self-hosted gets host:port, which is the
// only thing that tells two Ollama boxes apart.
func providerID(transport, baseURL, flavor string) string {
	switch flavor {
	case flavorAnthropic:
		return "anthropic"
	case flavorOpenRouter:
		return "openrouter"
	case flavorOpenAI:
		return "openai"
	}
	if h := hostOf(baseURL); h != "" {
		return h
	}
	return transport
}

func providerLabel(id, flavor string) string {
	switch flavor {
	case flavorAnthropic:
		return "Anthropic"
	case flavorOpenRouter:
		return "OpenRouter"
	case flavorOpenAI:
		return "OpenAI"
	}
	return id
}

// hostOf returns host:port, which is the identity of a self-hosted box.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Host
}

// HealthKey is the health-registry identity (transport + base URL). It is
// deliberately NOT the friendly ID: llm_usages and the persisted health rows were
// written with it, and renaming the identity would orphan them.
func (p Provider) HealthKey() string { return ProviderKey(p.Transport, p.BaseURL) }

// client builds the transport client for this provider. Each carries the
// provider's default model, so a caller that names none gets THIS endpoint's
// model — never another provider's (a Claude id on an Ollama box is a 404, and a
// 404 never falls back).
func (p *Provider) client() Client {
	if p.Transport == transportAnthropic {
		return &anthropicClient{apiKey: p.apiKey, defaultModel: p.Model, baseURL: anthropicBaseURL}
	}
	return &openAICompatClient{baseURL: p.BaseURL, apiKey: p.apiKey, defaultModel: p.Model}
}

// HasKey reports whether a config section resolves to credentials — including the
// env fallback. A local openai_compat box needs none, so it always reads keyed.
func HasKey(cfg config.LLMSection) bool {
	p := newProvider(cfg, "config", "primary")
	return p.HasKey || !p.NeedsKey
}

// trimSlash normalizes a base URL for joining.
func trimSlash(s string) string { return strings.TrimRight(s, "/") }
