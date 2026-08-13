package transcript

import (
	"strings"
	"unicode"
)

// Reflow turns raw caption cues into sentence-sized display segments.
//
// A cue is a TIMING atom: YouTube wraps auto-captions at display width, so a cue is
// ~35 chars cut mid-sentence ("this morning, there was the Michael" / "Jordan
// quote."). Rendering one block per cue gives thousands of stubs, breaks
// TextQuoteSelector anchors across the wraps, and feeds the LLM shredded prose.
//
// A sentence is the DISPLAY + scroll atom: cues are concatenated, re-cut at sentence
// boundaries, and re-timed from the cue each boundary fell in. Scroll-follow keeps
// working because every returned segment still carries its own start/end.
func Reflow(cues []Segment) []Segment {
	cues = splitSpeakers(cues)
	if len(cues) == 0 {
		return nil
	}

	// Concatenate into one text, remembering where each cue starts so a character
	// offset can be mapped back to a playback time.
	text := make([]rune, 0, 48*len(cues))
	starts := make([]int, len(cues)) // rune offset of each cue in the joined text
	for i, c := range cues {
		if i > 0 {
			text = append(text, ' ')
		}
		starts[i] = len(text)
		text = append(text, []rune(c.Text)...)
	}

	cuts := sentenceCuts(text, cues, starts)

	// A cut carries the paragraph flag of what FOLLOWS it, so it lands on the next
	// segment — pending until that segment is built.
	segs := make([]Segment, 0, len(cuts))
	prev, pending := 0, false
	for _, cut := range cuts {
		if seg, ok := makeSegment(text, prev, cut.end, cues, starts); ok {
			seg.NewPara = pending
			segs = append(segs, seg)
			pending = false
		}
		pending = pending || cut.newPara
		prev = cut.end
	}
	if seg, ok := makeSegment(text, prev, len(text), cues, starts); ok {
		seg.NewPara = pending
		segs = append(segs, seg)
	}
	if len(segs) > 0 {
		segs[0].NewPara = true
	}
	return segs
}

// cut is a sentence boundary: everything up to end belongs to the current segment,
// and newPara says the NEXT segment opens a display paragraph.
type cut struct {
	end     int
	newPara bool
}

const (
	// A sentence shorter than this is glued to the next one ("Yeah.", "Right.").
	minSentenceRunes = 40
	// Past these an ASR run-on is split at a clause boundary instead.
	maxSentenceRunes = 350
	maxSentenceMs    = 20_000
	// Silence long enough to read as a paragraph break.
	paraGapMs = 2500
	// A paragraph this long is broken up even without a gap or speaker change.
	maxParaRunes = 700
)

// sentenceCuts finds the boundaries of the joined text: sentence terminators, forced
// speaker changes, and clause splits inside run-ons.
func sentenceCuts(text []rune, cues []Segment, starts []int) []cut {
	// Cue index → forced boundary before it (speaker change).
	forced := map[int]bool{}
	for i, c := range cues {
		if c.NewPara && i > 0 {
			forced[starts[i]] = true
		}
	}

	var cuts []cut
	segStart, paraRunes := 0, 0
	for i := 0; i < len(text); i++ {
		end := 0
		switch {
		case forced[i] && i > segStart:
			end = i // boundary sits before the new speaker's first char
		case isSentenceEnd(text, i):
			end = i + 1
		default:
			continue
		}
		if end-segStart < minSentenceRunes && !forced[i] {
			continue // too short to stand alone — keep accumulating
		}
		newPara := forced[i] || paraRunes+(end-segStart) > maxParaRunes ||
			gapAt(end, cues, starts) > paraGapMs
		if newPara {
			paraRunes = 0
		} else {
			paraRunes += end - segStart
		}
		cuts = append(cuts, cut{end: end, newPara: newPara})
		segStart = end
	}
	return splitRunOns(text, cuts, cues, starts)
}

// splitRunOns breaks segments that punctuation never ended (ASR often drops periods
// for minutes at a time) at the nearest clause boundary past their midpoint.
func splitRunOns(text []rune, cuts []cut, cues []Segment, starts []int) []cut {
	out := make([]cut, 0, len(cuts))
	prev := 0
	// The trailing sentinel makes the tail (past the last cut) run-on-checked too.
	for _, c := range append(cuts[:len(cuts):len(cuts)], cut{end: len(text)}) {
		for c.end-prev > maxSentenceRunes || durationOf(prev, c.end, cues, starts) > maxSentenceMs {
			at := clauseBreak(text, prev, c.end)
			if at <= prev {
				break
			}
			out = append(out, cut{end: at})
			prev = at
		}
		if c.end < len(text) {
			out = append(out, c)
		}
		prev = c.end
	}
	return out
}

// conjunctions are the clause openers a run-on may be split before.
var conjunctions = []string{" and ", " but ", " so ", " because "}

// clauseBreak returns the best split point in [start,end): the first comma or
// coordinating conjunction past the midpoint, else the last word break before the
// length cap. 0 means "no usable break".
func clauseBreak(text []rune, start, end int) int {
	for i := start + (end-start)/2; i < end-1 && i-start <= maxSentenceRunes; i++ {
		if text[i] == ',' && text[i+1] == ' ' {
			return i + 2
		}
		for _, w := range conjunctions {
			if hasWordAt(text, i, w) {
				return i + len([]rune(w))
			}
		}
	}
	if end-start <= maxSentenceRunes {
		return 0
	}
	// No clause boundary in a very long run — cut at the last word break instead.
	for i := start + maxSentenceRunes; i > start; i-- {
		if text[i] == ' ' {
			return i + 1
		}
	}
	return 0
}

func hasWordAt(text []rune, i int, word string) bool {
	w := []rune(word)
	if i+len(w) > len(text) {
		return false
	}
	for j, r := range w {
		if unicode.ToLower(text[i+j]) != r {
			return false
		}
	}
	return true
}

// makeSegment builds one display segment from a rune range, trimming whitespace and
// re-deriving its timing from the cues the range spans.
func makeSegment(text []rune, from, to int, cues []Segment, starts []int) (Segment, bool) {
	for from < to && unicode.IsSpace(text[from]) {
		from++
	}
	for to > from && unicode.IsSpace(text[to-1]) {
		to--
	}
	if to <= from {
		return Segment{}, false
	}
	return Segment{
		StartMs: timeAt(from, cues, starts),
		EndMs:   timeAt(to-1, cues, starts),
		Text:    string(text[from:to]),
	}, true
}

// cueAt returns the index of the cue covering a rune offset in the joined text.
func cueAt(off int, starts []int) int {
	lo, hi := 0, len(starts)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if starts[mid] <= off {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo
}

// timeAt maps a rune offset to a playback time, interpolating inside the cue so two
// sentences sharing one cue do not share one timestamp.
func timeAt(off int, cues []Segment, starts []int) int64 {
	i := cueAt(off, starts)
	c := cues[i]
	n := len([]rune(c.Text))
	if n <= 0 || c.EndMs <= c.StartMs {
		return c.StartMs
	}
	rel := off - starts[i]
	if rel < 0 {
		rel = 0
	} else if rel > n {
		rel = n
	}
	return c.StartMs + int64(rel)*(c.EndMs-c.StartMs)/int64(n)
}

// durationOf is the playback span of a rune range.
func durationOf(from, to int, cues []Segment, starts []int) int64 {
	if to <= from {
		return 0
	}
	return timeAt(to-1, cues, starts) - timeAt(from, cues, starts)
}

// gapAt is the silence between the cue ending at a boundary and the one after it.
func gapAt(off int, cues []Segment, starts []int) int64 {
	i := cueAt(off-1, starts)
	if i+1 >= len(cues) {
		return 0
	}
	return cues[i+1].StartMs - cues[i].EndMs
}

// splitSpeakers expands cues on YouTube's ">>" speaker marker: the marker is stripped
// and the part after it becomes its own cue flagged NewPara, timed by char fraction.
// Reflow then treats those flags as forced boundaries.
func splitSpeakers(cues []Segment) []Segment {
	out := make([]Segment, 0, len(cues))
	for _, c := range cues {
		parts := strings.Split(c.Text, ">>")
		n := len([]rune(c.Text))
		off := 0
		for i, p := range parts {
			runes := len([]rune(p)) + 2 // the ">>" we split on
			txt := strings.TrimSpace(p)
			if txt == "" {
				off += runes
				continue
			}
			seg := Segment{StartMs: c.StartMs, EndMs: c.EndMs, Text: txt, NewPara: i > 0}
			if i > 0 && n > 0 && c.EndMs > c.StartMs {
				seg.StartMs = c.StartMs + int64(off)*(c.EndMs-c.StartMs)/int64(n)
			}
			out = append(out, seg)
			off += runes
		}
	}
	return out
}

// isSentenceEnd reports whether a sentence terminator sits at i: ".", "?", "!" or "…"
// (plus trailing quotes/brackets), followed by whitespace and an opening character —
// and not preceded by a known abbreviation or a decimal point.
func isSentenceEnd(text []rune, i int) bool {
	switch text[i] {
	case '.', '?', '!', '…':
	default:
		return false
	}
	j := i + 1
	for j < len(text) && strings.ContainsRune(`"'”’)]`, text[j]) {
		j++
	}
	if j >= len(text) || !unicode.IsSpace(text[j]) {
		return false
	}
	for j < len(text) && unicode.IsSpace(text[j]) {
		j++
	}
	if j >= len(text) {
		return false
	}
	next := text[j]
	if !unicode.IsUpper(next) && !unicode.IsDigit(next) && !strings.ContainsRune(`"'“‘([`, next) {
		return false
	}
	if text[i] == '.' && isAbbrevEnd(text, i) {
		return false
	}
	return true
}

// abbrevs are the period-carrying tokens common in speech transcripts; a period
// closing one of them is not a sentence end.
var abbrevs = map[string]bool{
	"mr": true, "mrs": true, "ms": true, "dr": true, "prof": true, "st": true,
	"jr": true, "sr": true, "vs": true, "etc": true, "e.g": true, "i.e": true,
	"a.m": true, "p.m": true, "u.s": true, "u.k": true, "inc": true, "no": true,
}

// isAbbrevEnd reports whether the period at i closes an abbreviation or a decimal.
func isAbbrevEnd(text []rune, i int) bool {
	if i+1 < len(text) && unicode.IsDigit(text[i+1]) {
		return true // 3.5
	}
	start := i
	for start > 0 && (unicode.IsLetter(text[start-1]) || text[start-1] == '.') {
		start--
	}
	word := strings.ToLower(strings.Trim(string(text[start:i]), "."))
	if word == "" {
		return false
	}
	if abbrevs[word] {
		return true
	}
	// A single letter with a period is an initial ("J. Smith"), not a sentence end.
	return len([]rune(word)) == 1
}
