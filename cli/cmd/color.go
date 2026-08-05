package cmd

import (
	"os"
	"strings"
)

// Terminal color, kept to the four SGR codes this CLI actually needs. Padding is
// ALWAYS computed from the unpainted text (see renderProbeTable), so a color code
// can never shift a column — which is why the escapes live here and not inline.
const (
	sgrReset  = "\x1b[0m"
	sgrBold   = "1"
	sgrDim    = "2"
	sgrRed    = "31"
	sgrGreen  = "32"
	sgrYellow = "33"
)

// paint wraps s in an SGR sequence. An empty code (or an empty string) is a no-op,
// so callers can style conditionally without branching at every call site.
func paint(code, s string) string {
	if code == "" || s == "" {
		return s
	}
	return "\x1b[" + code + "m" + s + sgrReset
}

// resolveColor decides whether to emit escapes: `--color always|never` wins, then
// NO_COLOR (https://no-color.org) and a dumb TERM, then "is out a terminal at all"
// — piping `just check-llm > file` must not write escapes into it.
func resolveColor(mode string, out *os.File) bool {
	switch strings.ToLower(mode) {
	case "always":
		return true
	case "never":
		return false
	}
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		return false
	}
	fi, err := out.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}
