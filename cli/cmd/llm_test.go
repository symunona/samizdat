package cmd

import (
	"os"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

// ansiRe strips SGR sequences so a test can assert on what the user SEES.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;]*m`)

func visible(s string) string { return ansiRe.ReplaceAllString(s, "") }

// The three shapes the table must tell apart: a working box, a box that is down,
// and a provider that simply has no key (never contacted — not broken).
func probeFixture() []llmProbeResult {
	return []llmProbeResult{
		{
			ID: "100.111.210.47:11434", Role: "primary", Reachable: true,
			Auth: "ok", Credits: "n/a", Models: 5, LatencyMs: 346,
			BaseURL: "http://100.111.210.47:11434/v1",
		},
		{
			ID: "anthropic", Role: "fallback", Reachable: true,
			Auth: "ok", Credits: "ok", Models: 11, LatencyMs: 463,
			CreditsNote: "verified by 1-token ping",
		},
		{
			ID: "openrouter", Role: "available", Auth: "missing_key", Credits: "unknown",
			BaseURL: "https://openrouter.ai/api/v1",
		},
		{
			ID: "localhost:11434", Role: "available", Reachable: false,
			Auth: "unknown", Credits: "n/a", LatencyMs: 1,
			BaseURL: "http://localhost:11434/v1",
			Error:   `llm: transport failure: Get "http://localhost:11434/v1/models": dial tcp [::1]:11434: connect: connection refused`,
		},
	}
}

func TestProviderState(t *testing.T) {
	cases := []struct {
		name string
		in   llmProbeResult
		want int
	}{
		{"working", llmProbeResult{Reachable: true, Auth: "ok", Credits: "ok"}, stateOK},
		{"local box, no balance to have", llmProbeResult{Reachable: true, Auth: "ok", Credits: "n/a"}, stateOK},
		{"nothing listening", llmProbeResult{Reachable: false, Auth: "unknown"}, stateBad},
		{"bad key", llmProbeResult{Reachable: true, Auth: "bad_key"}, stateBad},
		{"out of credits", llmProbeResult{Reachable: true, Auth: "ok", Credits: "exhausted"}, stateBad},
		// Unconfigured is not broken: it was never contacted, so red would send the
		// user to fix a box that is probably fine.
		{"no key configured", llmProbeResult{Reachable: false, Auth: "missing_key"}, stateWarn},
	}
	for _, c := range cases {
		if got := providerState(c.in); got != c.want {
			t.Errorf("%s: providerState = %d, want %d", c.name, got, c.want)
		}
	}
}

// Without color the output must carry no escapes at all — this is what lands in a
// pipe, a log or a CI transcript.
func TestRenderProbeTablePlain(t *testing.T) {
	out := renderProbeTable(probeFixture(), false)
	if strings.Contains(out, "\x1b[") {
		t.Fatalf("color=false still emitted escapes:\n%s", out)
	}
	for _, want := range []string{"PROVIDER", "anthropic", "verified by 1-token ping", "5", "346ms"} {
		if !strings.Contains(out, want) {
			t.Errorf("table is missing %q:\n%s", want, out)
		}
	}
	// A row whose DETAIL is empty (it failed — the reason is on the next line) must
	// not pad out to the column and trail whitespace.
	for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if l != strings.TrimRight(l, " ") {
			t.Errorf("line has trailing padding: %q", l)
		}
	}
}

// Columns must line up. Every column left of DETAIL holds space-free text, so a
// header offset is a real cell boundary: the character there must start a cell and
// the one before it must be padding. Runs for both color modes — the colored table
// is measured after stripping escapes, which is the bug this guards.
func TestRenderProbeTableAligns(t *testing.T) {
	for _, color := range []bool{false, true} {
		lines := strings.Split(strings.TrimRight(visible(renderProbeTable(probeFixture(), color)), "\n"), "\n")
		header := lines[0]
		for _, col := range []string{"ROLE", "REACHABLE", "AUTH", "CREDITS", "MODELS", "LATENCY", "DETAIL"} {
			b := strings.Index(header, col)
			if b <= 0 {
				t.Fatalf("no %s column in header %q", col, header)
			}
			// Offsets are in RUNES, not bytes: the em dash a missing value renders as
			// is 3 bytes and one column, so byte offsets would report a false shift.
			at := utf8.RuneCountInString(header[:b])
			for _, l := range lines[1:] {
				if strings.HasPrefix(l, "    ! ") {
					continue // the error line is deliberately outside the grid
				}
				r := []rune(l)
				if len(r) <= at {
					continue // every remaining cell was empty and the padding was trimmed
				}
				if r[at] == ' ' || r[at-1] != ' ' {
					t.Errorf("color=%v: %s column (rune %d) is misaligned in %q", color, col, at, l)
				}
			}
		}
	}
}

// The error is a sentence, not a cell: it belongs on its own indented line under
// the row it explains, and must not be squeezed into DETAIL.
func TestRenderProbeTableBreaksErrorOntoItsOwnLine(t *testing.T) {
	out := renderProbeTable(probeFixture(), false)
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")

	var rowIdx = -1
	for i, l := range lines {
		if strings.HasPrefix(l, "localhost:11434") {
			rowIdx = i
		}
	}
	if rowIdx < 0 {
		t.Fatalf("no row for the dead box:\n%s", out)
	}
	if strings.Contains(lines[rowIdx], "connection refused") {
		t.Fatalf("the error was crammed into the row: %q", lines[rowIdx])
	}
	if rowIdx+1 >= len(lines) {
		t.Fatalf("no line after the failing row:\n%s", out)
	}
	errLine := lines[rowIdx+1]
	if !strings.HasPrefix(errLine, "    ! ") {
		t.Errorf("the error line is not indented under its row: %q", errLine)
	}
	if !strings.Contains(errLine, "connection refused") {
		t.Errorf("the error line does not carry the reason: %q", errLine)
	}
	// A healthy row must NOT get one.
	if strings.Count(out, "\n    ! ") != 1 {
		t.Errorf("want exactly one error line, got %d:\n%s", strings.Count(out, "\n    ! "), out)
	}
}

// The regression this whole layout exists to prevent: an SGR sequence must not be
// counted as width, or every colored row drifts out of alignment.
func TestRenderProbeTableColorsDoNotShiftColumns(t *testing.T) {
	plain := renderProbeTable(probeFixture(), false)
	colored := renderProbeTable(probeFixture(), true)

	if !strings.Contains(colored, "\x1b[") {
		t.Fatal("color=true emitted no escapes")
	}
	if visible(colored) != plain {
		t.Fatalf("stripping color does not reproduce the plain table:\n--- colored (stripped) ---\n%s\n--- plain ---\n%s",
			visible(colored), plain)
	}
}

// Green = usable, yellow = unconfigured, red = broken. Assert on the row's own
// name cell, which carries the verdict for the whole row.
func TestRenderProbeTablePaintsEachState(t *testing.T) {
	colored := renderProbeTable(probeFixture(), true)
	cases := []struct{ id, code, why string }{
		{"100.111.210.47:11434", sgrGreen, "a working primary"},
		{"anthropic", sgrGreen, "a working fallback"},
		{"openrouter", sgrYellow, "no key configured"},
		{"localhost:11434", sgrRed, "nothing listening"},
	}
	for _, c := range cases {
		want := "\x1b[" + c.code + ";" + sgrBold + "m" + c.id
		if !strings.Contains(colored, want) {
			t.Errorf("%s (%s) is not painted %s:\n%s", c.id, c.why, c.code, colored)
		}
	}
	// The failure reason is red too — it is the line the user acts on.
	if !strings.Contains(colored, "\x1b["+sgrRed+"m! ") {
		t.Errorf("the error line is not painted red:\n%s", colored)
	}
}

func TestResolveColor(t *testing.T) {
	// A pipe is not a terminal: `just check-llm > out.txt` must stay clean.
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close(); _ = w.Close() }()

	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "xterm")
	if resolveColor("auto", w) {
		t.Error("auto colorized a pipe")
	}
	if !resolveColor("always", w) {
		t.Error("--color=always did not colorize")
	}
	if resolveColor("never", w) {
		t.Error("--color=never still colorized")
	}

	t.Setenv("NO_COLOR", "1")
	if resolveColor("auto", w) {
		t.Error("NO_COLOR was ignored")
	}
	if !resolveColor("always", w) {
		t.Error("an explicit --color=always should still win over NO_COLOR")
	}
}

// The exit code answers one question: could a pipeline run right now? A keyless
// fallback is not a failure to report, but it cannot serve a call either — the
// regression this guards is treating "not broken" as "usable".
func TestChainUsable(t *testing.T) {
	ok := llmProbeResult{Role: "primary", Reachable: true, Auth: "ok", Credits: "ok"}
	dead := llmProbeResult{Role: "primary", Reachable: false, Auth: "unknown"}
	keyless := llmProbeResult{Role: "fallback", Auth: "missing_key"}
	spare := llmProbeResult{Role: "available", Reachable: true, Auth: "ok", Credits: "ok"}

	cases := []struct {
		name string
		in   []llmProbeResult
		want bool
	}{
		{"working primary", []llmProbeResult{ok}, true},
		{"dead primary, working fallback", []llmProbeResult{dead, {Role: "fallback", Reachable: true, Auth: "ok", Credits: "ok"}}, true},
		{"dead primary, keyless fallback", []llmProbeResult{dead, keyless}, false},
		{"nothing but a healthy available box", []llmProbeResult{dead, spare}, false},
		{"no providers at all", nil, false},
	}
	for _, c := range cases {
		if got := chainUsable(c.in); got != c.want {
			t.Errorf("%s: chainUsable = %v, want %v", c.name, got, c.want)
		}
	}
}
