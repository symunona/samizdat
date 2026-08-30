package pipeline

import (
	"encoding/json"
	"fmt"
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

// StripCodeFence unwraps a body whose entire content sits inside a single ``` fence
// (the shape a plaintext email used to get: <pre> → ``` block). Only strips when the
// first non-blank line opens a fence AND a closing fence exists — a body that merely
// contains a code block is returned unchanged. Defensive: keeps an LLM step from
// treating the whole newsletter as one code literal.
func StripCodeFence(md string) string {
	trimmed := strings.TrimLeft(md, "\n \t")
	if !strings.HasPrefix(trimmed, "```") {
		return md
	}
	nl := strings.IndexByte(trimmed, '\n')
	if nl < 0 {
		return md
	}
	body := trimmed[nl+1:]
	close := strings.LastIndex(body, "```")
	if close < 0 {
		return md
	}
	return strings.TrimSpace(body[:close])
}

// UnwrapLLMReply strips a markdown code fence around a raw LLM reply (StripCodeFence)
// and reports whether what remains is a bare top-level JSON array rather than an
// object. A step whose documented schema is a single wrapper object (`{"highlights":
// [...]}`) uses the bare flag to fall back to reading the array directly — see
// DecodeLLMList. A step whose wrapper carries more than one field (llm_ai_newsletter)
// can't auto-decode into it and inspects the flag itself.
func UnwrapLLMReply(reply string) (unwrapped string, isBareArray bool) {
	unwrapped = StripCodeFence(strings.TrimSpace(reply))
	isBareArray = strings.HasPrefix(strings.TrimLeft(unwrapped, " \t\n\r"), "[")
	return unwrapped, isBareArray
}

// DecodeLLMList parses reply as the documented `{wrapperKey: [...]}` shape, but
// tolerates a bare top-level array too. Small local models (this project runs a 4B
// model on-box) routinely return complete, correctly-shaped JSON for the list itself
// while dropping the wrapper object the prompt asks for — the schema instruction in
// the prompt does not reliably stop it, so this is belt-and-braces rather than a
// second attempt at prompting. Fences are stripped first (UnwrapLLMReply), so a
// caller gets both tolerances in one call.
//
// A wrapper object missing wrapperKey decodes to a nil slice with no error — same as
// plain json.Unmarshal into a struct with an absent field, which is what every caller
// did before this was factored out. errPrefix names the calling step so a genuine
// parse failure (neither shape) reads exactly like that step's own error used to,
// raw reply included.
func DecodeLLMList[T any](reply, wrapperKey, errPrefix string) ([]T, error) {
	unwrapped, bare := UnwrapLLMReply(reply)
	if bare {
		var items []T
		if err := decodeFirstJSON(unwrapped, &items); err != nil {
			return nil, fmt.Errorf("%s: parse llm json: %w\nraw: %s", errPrefix, err, unwrapped)
		}
		return items, nil
	}
	var wrapper map[string]json.RawMessage
	if err := decodeFirstJSON(unwrapped, &wrapper); err != nil {
		return nil, fmt.Errorf("%s: parse llm json: %w\nraw: %s", errPrefix, err, unwrapped)
	}
	raw, ok := wrapper[wrapperKey]
	if !ok {
		return nil, nil
	}
	var items []T
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("%s: parse llm json: %w\nraw: %s", errPrefix, err, unwrapped)
	}
	return items, nil
}

// dedupeByBody drops items whose body normalizes identical to one already kept,
// keyed by body(items[i]). Needed only by the partition strategy (see
// llm_long.go): its chunks overlap on purpose, so a boundary idea keeps its
// context, but that overlap can hand the SAME verbatim idea/section to two
// independent per-chunk calls, each of which correctly extracts it once. Body
// text is the identity check because verbatim IS the contract these steps
// extract under: two genuine duplicates are byte-identical after trimming, and
// two different ideas essentially never coincide exactly. Order is preserved —
// first occurrence wins.
func dedupeByBody[T any](items []T, body func(T) string) []T {
	seen := make(map[string]bool, len(items))
	out := make([]T, 0, len(items))
	for _, it := range items {
		key := strings.TrimSpace(body(it))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, it)
	}
	return out
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

// decodeFirstJSON reads the FIRST complete JSON value in s and ignores whatever
// trails it. json.Unmarshal insists the whole string be that one value, which a
// small model breaks in a way that has nothing to do with the data: qwen3-sum
// opened the documented `{"highlights": ...}` wrapper, emitted a bare array
// instead, then closed the brace anyway — a perfectly good six-item array plus
// one stray `}`, rejected as `invalid character '}' after top-level value`.
// Trailing noise is a formatting slip, not a content failure; a value that never
// parses at all still errors.
func decodeFirstJSON(s string, dst any) error {
	//nolint:wrapcheck // every caller already prefixes "…: parse llm json:" and
	// appends the raw reply; wrapping here would just double that prefix.
	return json.NewDecoder(strings.NewReader(s)).Decode(dst)
}
