package pipeline

import "encoding/json"

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

// secretKeys lists the config keys a kind marks Secret — never sent to a client,
// never taken from one.
func secretKeys(kind string) []string {
	reg, ok := registry[kind]
	if !ok {
		return nil
	}
	var keys []string
	for _, f := range reg.spec.Fields {
		if f.Secret {
			keys = append(keys, f.Key)
		}
	}
	return keys
}

// RedactSecrets strips every Secret config key (api_key) from a steps JSON
// string, for responses. The key is removed entirely, not blanked, so a client
// round-trip can be told apart from a deliberate clear.
func RedactSecrets(stepsJSON string) string {
	steps, ok := decodeSteps(stepsJSON)
	if !ok {
		return stepsJSON
	}
	changed := false
	for _, step := range steps {
		keys := secretKeys(stepKind(step))
		if len(keys) == 0 {
			continue
		}
		cfg, ok := stepConfig(step)
		if !ok {
			continue
		}
		dropped := false
		for _, k := range keys {
			if _, present := cfg[k]; present {
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

// PreserveSecrets copies Secret config values from the stored steps into the
// incoming ones (matched by index + kind) whenever the incoming step omits them.
// The UI never sees an api_key, so without this a save would wipe it.
func PreserveSecrets(incomingJSON, storedJSON string) string {
	incoming, ok := decodeSteps(incomingJSON)
	if !ok {
		return incomingJSON
	}
	stored, ok := decodeSteps(storedJSON)
	if !ok {
		return incomingJSON
	}
	changed := false
	for i, step := range incoming {
		if i >= len(stored) {
			break
		}
		kind := stepKind(step)
		if kind == "" || kind != stepKind(stored[i]) {
			continue
		}
		keys := secretKeys(kind)
		if len(keys) == 0 {
			continue
		}
		cfg, ok := stepConfig(step)
		if !ok {
			continue
		}
		oldCfg, ok := stepConfig(stored[i])
		if !ok {
			continue
		}
		restored := false
		for _, k := range keys {
			if _, present := cfg[k]; present {
				continue
			}
			if v, had := oldCfg[k]; had {
				cfg[k] = v
				restored = true
			}
		}
		if restored && setStepConfig(step, cfg) {
			changed = true
		}
	}
	if !changed {
		return incomingJSON
	}
	return encodeSteps(incoming, incomingJSON)
}
