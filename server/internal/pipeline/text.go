package pipeline

import (
	"regexp"
	"strings"
)

var markdownEmphasis = regexp.MustCompile(`[*_` + "`" + `]+`)

// normalizeTitle lowercases and strips markdown emphasis + surrounding punctuation
// so a body line can be compared against a document title for echo detection.
func normalizeTitle(s string) string {
	s = markdownEmphasis.ReplaceAllString(s, "")
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.Trim(s, " .:!?—-#")
}

// StripLeadingTitle removes a redundant title line from the top of a body:
// either a markdown heading (`# …`) or a first line that echoes the document
// title. Callers that carry the title in a separate field (Highlight.Title, or
// the scraped Document.title rendered as an injected `#doc-title` / vault `# H1`)
// would otherwise show a double title. Returns the body unchanged when the first
// content line isn't a title.
func StripLeadingTitle(body, docTitle string) string {
	trimmed := strings.TrimLeft(body, "\n \t")
	nl := strings.IndexByte(trimmed, '\n')
	first := trimmed
	rest := ""
	if nl >= 0 {
		first = trimmed[:nl]
		rest = trimmed[nl+1:]
	}
	firstTrim := strings.TrimSpace(first)

	isHeading := strings.HasPrefix(firstTrim, "#")
	echoesTitle := docTitle != "" && normalizeTitle(firstTrim) == normalizeTitle(docTitle)
	if !isHeading && !echoesTitle {
		return body
	}
	return strings.TrimLeft(rest, "\n \t")
}

var sentenceEnd = regexp.MustCompile(`[.!?](\s|$)`)

// firstSentenceTitle derives a Highlight title from a body: the first sentence,
// capped at maxWords words, with markdown emphasis stripped. Deterministic so a
// title can't drift even if the LLM ignores the prompt.
func firstSentenceTitle(body string, maxWords int) string {
	s := strings.TrimSpace(markdownEmphasis.ReplaceAllString(body, ""))
	// First line, then first sentence within it.
	if nl := strings.IndexByte(s, '\n'); nl >= 0 {
		s = s[:nl]
	}
	if loc := sentenceEnd.FindStringIndex(s); loc != nil {
		s = s[:loc[0]]
	}
	fields := strings.Fields(s)
	if len(fields) > maxWords {
		fields = fields[:maxWords]
	}
	return strings.TrimSpace(strings.Join(fields, " "))
}
