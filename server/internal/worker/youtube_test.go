package worker

import (
	"errors"
	"strings"
	"testing"

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

	// Binary already current: still not a proxy problem, and it must not claim
	// an update would help.
	msg = classifyYTDLPError(errors.New("exit status 1"), out, []string{"papi"}, ytdlp.Info{}).Error()
	if !strings.Contains(msg, "Not a proxy problem") {
		t.Errorf("current-binary message %q should still exonerate the proxy", msg)
	}
	if strings.Contains(msg, "is out of date:") {
		t.Errorf("current-binary message %q must not assert staleness", msg)
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
