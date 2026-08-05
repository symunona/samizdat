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

// TestStripCredentialsDropsLegacyKey: the key is removed entirely, other config
// survives, and a step carrying no credential is untouched.
func TestStripCredentialsDropsLegacyKey(t *testing.T) {
	in := `[{"kind":"llm_summarize","config":{"model":"m","api_key":"sk-123"}},{"kind":"extract_images","config":{"max_images":3}}]`
	out := StripCredentials(in)
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

// TestStripCredentialsCoversUndeclaredKeys: the strip is keyed on the key NAME,
// not on the step catalog, so a hand-added credential no kind declares is caught
// too — that is the case a catalog-driven redaction always missed.
func TestStripCredentialsCoversUndeclaredKeys(t *testing.T) {
	for _, key := range []string{"api_key", "apiKey", "auth_token", "password", "webhook_secret"} {
		in := `[{"kind":"extract_images","config":{"` + key + `":"leak-me","max_images":1}}]`
		out := StripCredentials(in)
		if strings.Contains(out, "leak-me") {
			t.Fatalf("%s survived the strip: %s", key, out)
		}
		if configOf(t, out, 0)["max_images"] != float64(1) {
			t.Fatalf("%s: sibling config lost: %s", key, out)
		}
	}
}

// TestStripCredentialsLeavesUnparseableAlone: a rewrite must never corrupt a row
// it cannot read.
func TestStripCredentialsLeavesUnparseableAlone(t *testing.T) {
	in := `not json at all`
	if out := StripCredentials(in); out != in {
		t.Fatalf("mangled unparseable steps: %s", out)
	}
}
