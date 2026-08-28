// Package ytdlp answers one question the proxy pool cannot: is the yt-dlp
// binary itself out of date? YouTube rotates its signature scheme every few
// weeks, and a stale binary then fails EVERY download on EVERY proxy with a
// 403 — a failure that reads exactly like an IP ban but is not one. Diagnosing
// it as "the residential proxy broke" costs an afternoon of swapping nodes, so
// staleness is detected and reported as its own condition.
package ytdlp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// StaleAfter is when a binary counts as stale with no release list to compare
// against. yt-dlp ships roughly monthly, so a month without an update is the
// point where "you are behind" stops being a guess.
const StaleAfter = 30 * 24 * time.Hour

// checkTTL bounds how often the release list is fetched. The answer changes
// weekly at most, and GitHub rate-limits unauthenticated callers.
const checkTTL = 6 * time.Hour

// releasesURL is a var so tests can point it at an httptest server.
var releasesURL = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest"

// versionRe matches yt-dlp's date-based version (2026.08.19), optionally with a
// nightly/dev suffix.
var versionRe = regexp.MustCompile(`^(\d{4})\.(\d{2})\.(\d{2})`)

// Info is the binary's version state, as served to the app.
type Info struct {
	Installed string `json:"installed"`  // e.g. "2026.08.19"; empty if the binary did not run
	Latest    string `json:"latest"`     // newest published release, "" when the check failed
	AgeDays   int    `json:"age_days"`   // days since the installed release date
	Stale     bool   `json:"stale"`      // a newer release exists, or no check + older than StaleAfter
	Error     string `json:"error"`      // why the check failed, if it did
	CheckedAt string `json:"checked_at"` // RFC3339 of the last check
}

// Advice is the one-line operator instruction for a stale binary, or "".
func (i Info) Advice() string {
	if !i.Stale {
		return ""
	}
	if i.Latest != "" && i.Installed != "" {
		return fmt.Sprintf("yt-dlp %s is out of date (latest %s) — run `yt-dlp -U`", i.Installed, i.Latest)
	}
	if i.Installed != "" {
		return fmt.Sprintf("yt-dlp %s is %d days old — run `yt-dlp -U`", i.Installed, i.AgeDays)
	}
	return "yt-dlp version unknown — run `yt-dlp -U`"
}

// Checker reports the installed yt-dlp version and whether a newer one exists.
// Results are cached: the binary is on disk and the release list is remote, so
// re-asking on every render would be a subprocess plus an API call per paint.
type Checker struct {
	bin string

	mu     sync.Mutex
	last   Info
	lastAt time.Time
}

func NewChecker(bin string) *Checker {
	if bin == "" {
		bin = "yt-dlp"
	}
	return &Checker{bin: bin}
}

// Get returns the cached Info, refreshing it when older than checkTTL.
func (c *Checker) Get(ctx context.Context) Info {
	c.mu.Lock()
	if !c.lastAt.IsZero() && time.Since(c.lastAt) < checkTTL {
		info := c.last
		c.mu.Unlock()
		return info
	}
	c.mu.Unlock()

	info := c.check(ctx)

	c.mu.Lock()
	c.last, c.lastAt = info, time.Now()
	c.mu.Unlock()
	return info
}

func (c *Checker) check(ctx context.Context) Info {
	info := Info{CheckedAt: time.Now().UTC().Format(time.RFC3339)}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	out, err := exec.CommandContext(ctx, c.bin, "--version").Output()
	if err != nil {
		info.Error = fmt.Sprintf("yt-dlp --version failed: %v", err)
		return info
	}
	// First line only: yt-dlp prints one, but a wrapper script that prints a
	// banner would otherwise make the whole blob the "version".
	info.Installed = strings.TrimSpace(strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0])

	released, ok := releaseDate(info.Installed)
	if ok {
		info.AgeDays = int(time.Since(released).Hours() / 24)
	}

	latest, err := latestRelease(ctx)
	if err != nil {
		// No release list: fall back to age. Being offline must not turn a
		// current binary into a reported problem, but a year-old one still is.
		info.Error = err.Error()
		info.Stale = ok && time.Since(released) > StaleAfter
		return info
	}
	info.Latest = latest
	info.Stale = latest != info.Installed
	return info
}

// releaseDate parses yt-dlp's date-based version into the day it shipped.
func releaseDate(version string) (time.Time, bool) {
	m := versionRe.FindStringSubmatch(strings.TrimSpace(version))
	if m == nil {
		return time.Time{}, false
	}
	t, err := time.Parse("2006.01.02", m[1]+"."+m[2]+"."+m[3])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func latestRelease(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releasesURL, nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := (&http.Client{Timeout: 8 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("release check unreachable: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("release check http %d", resp.StatusCode)
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&body); err != nil {
		return "", fmt.Errorf("decode release: %w", err)
	}
	if body.TagName == "" {
		return "", fmt.Errorf("release check returned no tag")
	}
	return body.TagName, nil
}
