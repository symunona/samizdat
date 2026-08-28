package proxypool

import (
	"context"
	"testing"
)

// mark forces an entry healthy without a network probe.
func mark(p *Pool, proxyURL string, ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state[proxyURL].OK = ok
}

func TestNewDropsBlanksAndDuplicates(t *testing.T) {
	p := New([]string{" a ", "", "a", "b", "   "}, nil)
	if got := len(p.list); got != 2 {
		t.Fatalf("list = %v, want [a b]", p.list)
	}
	if p.list[0] != "a" || p.list[1] != "b" {
		t.Fatalf("list = %v, want [a b]", p.list)
	}
}

func TestUnconfigured(t *testing.T) {
	p := New(nil, nil)
	if p.Configured() {
		t.Fatal("empty pool reports configured")
	}
	if p.Current() != "" {
		t.Fatalf("Current() = %q, want empty", p.Current())
	}
	if got := p.Attempts(); got != nil {
		t.Fatalf("Attempts() = %v, want nil (caller runs direct)", got)
	}
	if got := p.Statuses(); len(got) != 0 {
		t.Fatalf("Statuses() = %v, want empty", got)
	}
}

// An unprobed pool must still be usable: a probe has not run yet, and refusing
// to try is worse than trying.
func TestCurrentFallsBackToFirstWhenNothingHealthy(t *testing.T) {
	p := New([]string{"a", "b"}, nil)
	if got := p.Current(); got != "a" {
		t.Fatalf("Current() = %q, want a", got)
	}
}

func TestCurrentIsStickyWhileHealthy(t *testing.T) {
	p := New([]string{"a", "b"}, nil)
	mark(p, "a", true)
	mark(p, "b", true)
	p.mu.Lock()
	p.active = "b"
	p.mu.Unlock()
	// "a" is healthy and earlier, but the active entry is fine — don't flap.
	if got := p.Current(); got != "b" {
		t.Fatalf("Current() = %q, want b (sticky)", got)
	}
}

func TestMarkFailedRotates(t *testing.T) {
	p := New([]string{"a", "b", "c"}, nil)
	mark(p, "a", true)
	mark(p, "b", true)
	mark(p, "c", true)
	p.mu.Lock()
	p.active = "a"
	p.mu.Unlock()

	p.MarkFailed("a", "youtube bot check")
	if got := p.Current(); got != "b" {
		t.Fatalf("Current() after MarkFailed(a) = %q, want b", got)
	}
	st := p.Statuses()
	if st[0].OK || st[0].Error != "youtube bot check" {
		t.Fatalf("a status = %+v, want ok=false with reason", st[0])
	}
	if !st[1].Active {
		t.Fatalf("b should be active: %+v", st)
	}
}

func TestMarkFailedUnknownProxyIsNoop(t *testing.T) {
	p := New([]string{"a"}, nil)
	p.MarkFailed("zzz", "boom") // must not panic
	if got := p.Current(); got != "a" {
		t.Fatalf("Current() = %q, want a", got)
	}
}

// Attempts orders current → other healthy → unhealthy: a stale probe must never
// take the whole pool out of service.
func TestAttemptsOrder(t *testing.T) {
	p := New([]string{"a", "b", "c", "d"}, nil)
	mark(p, "b", true)
	mark(p, "d", true)
	p.mu.Lock()
	p.active = "d"
	p.mu.Unlock()

	got := p.Attempts()
	want := []string{"d", "b", "a", "c"}
	if len(got) != len(want) {
		t.Fatalf("Attempts() = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Attempts() = %v, want %v", got, want)
		}
	}
}

func TestLabel(t *testing.T) {
	cases := map[string]string{
		"socks5h://piri.tail7f475e.ts.net:1080": "piri",
		"socks5://100.99.11.40:1080":            "100.99.11.40:1080",
		"http://proxy.example.com:8080":         "proxy",
		"socks5h://localhost:1080":              "localhost",
		"not a url":                             "not a url",
	}
	for in, want := range cases {
		if got := Label(in); got != want {
			t.Errorf("Label(%q) = %q, want %q", in, got, want)
		}
	}
}

// Probing an http:// proxy with a SOCKS dialer would report a working proxy as
// dead, so the transport must follow the scheme.
func TestTransportForScheme(t *testing.T) {
	for _, s := range []string{"socks5h://h:1080", "socks5://h:1080", "http://h:8080", "https://h:8443"} {
		if _, err := Probe(context.Background(), "\x7f"+s); err == nil {
			t.Fatalf("expected parse failure for control char in %q", s)
		}
	}
	if _, err := Probe(context.Background(), "ftp://h:21"); err == nil {
		t.Fatal("expected unsupported scheme error")
	}
}

type memPersist map[string]string

func (m memPersist) Get(_ context.Context, k string) (string, error) { return m[k], nil }
func (m memPersist) Set(_ context.Context, k, v string) error        { m[k] = v; return nil }

func TestSeedFromPoolKey(t *testing.T) {
	mp := memPersist{LastOKKey: `{"b":"2026-08-27T10:00:00Z"}`}
	p := New([]string{"a", "b"}, mp)
	p.Seed(context.Background())
	if got := p.Statuses()[1].LastOkAt; got != "2026-08-27T10:00:00Z" {
		t.Fatalf("b last_ok_at = %q", got)
	}
	if got := p.Statuses()[0].LastOkAt; got != "" {
		t.Fatalf("a last_ok_at = %q, want empty", got)
	}
}

// The pre-pool scalar key belongs to the single proxy it was recorded for — the
// first entry — not to every node in the new list.
func TestSeedFromLegacyKey(t *testing.T) {
	mp := memPersist{LegacyLastOKKey: "2026-08-01T09:00:00Z"}
	p := New([]string{"a", "b"}, mp)
	p.Seed(context.Background())
	st := p.Statuses()
	if st[0].LastOkAt != "2026-08-01T09:00:00Z" || st[1].LastOkAt != "" {
		t.Fatalf("seed = %+v", st)
	}
}
