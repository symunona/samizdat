package pipeline

import (
	"regexp"
	"strconv"
	"strings"
)

// fenceBlockRe matches a whole fenced code block (```…```), DOTALL so it spans
// lines. CompactForLLM never looks inside a match: a URL in a code sample is
// content the user pasted, not ConvertKit tracking noise.
var fenceBlockRe = regexp.MustCompile("(?s)```.*?```")

// imageRe matches Markdown image syntax with ANY target — http(s), a relative
// `/api/v1/media/<id>` route, anything. It exists only to *protect* images, never
// to rewrite them: pipeline steps inject hero images this way and llm_topics
// copies section bodies verbatim into vault-exported Highlights, so an image
// target must survive byte-for-byte.
var imageRe = regexp.MustCompile(`!\[[^\]]*\]\([^)\s]*\)`)

// linkRe matches an inline link with an http(s) target: `[text](url)`. It never
// matches image syntax because callers run it only after imageRe has replaced
// every `![...](...)` with a placeholder — by the time linkRe sees the line, no
// `![` sequence remains to be mistaken for a link's `[`.
var linkRe = regexp.MustCompile(`\[([^\[\]]*)\]\(https?://[^)\s]*\)`)

// bareURLRe matches a bare http(s) URL, stopping before Markdown structural
// characters (`)]}`, quotes) and whitespace. It deliberately does NOT exclude
// `.,;:!?` from the match body — a domain or query string legitimately contains
// them — so trailingPunctRe below peels sentence punctuation back off the far
// end of the match rather than the char class trying to guess it up front.
var bareURLRe = regexp.MustCompile(`https?://[^\s)\]}>"']+`)

// trailingPunctRe captures sentence punctuation stuck to the end of a matched
// bare URL, so removal can put it back: "see https://x.com." must lose the URL
// and keep the sentence's full stop, not swallow both.
var trailingPunctRe = regexp.MustCompile(`[.,;:!?]+$`)

// refDefRe matches a reference-style link *definition* line: `[ref]: http://…`.
// CompactForLLM leaves these (and the `[text][ref]` usages that point at them)
// completely alone — deliberately, not an oversight. A definition line appears
// once per unique reference regardless of how many times it's cited, so unlike
// the repeated inline `[text](tracking-url)` pattern this function exists for,
// reference style is not a source of the multiplied link-noise that pushed the
// James Clear newsletter into the chunking band. Rewriting it would also mean
// tracking `[text][ref]` usages against out-of-order definitions for no payoff.
var refDefRe = regexp.MustCompile(`^[ \t]{0,3}\[[^\]\n]+\]:\s*\S`)

var (
	multiSpaceRe       = regexp.MustCompile(`[ \t]{2,}`)
	spaceBeforePunctRe = regexp.MustCompile(`[ \t]+([,.;:!?])`)
)

// CompactForLLM strips link-noise from markdown before it is handed to an LLM:
// inline links collapse to their visible text, bare URLs are removed, and image
// syntax is left byte-for-byte untouched. It exists because a scraped newsletter
// can be up to 76% ConvertKit tracking URLs by rune count, and URLs tokenize far
// denser than prose (measured ~1.7 runes/token vs ~3 for prose) — dense enough
// that EstimateTokens' fixed runes/token ratio under-counts a link-heavy document
// by up to 1.76x and pushes it over chunk_above into the chunking path, which is
// where a small local model starts fabricating content. Compacting first keeps
// routing decisions honest.
func CompactForLLM(md string) string {
	var b strings.Builder
	last := 0
	for _, span := range fenceBlockRe.FindAllStringIndex(md, -1) {
		b.WriteString(compactSegment(md[last:span[0]]))
		b.WriteString(md[span[0]:span[1]]) // fence, including its contents, untouched
		last = span[1]
	}
	b.WriteString(compactSegment(md[last:]))
	return b.String()
}

// compactSegment runs CompactForLLM's rewrite over text known to be outside any
// fenced code block. Line-by-line: every construct this function touches (an
// image, an inline link, a bare URL, a reference definition) is single-line in
// practice, and staying line-scoped is what lets refDefRe bail out of a whole
// line cheaply instead of needing multi-line lookaround RE2 doesn't support.
func compactSegment(seg string) string {
	if seg == "" {
		return seg
	}
	lines := strings.Split(seg, "\n")
	for i, line := range lines {
		if refDefRe.MatchString(line) {
			continue // reference-style definition: left alone, see refDefRe doc
		}
		lines[i] = compactLine(line)
	}
	return strings.Join(lines, "\n")
}

// compactLine applies CompactForLLM's rewrite to one line. Images are swapped
// for null-byte placeholders before anything else runs and restored last, so
// linkRe/bareURLRe never see raw image syntax — including the wrapped case a
// clipper commonly emits, `[![alt](img)](tracking-url)`: with the image behind a
// placeholder that's an ordinary `[placeholder](url)` link to linkRe, which
// unwraps it to the placeholder alone, i.e. the image survives and the tracking
// wrapper around it is gone. Restoring afterward means the null bytes never have
// to survive punctuation cleanup unscathed.
func compactLine(line string) string {
	var images []string
	protected := imageRe.ReplaceAllStringFunc(line, func(m string) string {
		images = append(images, m)
		return "\x00" + strconv.Itoa(len(images)-1) + "\x00"
	})

	protected = linkRe.ReplaceAllString(protected, "$1")

	protected = bareURLRe.ReplaceAllStringFunc(protected, func(m string) string {
		return trailingPunctRe.FindString(m) // drop the URL, keep any sentence punctuation stuck to it
	})

	protected = cleanupWhitespace(protected)

	for i, img := range images {
		protected = strings.ReplaceAll(protected, "\x00"+strconv.Itoa(i)+"\x00", img)
	}
	return protected
}

// cleanupWhitespace repairs the spacing a removed link/URL leaves behind — a
// double space where text abutted it on both sides, a lone space stranded before
// trailing punctuation — without touching leading indentation, which is
// structural in Markdown (list nesting, blockquotes) and never where a URL was.
func cleanupWhitespace(line string) string {
	lead := 0
	for lead < len(line) && (line[lead] == ' ' || line[lead] == '\t') {
		lead++
	}
	rest := multiSpaceRe.ReplaceAllString(line[lead:], " ")
	rest = spaceBeforePunctRe.ReplaceAllString(rest, "$1")
	rest = strings.TrimRight(rest, " \t")
	if rest == "" {
		return "" // a line that was (or became) only whitespace collapses to truly empty
	}
	return line[:lead] + rest
}
