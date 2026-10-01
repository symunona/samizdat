package worker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/proxypool"
	"github.com/symunona/samizdat/server/internal/ytdlp"
)

func TestYoutubeID(t *testing.T) {
	cases := map[string]string{
		"https://www.youtube.com/watch?v=PqtggjVAi8M":              "PqtggjVAi8M",
		"https://youtube.com/watch?v=PqtggjVAi8M&t=42s":            "PqtggjVAi8M",
		"https://youtu.be/PqtggjVAi8M":                             "PqtggjVAi8M",
		"https://youtu.be/PqtggjVAi8M?si=abc":                      "PqtggjVAi8M",
		"https://www.youtube.com/shorts/PqtggjVAi8M":               "PqtggjVAi8M",
		"https://www.youtube.com/embed/PqtggjVAi8M":                "PqtggjVAi8M",
		"https://m.youtube.com/watch?v=PqtggjVAi8M":                "PqtggjVAi8M",
		"https://music.youtube.com/watch?v=PqtggjVAi8M&list=RDxyz": "PqtggjVAi8M",
	}
	for in, want := range cases {
		got, ok := youtubeID(in)
		if !ok || got != want {
			t.Errorf("youtubeID(%q) = %q,%v want %q", in, got, ok, want)
		}
	}

	nonYT := []string{
		"https://example.com/watch?v=PqtggjVAi8M",
		"https://vimeo.com/12345",
		"https://www.youtube.com/results?search_query=foo",
	}
	for _, in := range nonYT {
		if _, ok := youtubeID(in); ok {
			t.Errorf("youtubeID(%q) = ok, want not-a-video", in)
		}
	}
}

func TestCanonicalizeYouTube(t *testing.T) {
	got, err := canonicalize("https://youtu.be/PqtggjVAi8M?si=tracking&t=10")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://www.youtube.com/watch?v=PqtggjVAi8M"
	if got != want {
		t.Errorf("canonicalize = %q, want %q", got, want)
	}
}

// A stale binary and a blocked IP produce the same symptom (403 / no media) and
// have opposite fixes. These guard the split: rotating proxies cannot fix the
// first, and updating the binary cannot fix the second.
func TestStaleBinaryFailureIsItsOwnClass(t *testing.T) {
	staleOutputs := []string{
		"ERROR: unable to download video data: HTTP Error 403: Forbidden",
		"WARNING: [youtube] nsig extraction failed: Some formats may be missing",
		"ERROR: [youtube] Signature extraction failed",
		"ERROR: [youtube] abc: Failed to extract any player response",
	}
	for _, out := range staleOutputs {
		if !isStaleBinaryFailure(out) {
			t.Errorf("isStaleBinaryFailure(%q) = false", out)
		}
		if isBotBlock(out) {
			t.Errorf("isBotBlock(%q) = true — must not be read as an IP ban", out)
		}
	}

	botOutputs := []string{
		"ERROR: [youtube] abc: Sign in to confirm you're not a bot",
		"Please confirm you are not a bot",
	}
	for _, out := range botOutputs {
		if !isBotBlock(out) {
			t.Errorf("isBotBlock(%q) = false", out)
		}
		if isStaleBinaryFailure(out) {
			t.Errorf("isStaleBinaryFailure(%q) = true — a bot wall IS worth another IP", out)
		}
	}
}

func TestClassifyNamesTheStaleVersion(t *testing.T) {
	out := "ERROR: unable to download video data: HTTP Error 403: Forbidden"
	ver := ytdlp.Info{Installed: "2026.06.09", Latest: "2026.08.19", Stale: true}
	msg := classifyYTDLPError(errors.New("exit status 1"), out, []string{"papi"}, ver).Error()
	for _, want := range []string{"out of date", "2026.06.09", "2026.08.19", "not a proxy problem"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q missing %q", msg, want)
		}
	}

	// Binary already current, same failure on two egresses: still not a proxy
	// problem, and it must not claim an update would help.
	msg = classifyYTDLPError(errors.New("exit status 1"), out, []string{"papi", "piri"}, ytdlp.Info{}).Error()
	if !strings.Contains(msg, "Not a proxy problem") || !strings.Contains(msg, "papi, piri") {
		t.Errorf("current-binary message %q should exonerate the proxies it was seen on", msg)
	}
	if strings.Contains(msg, "is out of date:") {
		t.Errorf("current-binary message %q must not assert staleness", msg)
	}

	// One egress proves nothing: a lone 403 can be that IP.
	msg = classifyYTDLPError(errors.New("exit status 1"), out, []string{"papi"}, ytdlp.Info{}).Error()
	if strings.Contains(msg, "Not a proxy problem") {
		t.Errorf("single-egress message %q must not exonerate the proxy", msg)
	}
}

// fakeYTDLP writes a yt-dlp stand-in that answers per proxy host: the script
// looks up the host's canned reply and exits 0 only for "ok".
func fakeYTDLP(t *testing.T, replies map[string]string) string {
	t.Helper()
	var b strings.Builder
	b.WriteString("#!/bin/sh\nfor a; do case \"$a\" in\n")
	for host, reply := range replies {
		if reply == "ok" {
			b.WriteString("*" + host + "*) echo ok; exit 0;;\n")
		} else {
			b.WriteString("*" + host + "*) echo '" + reply + "'; exit 1;;\n")
		}
	}
	b.WriteString("esac; done\nexit 1\n")
	path := filepath.Join(t.TempDir(), "yt-dlp")
	if err := os.WriteFile(path, []byte(b.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExecRotation(t *testing.T) {
	const (
		stale   = "ERROR: unable to download video data: HTTP Error 403: Forbidden"
		network = "ERROR: Unable to connect to proxy"
		private = "ERROR: [youtube] abc: Private video"
	)
	cases := []struct {
		name      string
		replies   map[string]string
		wantOK    bool
		wantProxy string   // egress the final attempt ran on
		wantTried []string // egresses that failed before it
		wantRun   bool     // recorded as the last run
	}{
		{"403 clears on another egress", map[string]string{"pa": stale, "pb": "ok"}, true, "pb", []string{"pa"}, true},
		{"same failure twice is the verdict", map[string]string{"pa": stale, "pb": stale, "pc": "ok"}, false, "pb", []string{"pa"}, true},
		{"network failure walks the pool", map[string]string{"pa": network, "pb": network, "pc": "ok"}, true, "pc", []string{"pa", "pb"}, true},
		{"private video stops at once", map[string]string{"pa": private, "pb": "ok"}, false, "", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			runs := ytdlp.NewRunLog(nil)
			yt := ytdlpEnv{
				cfg:  config.YTDLPSection{Path: fakeYTDLP(t, c.replies)},
				pool: proxypool.New([]string{"socks5h://pa:1080", "socks5h://pb:1080", "socks5h://pc:1080"}, nil),
				runs: runs,
			}
			_, err := (ytdlpRun{what: "audio", url: "https://www.youtube.com/watch?v=abc"}).exec(context.Background(), yt)
			if (err == nil) != c.wantOK {
				t.Fatalf("err = %v, want ok=%v", err, c.wantOK)
			}
			last := runs.Last()
			if !c.wantRun {
				if last != nil {
					t.Fatalf("recorded %+v; a definitive answer about the video is not a broken service", last)
				}
				return
			}
			if last == nil || last.OK != c.wantOK || last.Proxy != c.wantProxy || strings.Join(last.Tried, ",") != strings.Join(c.wantTried, ",") {
				t.Fatalf("last run = %+v, want ok=%v proxy=%s tried=%v", last, c.wantOK, c.wantProxy, c.wantTried)
			}
		})
	}
}

func TestClassifyBotBlockNamesTriedProxies(t *testing.T) {
	out := "ERROR: [youtube] abc: Sign in to confirm you're not a bot"
	msg := classifyYTDLPError(errors.New("exit status 1"), out, []string{"papi", "piri"}, ytdlp.Info{}).Error()
	for _, want := range []string{"Tried 2 proxies", "papi, piri", "share one address"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q missing %q", msg, want)
		}
	}
}
