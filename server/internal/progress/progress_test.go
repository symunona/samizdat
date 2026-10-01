package progress

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func decode(t *testing.T, raw string) State {
	t.Helper()
	var s State
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatalf("stored %q is not a State: %v", raw, err)
	}
	return s
}

func TestPhaseChangeRestartsSinceAndPercent(t *testing.T) {
	clock := time.Date(2026, 10, 1, 20, 0, 0, 0, time.UTC)
	var writes []string
	r := New("", func(s string) { writes = append(writes, s) })
	r.now = func() time.Time { return clock }

	r.Update(func(s *State) { s.Phase, s.Proxy = PhaseDownload, "pandora" })
	r.Percent(40)
	clock = clock.Add(time.Minute)
	r.Update(func(s *State) { s.Proxy = "fiona" }) // same phase: Since holds
	got := decode(t, writes[len(writes)-1])
	if got.Since != "2026-10-01T20:00:00Z" || got.Percent != 40 || got.Proxy != "fiona" {
		t.Fatalf("same-phase update = %+v, want since kept, percent kept", got)
	}

	r.Update(func(s *State) { s.Phase = PhaseConvert })
	got = decode(t, writes[len(writes)-1])
	if got.Since != "2026-10-01T20:01:00Z" || got.Percent != 0 || got.Proxy != "fiona" {
		t.Fatalf("phase change = %+v, want since restarted, percent cleared, proxy kept", got)
	}
}

func TestPercentIsThrottled(t *testing.T) {
	clock := time.Date(2026, 10, 1, 20, 0, 0, 0, time.UTC)
	writes := 0
	r := New("", func(string) { writes++ })
	r.now = func() time.Time { return clock }

	r.Update(func(s *State) { s.Phase = PhaseDownload })
	for p := 1.0; p <= 50; p++ {
		r.Percent(p)
	}
	if writes != 1 {
		t.Fatalf("%d writes for 50 progress lines inside the window, want 1", writes)
	}
	clock = clock.Add(percentEvery)
	r.Percent(51)
	if writes != 2 || decode(t, r.JSON()).Percent != 51 {
		t.Fatalf("writes=%d state=%s, want the percent written once the window passed", writes, r.JSON())
	}
}

func TestSeededFromStoredState(t *testing.T) {
	r := New(`{"phase":"llm","since":"2026-10-01T19:00:00Z","chunk":3,"chunks":12}`, nil)
	r.Update(func(s *State) { s.Chunk = 4 })
	got := decode(t, r.JSON())
	if got.Since != "2026-10-01T19:00:00Z" || got.Chunk != 4 || got.Chunks != 12 {
		t.Fatalf("next tick = %+v, want the phase clock carried over", got)
	}
}

func TestNilReporterIsANoOp(t *testing.T) {
	r := From(context.Background())
	r.Update(func(s *State) { s.Phase = PhaseLLM })
	r.Percent(10)
	if r.JSON() != "" {
		t.Fatalf("nil reporter stored %q", r.JSON())
	}
}
