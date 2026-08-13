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
	// NewPara marks a segment that opens a display paragraph (speaker change or a
	// silence gap). Set by Reflow; raw cues never carry it.
	NewPara bool `json:"new_para,omitempty"`
}

// tagRe strips VTT inline tags: <00:00:01.000>, <c>, </c>, <c.colorE5E5E5>, etc.
var tagRe = regexp.MustCompile(`<[^>]*>`)

// wsRe collapses runs of whitespace (incl. non-breaking space) to a single space.
var wsRe = regexp.MustCompile(`[\s\x{00a0}]+`)

// inlineTimeRe matches a VTT inline word timing, <00:00:01.000>. Their presence is
// what identifies YouTube's roll-up auto-captions (see ParseVTT).
var inlineTimeRe = regexp.MustCompile(`<\d{2}:\d{2}:\d{2}\.\d{3}>`)

// ParseVTT parses a WebVTT document into deduplicated, time-ordered cues.
//
// YouTube auto-captions are a ROLL-UP stream: every spoken line is emitted three
// times — a paint-on cue carrying inline word timings, a ~10ms "settle" cue holding
// the finished line, and again as the carried-over first line of the next paint-on
// cue. Joining a whole cue therefore yields A, A, "A B", B, "B C" … which is never
// exactly equal to its predecessor, so cue-level dedup drops nothing and the body
// comes out ~3x its real length.
//
// So in roll-up mode (detected by the inline timings) each LINE is a candidate and a
// line equal to the last emitted one is dropped — that kills both the settle cue and
// the carry-over. A window of one is deliberate: the only false drop is a line that
// genuinely repeats verbatim back-to-back.
func ParseVTT(data string) []Segment {
	// Normalize newlines; split into blocks separated by blank lines.
	data = strings.ReplaceAll(data, "\r\n", "\n")
	data = strings.ReplaceAll(data, "\r", "\n")
	blocks := strings.Split(data, "\n\n")
	rollup := inlineTimeRe.MatchString(data)

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

		// Roll-up: each line stands alone (carry-over lines are dropped below).
		// Otherwise the whole cue is one segment, as authored in manual subs.
		body := lines[timingIdx+1:]
		if !rollup {
			body = []string{strings.Join(body, " ")}
		}
		for _, raw := range body {
			text := cleanText(raw)
			if text == "" || text == lastText {
				continue
			}
			segs = append(segs, Segment{StartMs: start, EndMs: end, Text: text})
			lastText = text
		}
	}

	return segs
}

// DedupRollup repairs segments produced by the pre-fix cue-level parser, for rows
// whose .vtt files are no longer cached (pruned, or ingested before per-language
// subtitle files were kept). Joining a whole roll-up cue yields A, "A B", B, "B C" …
// so each line is recoverable by stripping the leading copy of the line before it.
// A no-op on clean transcripts: no sentence opens with the whole previous one.
func DedupRollup(segs []Segment) []Segment {
	out := make([]Segment, 0, len(segs))
	last := ""
	for _, s := range segs {
		text := s.Text
		if text == last {
			continue
		}
		if last != "" && strings.HasPrefix(text, last+" ") {
			text = strings.TrimSpace(text[len(last):])
		}
		if text == "" {
			continue
		}
		s.Text = text
		out = append(out, s)
		last = text
	}
	return out
}

// FlattenText joins segment texts into a plain-text body used as Document.markdown,
// so Pipeline/Highlight/Annotation machinery works on prose: sentences run together
// inside a paragraph, paragraphs separated by a blank line. Reflow marks the breaks.
func FlattenText(segs []Segment) string {
	var b strings.Builder
	for i, s := range segs {
		switch {
		case i == 0:
		case s.NewPara:
			b.WriteString("\n\n")
		default:
			b.WriteString(" ")
		}
		b.WriteString(s.Text)
	}
	return b.String()
}

func cleanText(s string) string {
	s = tagRe.ReplaceAllString(s, "")
	s = html.UnescapeString(s) // &amp; &#39; &nbsp; → real chars
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
