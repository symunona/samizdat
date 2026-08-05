package pipeline

import (
	"encoding/json"
	"strings"
	"testing"
)

func configOf(t *testing.T, stepsJSON string, idx int) map[string]any {
	t.Helper()
	var steps []struct {
		Config map[string]any `json:"config"`
	}
	if err := json.Unmarshal([]byte(stepsJSON), &steps); err != nil {
		t.Fatalf("parse steps %q: %v", stepsJSON, err)
	}
	return steps[idx].Config
}

// TestRedactSecretsDropsAPIKey: the key is removed entirely, other config
// survives, and a kind with no secret field is untouched.
func TestRedactSecretsDropsAPIKey(t *testing.T) {
	in := `[{"kind":"llm_summarize","config":{"model":"m","api_key":"sk-123"}},{"kind":"extract_images","config":{"max_images":3}}]`
	out := RedactSecrets(in)
	if strings.Contains(out, "sk-123") {
		t.Fatalf("api key leaked: %s", out)
	}
	cfg := configOf(t, out, 0)
	if _, present := cfg["api_key"]; present {
		t.Fatalf("api_key still present: %s", out)
	}
	if cfg["model"] != "m" {
		t.Fatalf("model lost: %s", out)
	}
	if got := configOf(t, out, 1)["max_images"]; got != float64(3) {
		t.Fatalf("second step mangled: %s", out)
	}
}

// TestPreserveSecretsRestoresOmittedKey: a save that omits api_key (the UI never
// sees it) keeps the stored value; an explicitly sent value wins.
func TestPreserveSecretsRestoresOmittedKey(t *testing.T) {
	stored := `[{"kind":"llm_summarize","config":{"model":"old","api_key":"sk-123"}}]`

	merged := PreserveSecrets(`[{"kind":"llm_summarize","config":{"model":"new"}}]`, stored)
	cfg := configOf(t, merged, 0)
	if cfg["api_key"] != "sk-123" {
		t.Fatalf("api_key not preserved: %s", merged)
	}
	if cfg["model"] != "new" {
		t.Fatalf("edit lost: %s", merged)
	}

	rotated := PreserveSecrets(`[{"kind":"llm_summarize","config":{"api_key":"sk-new"}}]`, stored)
	if got := configOf(t, rotated, 0)["api_key"]; got != "sk-new" {
		t.Fatalf("explicit api_key overwritten: %s", rotated)
	}
}

// TestPreserveSecretsIgnoresKindChange: replacing a step with a different kind
// must not inherit the old step's key.
func TestPreserveSecretsIgnoresKindChange(t *testing.T) {
	merged := PreserveSecrets(
		`[{"kind":"extract_images","config":{}}]`,
		`[{"kind":"llm_summarize","config":{"api_key":"sk-123"}}]`,
	)
	if strings.Contains(merged, "sk-123") {
		t.Fatalf("key carried across a kind change: %s", merged)
	}
}
