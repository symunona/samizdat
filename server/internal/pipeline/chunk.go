package pipeline

import (
	"strings"
	"unicode/utf8"
)

// runesPerToken is the fixed chars-per-token ratio EstimateTokens assumes.
// English prose is nearer 4, but a document is not always English prose: code,
// URLs and Hungarian all tokenize denser, and CJK denser still. 3 with the
// headroom ChunkBudget takes on top is the cheap way to be wrong in the safe
// direction — the expensive direction is invisible. A local Ollama that receives
// more tokens than its context holds does NOT return an error; it silently drops
// the front of the prompt and answers confidently about the rest.
const runesPerToken = 3

// ctxHeadroomNum/Den is the fraction of a context window a chunk may occupy
// before the prompt and the completion are subtracted: two thirds.
const (
	ctxHeadroomNum = 2
	ctxHeadroomDen = 3
)

// EstimateTokens approximates the token count of a string. Rune-based, never
// byte-based: a byte count over-reads multi-byte text by up to 4x.
func EstimateTokens(s string) int {
	n := utf8.RuneCountInString(s)
	return (n + runesPerToken - 1) / runesPerToken
}

// ChunkBudget returns how many runes of document may be handed to an endpoint
// with the given context window and completion cap, leaving room for the prompt
// template. Chunk size is derived, never configured: a knob for it would just be
// a second, staler copy of ctx_tokens.
func ChunkBudget(ctxTokens, maxTokens, promptTokens int) int {
	usable := ctxTokens*ctxHeadroomNum/ctxHeadroomDen - maxTokens - promptTokens
	if usable < 1 {
		return 0
	}
	return usable * runesPerToken
}

// Split cuts markdown into chunks of at most targetRunes runes each, preferring
// structural boundaries: headings first, then paragraphs, then sentences, and a
// hard rune cut only when a single sentence exceeds the budget. Adjacent chunks
// share the last overlapRunes runes of their predecessor so a point split across
// a boundary still has its subject in view.
//
// A document that already fits comes back as one chunk, unmodified — callers
// rely on that to keep the no-chunking path byte-identical to a plain call.
func Split(md string, targetRunes, overlapRunes int) []string {
	if targetRunes < 1 || utf8.RuneCountInString(md) <= targetRunes {
		return []string{md}
	}

	var atoms []atom
	for _, b := range splitBlocks(md) {
		for i, piece := range splitOversize(b.text, targetRunes) {
			// Only the first piece of a split block keeps the heading flag: the
			// remainder is the middle of a section, not the start of one.
			atoms = append(atoms, atom{text: piece, heading: b.heading && i == 0})
		}
	}

	var chunks []string
	var cur []string
	curLen := 0
	for _, a := range atoms {
		n := utf8.RuneCountInString(a.text)
		// Break when the atom would overflow, or when a new section starts and the
		// current chunk is already substantial — a section boundary is the best
		// place to cut, but not worth a nearly empty chunk.
		overflows := curLen > 0 && curLen+n > targetRunes
		sectionBreak := a.heading && curLen >= targetRunes/2
		if overflows || sectionBreak {
			chunks = append(chunks, strings.Join(cur, "\n\n"))
			cur, curLen = nil, 0
		}
		cur = append(cur, a.text)
		curLen += n + 2 // the "\n\n" the join will add
	}
	if len(cur) > 0 {
		chunks = append(chunks, strings.Join(cur, "\n\n"))
	}
	return withOverlap(chunks, overlapRunes)
}

// atom is one indivisible piece of the document, flagged when it opens a section.
type atom struct {
	text    string
	heading bool
}

// splitBlocks cuts markdown into blank-line separated blocks, starting a new one
// at every heading. A fenced code block stays whole regardless of the blank lines
// inside it — splitting one leaves both halves with an unbalanced fence, and a
// model handed an unterminated ``` treats the rest of the chunk as code.
func splitBlocks(md string) []atom {
	var blocks []atom
	var cur []string
	curHeading := false
	inFence := false

	flush := func() {
		if len(cur) == 0 {
			return
		}
		text := strings.TrimRight(strings.Join(cur, "\n"), " \t\n")
		if strings.TrimSpace(text) != "" {
			blocks = append(blocks, atom{text: text, heading: curHeading})
		}
		cur, curHeading = nil, false
	}

	for _, line := range strings.Split(md, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "```"):
			inFence = !inFence
		case inFence:
			// Blank lines and #-prefixed lines inside a fence are code, not structure.
		case trimmed == "":
			flush()
			continue
		case strings.HasPrefix(trimmed, "#"):
			flush()
			curHeading = true
		}
		cur = append(cur, line)
	}
	flush()
	return blocks
}

// splitOversize breaks a single block that exceeds the budget: by sentence, then
// by a hard rune cut for a sentence that is itself too long (a minified line, a
// data URI, a table row).
func splitOversize(s string, target int) []string {
	if utf8.RuneCountInString(s) <= target {
		return []string{s}
	}
	var out []string
	var cur strings.Builder
	curLen := 0
	appendPiece := func(piece string) {
		n := utf8.RuneCountInString(piece)
		if curLen > 0 && curLen+n > target {
			out = append(out, strings.TrimSpace(cur.String()))
			cur.Reset()
			curLen = 0
		}
		cur.WriteString(piece)
		curLen += n
	}
	for _, sentence := range splitSentences(s) {
		for _, piece := range hardCut(sentence, target) {
			appendPiece(piece)
		}
	}
	if strings.TrimSpace(cur.String()) != "" {
		out = append(out, strings.TrimSpace(cur.String()))
	}
	return out
}

// splitSentences cuts after each sentence terminator, keeping the terminator and
// its trailing space with the sentence it ends.
func splitSentences(s string) []string {
	locs := sentenceEnd.FindAllStringIndex(s, -1)
	if len(locs) == 0 {
		return []string{s}
	}
	var out []string
	prev := 0
	for _, loc := range locs {
		out = append(out, s[prev:loc[1]])
		prev = loc[1]
	}
	if prev < len(s) {
		out = append(out, s[prev:])
	}
	return out
}

// hardCut slices at exactly target runes. Rune-based so it can never split a
// multi-byte character into invalid UTF-8 — which is what the byte slices this
// replaces (`content[:12000]`) could do.
func hardCut(s string, target int) []string {
	if utf8.RuneCountInString(s) <= target {
		return []string{s}
	}
	runes := []rune(s)
	var out []string
	for len(runes) > target {
		out = append(out, string(runes[:target]))
		runes = runes[target:]
	}
	if len(runes) > 0 {
		out = append(out, string(runes))
	}
	return out
}

// withOverlap prefixes each chunk with the tail of the ORIGINAL previous chunk,
// so overlap can't compound down the document.
func withOverlap(chunks []string, overlap int) []string {
	if overlap < 1 || len(chunks) < 2 {
		return chunks
	}
	out := make([]string, len(chunks))
	out[0] = chunks[0]
	for i := 1; i < len(chunks); i++ {
		prev := []rune(chunks[i-1])
		if len(prev) > overlap {
			prev = prev[len(prev)-overlap:]
		}
		out[i] = "…" + string(prev) + "\n\n" + chunks[i]
	}
	return out
}
