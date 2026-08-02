package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{
			// The real body Anthropic returns on a spent balance — a 400, so only
			// the message distinguishes it from a malformed request.
			name: "anthropic credit exhaustion",
			err:  errors.New(`anthropic 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`),
			want: KindQuota,
		},
		{
			name: "openai insufficient quota",
			err:  errors.New(`openai_compat 429: {"error":{"code":"insufficient_quota"}}`),
			want: KindQuota,
		},
		{
			name: "bad key",
			err:  errors.New(`anthropic 401: {"error":{"type":"authentication_error","message":"invalid x-api-key"}}`),
			want: KindAuth,
		},
		{
			name: "ollama down",
			err:  transportErr(fmt.Errorf("openai_compat request: dial tcp 127.0.0.1:11434: connect: connection refused")),
			want: KindTransport,
		},
		{
			name: "server error is transport (falls through the chain)",
			err:  transportErr(errors.New("anthropic 529: overloaded_error")),
			want: KindTransport,
		},
		{
			name: "plain api error",
			err:  errors.New(`anthropic 400: {"error":{"message":"max_tokens is too large"}}`),
			want: KindAPI,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classify(tc.err); got != tc.want {
				t.Fatalf("classify(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}

func TestRecordAndSnapshot(t *testing.T) {
	resetHealth()

	Record("anthropic", "", nil)
	Record("anthropic", "", errors.New(`anthropic 400: {"error":{"message":"Your credit balance is too low"}}`))
	Record("openai_compat", "http://ollama:11434/v1/", nil)

	snap := Snapshot()
	if len(snap) != 2 {
		t.Fatalf("want 2 providers, got %d (%+v)", len(snap), snap)
	}
	byKey := map[string]ProviderHealth{}
	for _, h := range snap {
		byKey[h.Key] = h
	}

	ant := byKey["anthropic"]
	if ant.Calls != 2 || ant.Errors != 1 {
		t.Fatalf("anthropic counters = %d calls / %d errors, want 2/1", ant.Calls, ant.Errors)
	}
	if ant.LastErrorKind != KindQuota {
		t.Fatalf("anthropic last kind = %q, want %q", ant.LastErrorKind, KindQuota)
	}
	if !ant.LastErrorAt.After(ant.LastOKAt) && !ant.LastErrorAt.Equal(ant.LastOKAt) {
		t.Fatalf("error timestamp should not predate the earlier success")
	}
	// The trailing slash must not mint a second identity for the same box.
	if _, ok := byKey["openai_compat@http://ollama:11434/v1"]; !ok {
		t.Fatalf("openai_compat key not normalized: %+v", byKey)
	}
}

func TestRestoreKeepsFresherMemory(t *testing.T) {
	resetHealth()
	Record("anthropic", "", nil)
	live := Snapshot()[0]

	blob, err := json.Marshal([]ProviderHealth{{
		Key: "anthropic", Provider: "anthropic", Calls: 99, LastError: "stale",
	}, {
		Key: "openai_compat@http://x/v1", Provider: "openai_compat", BaseURL: "http://x/v1", Calls: 3,
	}})
	if err != nil {
		t.Fatal(err)
	}
	var rows []ProviderHealth
	if err := json.Unmarshal(blob, &rows); err != nil {
		t.Fatal(err)
	}
	Restore(rows)

	snap := Snapshot()
	if len(snap) != 2 {
		t.Fatalf("want 2 providers after restore, got %d", len(snap))
	}
	for _, h := range snap {
		if h.Key == "anthropic" && h.Calls != live.Calls {
			t.Fatalf("restore clobbered live row: calls = %d, want %d", h.Calls, live.Calls)
		}
	}
}

// resetHealth clears the package registry between tests.
func resetHealth() {
	healthMu.Lock()
	healthByID = map[string]*ProviderHealth{}
	persist = nil
	healthMu.Unlock()
}
