// Package ctxmenu holds the reader's selection context menu: which actions the
// "…" next to the Annotate button offers, and the master prompt every AI action
// is composed with. It lives on the server (not on the device) so a template
// authored on the desktop is the same one the phone offers.
//
// Persisted as a JSON blob in server_settings, same shape of preference as
// langpref — one row, parsed defensively, defaults on junk.
package ctxmenu

import (
	"encoding/json"
	"strings"
)

// SettingKey is the server_settings key holding the JSON-encoded Prefs.
const SettingKey = "context_menu"

// Item kinds. `copy` and `web_search` resolve on the device; `translate` and
// `ask` go through POST /api/v1/llm/ask.
const (
	KindCopy      = "copy"
	KindWebSearch = "web_search"
	KindTranslate = "translate"
	KindAsk       = "ask"
)

// DefaultSearchTemplate is a URL carrying the same {{tokens}} an ask template does.
const DefaultSearchTemplate = "https://www.google.com/search?q={{selection}}"

// Prefs is the whole menu.
type Prefs struct {
	// MasterPrompt is the persona prepended (as the system message) to every
	// `ask`/`translate` call. Empty = none.
	MasterPrompt string `json:"master_prompt"`
	Items        []Item `json:"items"`
}

// Item is one row of the menu. Routing is a provider id + a model name and
// nothing else — an endpoint or a credential never lives here, same rule as a
// pipeline step.
type Item struct {
	ID      string `json:"id"` // client-minted uuid
	Kind    string `json:"kind"`
	Title   string `json:"title"`
	Enabled bool   `json:"enabled"`
	// Template is the prompt (ask) or the search URL (web_search). Unused by the
	// other kinds.
	Template string `json:"template,omitempty"`
	Lang     string `json:"lang,omitempty"`   // translate: target language
	Engine   string `json:"engine,omitempty"` // translate: "llm" | "browser"
	Model    string `json:"model,omitempty"`
	Provider string `json:"provider,omitempty"`
}

// Default is the menu a fresh install gets: the two device-local actions on, the
// two that spend tokens off but present, so the editor shows what it can do
// without anything having to be invented there.
func Default() Prefs {
	return Prefs{
		Items: []Item{
			{ID: "copy", Kind: KindCopy, Title: "Copy to clipboard", Enabled: true},
			{ID: "web_search", Kind: KindWebSearch, Title: "Web search", Enabled: true, Template: DefaultSearchTemplate},
			{ID: "translate", Kind: KindTranslate, Title: "Translate", Enabled: false, Lang: "en", Engine: "llm"},
			{ID: "explain", Kind: KindAsk, Title: "Explain simply", Enabled: false,
				Template: "Context: {{selection_wider_context}}\n\nIn layman's terms, explain the following part, super brief: {{selection}}"},
		},
	}
}

// Parse decodes a stored blob, falling back to Default on empty or malformed
// input. Items are always non-nil so the API emits a JSON array, never null (the
// app types it as Item[] and a null blanks the screen).
func Parse(raw string) Prefs {
	if strings.TrimSpace(raw) == "" {
		return Default()
	}
	var p Prefs
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		return Default()
	}
	if p.Items == nil {
		p.Items = []Item{}
	}
	return p.Normalize()
}

// Normalize drops rows that could never run (no id, unknown kind) and fills the
// per-kind blanks the editor may have left. A row the device cannot execute is
// worse than a missing one: it renders in the sheet and does nothing.
func (p Prefs) Normalize() Prefs {
	out := make([]Item, 0, len(p.Items))
	for _, it := range p.Items {
		it.ID = strings.TrimSpace(it.ID)
		if it.ID == "" || !knownKind(it.Kind) {
			continue
		}
		it.Title = strings.TrimSpace(it.Title)
		if it.Title == "" {
			it.Title = defaultTitle(it.Kind)
		}
		switch it.Kind {
		case KindWebSearch:
			if strings.TrimSpace(it.Template) == "" {
				it.Template = DefaultSearchTemplate
			}
		case KindTranslate:
			if strings.TrimSpace(it.Lang) == "" {
				it.Lang = "en"
			}
			if it.Engine != "browser" {
				it.Engine = "llm"
			}
		}
		out = append(out, it)
	}
	p.Items = out
	p.MasterPrompt = strings.TrimSpace(p.MasterPrompt)
	return p
}

func knownKind(k string) bool {
	switch k {
	case KindCopy, KindWebSearch, KindTranslate, KindAsk:
		return true
	}
	return false
}

func defaultTitle(kind string) string {
	switch kind {
	case KindCopy:
		return "Copy to clipboard"
	case KindWebSearch:
		return "Web search"
	case KindTranslate:
		return "Translate"
	}
	return "Ask"
}
