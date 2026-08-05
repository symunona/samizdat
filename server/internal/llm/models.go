package llm

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// The model catalog exists because a model name belongs to exactly ONE provider.
// Typing a Claude id into a step pinned at an Ollama box is a 404 → a 4xx → no
// fallback → the pipeline dies hard. A picker that only ever offers a provider's
// own models makes that mistake unrepresentable.

// Model is one servable model on one provider.
type Model struct {
	ID            string `json:"id"`
	Label         string `json:"label,omitempty"`
	ContextLength int    `json:"context_length,omitempty"`
}

// ModelGroup is one provider's models, as the picker renders them.
type ModelGroup struct {
	ProviderID    string  `json:"provider_id"`
	ProviderLabel string  `json:"provider_label"`
	Role          string  `json:"role"`
	Models        []Model `json:"models"`
	// Error is set instead of failing the whole call: one unreachable box must not
	// empty the picker for every other provider.
	Error string `json:"error,omitempty"`
}

// modelCacheTTL keeps the picker snappy without going stale across a session. A
// model list changes when someone pulls a model, not by the minute.
const modelCacheTTL = 5 * time.Minute

type modelCacheEntry struct {
	groups []ModelGroup
	at     time.Time
}

var (
	modelCacheMu sync.Mutex
	modelCache   *modelCacheEntry
)

// Models lists every provider's models, grouped. refresh busts the cache.
func (r *Router) Models(ctx context.Context, refresh bool) []ModelGroup {
	if r == nil {
		return []ModelGroup{}
	}
	modelCacheMu.Lock()
	if !refresh && modelCache != nil && time.Since(modelCache.at) < modelCacheTTL {
		groups := modelCache.groups
		modelCacheMu.Unlock()
		return groups
	}
	modelCacheMu.Unlock()

	groups := make([]ModelGroup, len(r.providers))
	done := make(chan struct{}, len(r.providers))
	for i, p := range r.providers {
		go func(i int, p *Provider) {
			g := ModelGroup{ProviderID: p.ID, ProviderLabel: p.Label, Role: p.Role, Models: []Model{}}
			models, err := p.listModels(ctx)
			if err != nil {
				g.Error = truncErr(err.Error())
			} else {
				g.Models = models
			}
			groups[i] = g
			done <- struct{}{}
		}(i, p)
	}
	for range r.providers {
		<-done
	}

	modelCacheMu.Lock()
	modelCache = &modelCacheEntry{groups: groups, at: time.Now()}
	modelCacheMu.Unlock()
	return groups
}

// listModels asks the endpoint what it serves. Anthropic without a key cannot be
// asked, so it answers with the tiers this project targets — an empty picker for
// the provider you are about to configure is worse than a short honest list.
func (p *Provider) listModels(ctx context.Context) ([]Model, error) {
	if p.Transport == transportAnthropic {
		if !p.HasKey {
			return anthropicTierModels(), nil
		}
		return p.listFromDataArray(ctx, trimSlash(anthropicBaseURL)+"/v1/models")
	}
	return p.listFromDataArray(ctx, trimSlash(p.BaseURL)+"/models")
}

// listFromDataArray reads the OpenAI-shaped `{"data":[…]}` list that Anthropic,
// OpenRouter, OpenAI and Ollama all serve.
func (p *Provider) listFromDataArray(ctx context.Context, url string) ([]Model, error) {
	var body struct {
		Data []struct {
			ID            string `json:"id"`
			Name          string `json:"name"`         // OpenRouter
			DisplayName   string `json:"display_name"` // Anthropic
			ContextLength int    `json:"context_length"`
		} `json:"data"`
	}
	if err := p.getJSON(ctx, url, &body); err != nil {
		return nil, err
	}
	out := make([]Model, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID == "" {
			continue
		}
		label := m.DisplayName
		if label == "" {
			label = m.Name
		}
		out = append(out, Model{ID: m.ID, Label: label, ContextLength: m.ContextLength})
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].ID) < strings.ToLower(out[j].ID) })
	return out, nil
}

// anthropicTierModels mirrors the tiers named in CLAUDE.md (triage → Haiku,
// breakdown → Sonnet, digest/draft → Opus). Used only when no key can list them.
func anthropicTierModels() []Model {
	return []Model{
		{ID: "claude-haiku-4-5-20251001", Label: "Claude Haiku 4.5"},
		{ID: "claude-sonnet-4-6", Label: "Claude Sonnet 4.6"},
		{ID: "claude-opus-4-8", Label: "Claude Opus 4.8"},
	}
}
