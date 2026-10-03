package digest

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

var (
	bulletRe    = regexp.MustCompile(`^\s*(?:[-*•]|\d+[.)])\s+`)
	imageLineRe = regexp.MustCompile(`^!\[[^\]]*\]\([^)]*\)$`)
	// fieldRe is a bullet that opens on an emphasized Who/What/When/Where/Why/How
	// label — `*What*: …`, `**Why**: …`, `*How* …`, `*When/Where*: …` — and
	// captures the label's first word and the text after it.
	fieldRe = regexp.MustCompile(`(?i)^(?:\*\*|\*|_)(who|what|when|where|why|how)(?:\s*/\s*(?:who|what|when|where|why|how))*:?(?:\*\*|\*|_):?\s*(.*)$`)
)

// fieldRunes bounds each field a whole-Highlight line carries: What and Why run
// ~110 runes at the median and ~190 at p90, so 200 keeps nearly all of them
// whole while one Highlight still cannot eat the budget.
const fieldRunes = 200

// bulletLines returns the body line indexes that are list items.
func bulletLines(body string) []int {
	var out []int
	for i, line := range strings.Split(body, "\n") {
		if bulletRe.MatchString(line) {
			out = append(out, i)
		}
	}
	return out
}

// BulletText is the stored text a Ref shows: body line `bullet` without its list
// marker, or the whole body for -1 (and for an index the body no longer has — a
// Highlight edited after the issue was written).
func BulletText(body string, bullet int) string {
	lines := strings.Split(body, "\n")
	if bullet < 0 || bullet >= len(lines) {
		return strings.TrimSpace(body)
	}
	return strings.TrimSpace(bulletRe.ReplaceAllString(lines[bullet], ""))
}

// Flatten is a whole Highlight body on one line — a prompt line, a vault list
// item: images dropped, list markers stripped, lines joined.
func Flatten(body string) string {
	var parts []string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(bulletRe.ReplaceAllString(line, ""))
		if line == "" || imageLineRe.MatchString(line) {
			continue
		}
		parts = append(parts, line)
	}
	return strings.Join(parts, " ")
}

// candidate is one numbered line the model may cite.
type candidate struct {
	key  string // "17.2" = Highlight 17, body line 2; "31" = all of Highlight 31
	ref  Ref
	feed string // the Feed's id: what capRefs spreads a topic's refs across
	line string
}

// buildCandidates numbers the Highlights in the order given (newest first) and
// cuts each into the lines a topic can point at. A Highlight that is a list of
// several things becomes one candidate per bullet — a summary is seven bullets
// about seven things. Anything else is one candidate, and that includes a
// Highlight whose bullets are the Who/What/When/Why/How fields of ONE thing: a
// lone "*When*: January 2025" means nothing on its own line, and splitting them
// turned 119 Highlights into 309 lines that each repeated the head.
//
// Field-style is read from the body's shape, not from the Highlight's kind: the
// kinds that use it today (tool, local_model, …) are one step's prompt, and the
// same step's summary is a real list.
//
// The model sees numbers, never UUIDs: a small local model mangles a UUID.
func buildCandidates(rows []store.ListDigestCandidatesRow) []candidate {
	var out []candidate
	for i, h := range rows {
		n := strconv.Itoa(i + 1)
		whole := candidate{key: n, ref: Ref{HighlightID: h.ID, Bullet: -1}, feed: h.FeedID}
		head := store.FeedTitle(h.FeedTitle, h.FeedUrl) + " · " + h.Title + " — "
		// Link targets are noise to the model and most of a newsletter's bulk; the
		// stored body, which is what a reader is shown, keeps them.
		body := pipeline.CompactForLLM(h.Body)
		bullets := bulletLines(body)
		if len(bullets) < 2 || isFieldList(body, bullets) {
			if text := wholeText(body, bullets); text != "" {
				whole.line = "[" + n + "] " + head + text
				out = append(out, whole)
			}
			continue
		}
		for _, b := range bullets {
			key := n + "." + strconv.Itoa(b)
			out = append(out, candidate{
				key:  key,
				ref:  Ref{HighlightID: h.ID, Bullet: b},
				feed: h.FeedID,
				line: "[" + key + "] " + head + BulletText(body, b),
			})
		}
	}
	return out
}

// isFieldList reports whether at least two of the bullets are labelled fields:
// one thing described, not several things listed.
func isFieldList(body string, bullets []int) bool {
	fields := 0
	for _, b := range bullets {
		if fieldRe.MatchString(BulletText(body, b)) {
			fields++
		}
	}
	return fields >= 2
}

// wholeText is the text of a one-candidate Highlight. A field list sends its What
// and Why, each clipped to fieldRunes — the title already names the thing, and
// Who/When/How are the fields a reader opens the Highlight for. Without either it
// is flattened like any other body, clipped to the same total.
func wholeText(body string, bullets []int) string {
	if len(bullets) < 2 {
		return Flatten(body)
	}
	var parts []string
	for _, want := range []string{"What", "Why"} {
		for _, b := range bullets {
			if m := fieldRe.FindStringSubmatch(BulletText(body, b)); m != nil && strings.EqualFold(m[1], want) {
				parts = append(parts, want+": "+clip(m[2], fieldRunes))
				break
			}
		}
	}
	if len(parts) == 0 {
		return clip(Flatten(body), 2*fieldRunes)
	}
	return strings.Join(parts, " ")
}

// clip cuts s to at most n runes, at a word boundary, marking the cut.
func clip(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	cut := string(r[:n-1])
	if i := strings.LastIndexByte(cut, ' '); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,;:") + "…"
}

// clamp keeps the leading (newest) candidates that fit budgetRunes and reports
// whether anything was left out.
func clamp(cands []candidate, budgetRunes int) ([]candidate, bool) {
	used := 0
	for i, c := range cands {
		used += utf8.RuneCountInString(c.line) + 1 // the newline joining it
		if used > budgetRunes {
			return cands[:i], true
		}
	}
	return cands, false
}

// sentRef is a Ref the model may cite, with the Feed it came from.
type sentRef struct {
	Ref
	feed string
}

// refIndex maps what the model may write back to what it means.
type refIndex map[string]sentRef

// indexRefs covers exactly the candidates that were sent. A bare Highlight
// number also resolves when only its bullets were listed: the model saw that
// Highlight, and citing all of it is a ref the server can honor.
func indexRefs(sent []candidate) refIndex {
	idx := refIndex{}
	for _, c := range sent {
		idx[c.key] = sentRef{c.ref, c.feed}
	}
	for _, c := range sent {
		n, _, _ := strings.Cut(c.key, ".")
		if _, ok := idx[n]; !ok {
			idx[n] = sentRef{Ref{HighlightID: c.ref.HighlightID, Bullet: -1}, c.feed}
		}
	}
	return idx
}
