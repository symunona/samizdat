package pipeline

import (
	"encoding/json"
	"regexp"
)

// stepMap is one {kind, config} object of the pipelines.steps array, kept as raw
// JSON so a rewrite preserves keys this server doesn't know about.
type stepMap = map[string]json.RawMessage

// decodeSteps parses a steps JSON array. ok is false for anything unparseable —
// every rewrite below then returns its input untouched rather than corrupting it.
func decodeSteps(stepsJSON string) ([]stepMap, bool) {
	var steps []stepMap
	if err := json.Unmarshal([]byte(stepsJSON), &steps); err != nil {
		return nil, false
	}
	return steps, true
}

// stepKind returns the step's kind, or "" when absent/malformed.
func stepKind(step stepMap) string {
	var kind string
	if err := json.Unmarshal(step["kind"], &kind); err != nil {
		return ""
	}
	return kind
}

// stepConfig returns the step's config object (empty when absent). ok is false
// when config is present but not an object.
func stepConfig(step stepMap) (map[string]json.RawMessage, bool) {
	cfg := map[string]json.RawMessage{}
	raw, ok := step["config"]
	if !ok {
		return cfg, true
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, false
	}
	return cfg, true
}

// setStepConfig writes cfg back onto the step.
func setStepConfig(step stepMap, cfg map[string]json.RawMessage) bool {
	enc, err := json.Marshal(cfg)
	if err != nil {
		return false
	}
	step["config"] = enc
	return true
}

// encodeSteps re-serializes the array, falling back to the original text.
func encodeSteps(steps []stepMap, fallback string) string {
	out, err := json.Marshal(steps)
	if err != nil {
		return fallback
	}
	return string(out)
}

// credentialKeyRe matches config keys that would be credentials. Credentials no
// longer belong in a pipeline row at all — the Router owns every endpoint and its
// key (design rule 5) — but rows written before that still carry an api_key, and
// an inert secret must still never reach a client.
var credentialKeyRe = regexp.MustCompile(`(?i)api[_-]?key|secret|token|password|passphrase`)

// StripCredentials removes every credential-looking config key from a steps JSON
// string, for responses. Keyed on the key NAME rather than on the step catalog,
// so it also covers a legacy or hand-added key no kind declares.
//
// There is deliberately no write-side counterpart: nothing reads these keys any
// more, so a save that drops one loses nothing the server would have used.
func StripCredentials(stepsJSON string) string {
	steps, ok := decodeSteps(stepsJSON)
	if !ok {
		return stepsJSON
	}
	changed := false
	for _, step := range steps {
		cfg, ok := stepConfig(step)
		if !ok {
			continue
		}
		dropped := false
		for k := range cfg {
			if credentialKeyRe.MatchString(k) {
				delete(cfg, k)
				dropped = true
			}
		}
		if dropped && setStepConfig(step, cfg) {
			changed = true
		}
	}
	if !changed {
		return stepsJSON
	}
	return encodeSteps(steps, stepsJSON)
}
