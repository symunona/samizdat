package pipeline

import "sort"

// FieldSpec describes one configurable key of a step kind: what the UI renders
// and what value the step falls back to when the key is absent from the step's
// config JSON.
type FieldSpec struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	// Type is one of: string | text | int | bool. "text" is a long/multiline string.
	Type    string `json:"type"`
	Default any    `json:"default,omitempty"`
	Help    string `json:"help,omitempty"`
}

// KindSpec is the self-description of a registered step kind.
type KindSpec struct {
	Kind        string      `json:"kind"`
	Label       string      `json:"label"`
	Description string      `json:"description"`
	Fields      []FieldSpec `json:"fields"`
}

// promptKey is the config key every LLM step reads its template from.
const promptKey = "prompt"

type registration struct {
	spec    KindSpec
	handler Handler
}

var registry = map[string]registration{}

// Register adds a step kind: its handler and the spec describing its config.
// One call site keeps the two from drifting. Call from init().
func Register(spec KindSpec, h Handler) {
	registry[spec.Kind] = registration{spec: spec, handler: h}
}

// Catalog returns every registered step spec, ordered by kind.
func Catalog() []KindSpec {
	specs := make([]KindSpec, 0, len(registry))
	for _, reg := range registry {
		specs = append(specs, reg.spec)
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].Kind < specs[j].Kind })
	return specs
}

// DefaultFor returns the catalog default for one config key, or nil when the
// kind or the key is unknown.
func DefaultFor(kind, key string) any {
	reg, ok := registry[kind]
	if !ok {
		return nil
	}
	for _, f := range reg.spec.Fields {
		if f.Key == key {
			return f.Default
		}
	}
	return nil
}

// defaultPrompt returns the kind's catalog prompt template. Steps use it when
// their config carries no prompt (a bare pipeline created by hand or by the UI).
func defaultPrompt(kind string) string {
	s, _ := DefaultFor(kind, promptKey).(string)
	return s
}
