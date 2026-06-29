// Package transcript parses subtitle files (WebVTT) into time-anchored segments
// for video/podcast Documents. YouTube auto-captions are noisy — inline timing
// tags and rolling-duplicate cues — so the parser strips tags and dedups.
package transcript

import (
	"html"
	"regexp"
	"strconv"
	"strings"
)

// Segment is one time-anchored unit of a transcript.
type Segment struct {
	StartMs int64  `json:"start_ms"`
	EndMs   int64  `json:"end_ms"`
	Text    string `json:"text"`
}

// tagRe strips VTT inline tags: <00:00:01.000>, <c>, </c>, <c.colorE5E5E5>, etc.
var tagRe = regexp.MustCompile(`<[^>]*>`)

// wsRe collapses runs of whitespace (incl. non-breaking space) to a single space.
var wsRe = regexp.MustCompile(`[\s\x{00a0}]+`)

// ParseVTT parses a WebVTT document into deduplicated, time-ordered segments.
func ParseVTT(data string) []Segment {
	// Normalize newlines; split into blocks separated by blank lines.
	data = strings.ReplaceAll(data, "\r\n", "\n")
	data = strings.ReplaceAll(data, "\r", "\n")
	blocks := strings.Split(data, "\n\n")

	var segs []Segment
	var lastText string

	for _, block := range blocks {
		lines := strings.Split(strings.TrimSpace(block), "\n")
		if len(lines) == 0 {
			continue
		}

		// Find the cue-timing line ("00:00:00.000 --> 00:00:02.000 align:...").
		timingIdx := -1
		for i, ln := range lines {
			if strings.Contains(ln, "-->") {
				timingIdx = i
				break
			}
		}
		if timingIdx < 0 {
			continue // header (WEBVTT), NOTE, STYLE, or a stray block
		}

		start, end, ok := parseTiming(lines[timingIdx])
		if !ok {
			continue
		}

		// Everything after the timing line is the caption text.
		raw := strings.Join(lines[timingIdx+1:], " ")
		text := cleanText(raw)
		if text == "" {
			continue
		}
		// Rolling auto-captions repeat the previous cue verbatim — drop exact dups.
		if text == lastText {
			continue
		}

		segs = append(segs, Segment{StartMs: start, EndMs: end, Text: text})
		lastText = text
	}

	return segs
}

// FlattenText joins segment texts into a single plain-text body (one line each),
// used as the Document.markdown so Pipeline/Highlight/Annotation machinery works.
func FlattenText(segs []Segment) string {
	parts := make([]string, len(segs))
	for i, s := range segs {
		parts[i] = s.Text
	}
	return strings.Join(parts, "\n")
}

func cleanText(s string) string {
	s = tagRe.ReplaceAllString(s, "")
	s = html.UnescapeString(s)              // &amp; &#39; &nbsp; → real chars
	s = wsRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// parseTiming parses a cue line like "00:00:01.000 --> 00:00:03.500 align:start".
func parseTiming(line string) (start, end int64, ok bool) {
	fields := strings.Fields(line)
	if len(fields) < 3 || fields[1] != "-->" {
		return 0, 0, false
	}
	s, ok1 := parseTimestamp(fields[0])
	e, ok2 := parseTimestamp(fields[2])
	if !ok1 || !ok2 {
		return 0, 0, false
	}
	return s, e, true
}

// parseTimestamp parses "HH:MM:SS.mmm" or "MM:SS.mmm" into milliseconds.
func parseTimestamp(ts string) (int64, bool) {
	secPart := ts
	var ms int64
	if dot := strings.LastIndex(ts, "."); dot >= 0 {
		secPart = ts[:dot]
		frac := ts[dot+1:]
		for len(frac) < 3 {
			frac += "0"
		}
		v, err := strconv.Atoi(frac[:3])
		if err != nil {
			return 0, false
		}
		ms = int64(v)
	}
	parts := strings.Split(secPart, ":")
	var total int64
	for _, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil {
			return 0, false
		}
		total = total*60 + int64(v)
	}
	return total*1000 + ms, true
}
