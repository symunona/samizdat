package ytdlp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReleaseDate(t *testing.T) {
	got, ok := releaseDate("2026.08.19")
	if !ok || got.Format("2006-01-02") != "2026-08-19" {
		t.Fatalf("releaseDate = %v %v", got, ok)
	}
	// Nightly builds carry a suffix; the date still parses.
	if _, ok := releaseDate("2026.08.19.232301"); !ok {
		t.Fatal("nightly version should parse")
	}
	if _, ok := releaseDate("not-a-version"); ok {
		t.Fatal("garbage should not parse")
	}
}

func TestAdvice(t *testing.T) {
	if got := (Info{}).Advice(); got != "" {
		t.Fatalf("current binary advice = %q, want empty", got)
	}
	i := Info{Installed: "2026.06.09", Latest: "2026.08.19", Stale: true}
	if got := i.Advice(); got != "yt-dlp 2026.06.09 is out of date (latest 2026.08.19) — run `yt-dlp -U`" {
		t.Fatalf("advice = %q", got)
	}
	// Offline: no Latest, so the age carries the message.
	i = Info{Installed: "2026.06.09", AgeDays: 79, Stale: true}
	if got := i.Advice(); got != "yt-dlp 2026.06.09 is 79 days old — run `yt-dlp -U`" {
		t.Fatalf("offline advice = %q", got)
	}
}

// A missing binary must report the failure, not a silent "current".
func TestCheckMissingBinary(t *testing.T) {
	c := NewChecker("definitely-not-a-real-binary-xyz")
	info := c.Get(context.Background())
	if info.Installed != "" || info.Error == "" || info.Stale {
		t.Fatalf("info = %+v, want empty version with an error and stale=false", info)
	}
}

// fakeYTDLP writes a stub binary that prints version as yt-dlp does.
func fakeYTDLP(t *testing.T, version string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "yt-dlp")
	script := "#!/bin/sh\necho " + version + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	return path
}

func serveLatest(t *testing.T, tag string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprintf(w, `{"tag_name":%q}`, tag)
	}))
	old := releasesURL
	releasesURL = srv.URL
	t.Cleanup(func() { releasesURL = old; srv.Close() })
}

func TestCheckComparesToLatest(t *testing.T) {
	serveLatest(t, "2026.08.19")
	info := NewChecker(fakeYTDLP(t, "2026.06.09")).check(context.Background())
	if info.Installed != "2026.06.09" {
		t.Fatalf("installed = %q", info.Installed)
	}
	if info.Latest != "2026.08.19" || !info.Stale {
		t.Fatalf("info = %+v, want latest set and stale", info)
	}
	if info.Advice() == "" {
		t.Fatal("a stale binary must carry advice")
	}
}

// Equal to latest is current, however old the release itself is — yt-dlp can go
// quiet for months and that is not the operator's problem to fix.
func TestCheckCurrentIsNotStale(t *testing.T) {
	serveLatest(t, "2026.06.09")
	info := NewChecker(fakeYTDLP(t, "2026.06.09")).check(context.Background())
	if info.Stale || info.Advice() != "" {
		t.Fatalf("info = %+v, want not stale", info)
	}
}

// Being offline must not turn a CURRENT binary into a reported problem, and must
// not invent a "latest" it never saw.
func TestOfflineFallsBackToAge(t *testing.T) {
	old := releasesURL
	releasesURL = "http://127.0.0.1:1/nope"
	defer func() { releasesURL = old }()

	fresh := NewChecker(fakeYTDLP(t, time.Now().UTC().Format("2006.01.02"))).check(context.Background())
	if fresh.Error == "" {
		t.Fatalf("offline check should record the error: %+v", fresh)
	}
	if fresh.Latest != "" {
		t.Fatalf("offline check must not invent a latest: %+v", fresh)
	}
	if fresh.Stale {
		t.Fatalf("today's build must not be stale while offline: %+v", fresh)
	}

	ancient := NewChecker(fakeYTDLP(t, "2024.01.01")).check(context.Background())
	if !ancient.Stale {
		t.Fatalf("a year-old build is stale even offline: %+v", ancient)
	}
}

// Get caches: a second call inside the TTL must not re-run the check.
func TestGetCaches(t *testing.T) {
	serveLatest(t, "2026.08.19")
	c := NewChecker(fakeYTDLP(t, "2026.08.19"))
	first := c.Get(context.Background())
	second := c.Get(context.Background())
	if first.CheckedAt != second.CheckedAt {
		t.Fatalf("Get re-checked inside the TTL: %q vs %q", first.CheckedAt, second.CheckedAt)
	}
}
