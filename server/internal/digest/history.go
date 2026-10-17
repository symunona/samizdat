package digest

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/pipeline"
	"github.com/symunona/samizdat/server/internal/store"
)

const (
	// maxHistory caps the earlier Highlights one topic is compared against.
	maxHistory = 12
	// maxHistoryRefs caps the earlier refs a Diff keeps.
	maxHistoryRefs = 3
)

var (
	wordRe = regexp.MustCompile(`\p{L}+`)
	// nameRe also keeps a version whole: "5.6" is one token, so it is not found
	// inside "15.6%".
	nameRe = regexp.MustCompile(`\p{L}+|\d+(?:\.\d+)*`)
	// historyStop are title words that name no family: every release is a "new
	// model", and matching on them alone pulls in unrelated Highlights.
	historyStop = map[string]bool{
		"the": true, "and": true, "for": true, "with": true, "new": true, "model": true, "models": true,
		"family": true, "release": true, "released": true, "launch": true, "launches": true, "update": true,
		"preview": true, "version": true,
	}
)

// historyTerms is what a title is matched on: its words of three letters or
// more, lowercased. Digits split words and are dropped, so a version number
// falls away and "Claude Opus 5.5" meets "Claude Opus 5" on claude + opus.
func historyTerms(title string) map[string]bool {
	terms := map[string]bool{}
	for _, w := range wordRe.FindAllString(strings.ToLower(title), -1) {
		if len([]rune(w)) >= 3 && !historyStop[w] {
			terms[w] = true
		}
	}
	return terms
}

// sameLine reports whether previous can be the release before title: a different
// name whose family words contain, or are contained in, the title's. "Claude
// Sonnet 5.5" against "Claude Opus 5" fails — each has a word the other lacks,
// which is what two tiers of one vendor look like. Haiku, told to compare within
// a tier, compared across them.
func sameLine(title, previous string) bool {
	if strings.EqualFold(strings.TrimSpace(title), strings.TrimSpace(previous)) {
		return false
	}
	a, b := historyTerms(title), historyTerms(previous)
	if len(a) == 0 || len(b) == 0 {
		return false
	}
	within := func(x, y map[string]bool) bool {
		for w := range x {
			if !y[w] {
				return false
			}
		}
		return true
	}
	return within(a, b) || within(b, a)
}

// names reports whether text mentions the release called name: every word and
// version of the name is a token of the text. "Gemini 4" is not named by a line
// about "Gemini 3.8 Flash".
func names(text, name string) bool {
	have := map[string]bool{}
	for _, w := range nameRe.FindAllString(strings.ToLower(text), -1) {
		have[w] = true
	}
	for _, w := range nameRe.FindAllString(strings.ToLower(name), -1) {
		if !historyStop[w] && !have[w] {
			return false
		}
	}
	return true
}

// pickHistory chooses the earlier Highlights a topic is compared against: those
// whose title shares a word with the topic's, most shared words first, then
// newest (the order rows arrive in), at most maxHistory.
//
// Titles only. A body match pulls in every Highlight that name-drops the family
// — most of the feed, for "Opus".
func pickHistory(topicTitle string, rows []store.ListDigestCandidatesRow) []store.ListDigestCandidatesRow {
	terms := historyTerms(topicTitle)
	type scored struct {
		row   store.ListDigestCandidatesRow
		score int
	}
	var hits []scored
	for _, h := range rows {
		score := 0
		for w := range historyTerms(h.Title) {
			if terms[w] {
				score++
			}
		}
		if score > 0 {
			hits = append(hits, scored{h, score})
		}
	}
	slices.SortStableFunc(hits, func(a, b scored) int { return b.score - a.score })
	out := make([]store.ListDigestCandidatesRow, min(len(hits), maxHistory))
	for i := range out {
		out[i] = hits[i].row
	}
	return out
}

// diffContract is the prompt of a History question's second pass: one topic the
// first pass found, against earlier Highlights of the same family.
const diffContract = `RELEASE: {{title}}

The NEW items cover this release. The EARLIER items are older coverage of the same family, each led by the date it was written, as
[ref] date · newsletter · headline — text

Say what changed versus the release before it in the SAME line: same vendor and same tier (Opus against Opus, Sol against Sol, Flash against Flash).
- previous: the name of that earlier release, as the EARLIER items name it. Several earlier releases of the line: the most recent one, by date.
- Earlier coverage of {{title}} itself is not a previous release. A different tier or a different vendor is not one either.
- diff: one or two short sentences, each a before and an after: what the EARLIER items say the previous release was or had, then what the NEW items say this one is or has instead (capability, price, speed, context, availability). Plain sentences, no "Before:" / "After:" labels. Every claim must come from the items.
- Something the EARLIER items give no "before" for is not a difference: leave it out.
- Compare like with like: a price against a price in the same unit, a score against the same benchmark.
- refs: the EARLIER refs that describe the previous release, at most {{max_refs}}, exactly as written, e.g. "h4".
- Use only what the items say. Never add a fact, name or number of your own.
- The EARLIER items describe no previous release of this line: return {"diffs":[]}.

Return ONLY this JSON, no prose around it:
{"diffs":[{"previous":"…","diff":"…","refs":["h4"]}]}
`

// diffsReplySchema is diffContract's reply as a constrained model is held to it.
// Unconstrained, Haiku 5.5 answered this pass in prose two runs in three.
var diffsReplySchema = json.RawMessage(`{
  "type": "object",
  "additionalProperties": false,
  "required": ["diffs"],
  "properties": {
    "diffs": {"type": "array", "items": {
      "type": "object",
      "additionalProperties": false,
      "required": ["previous", "diff", "refs"],
      "properties": {
        "previous": {"type": "string"},
        "diff": {"type": "string"},
        "refs": {"type": "array", "items": {"type": "string"}}
      }
    }}
  }
}`)

func diffHead(title string) string {
	return strings.NewReplacer("{{title}}", title, "{{max_refs}}", strconv.Itoa(maxHistoryRefs)).Replace(diffContract)
}

type replyDiff struct {
	Previous string     `json:"previous"`
	Diff     string     `json:"diff"`
	Refs     []replyRef `json:"refs"`
}

// applyDiff puts a second-pass reply on its topic. said reports whether the
// model claimed a diff at all; kept whether it survived. A claim is kept only
// with a named previous release and an earlier ref that was sent AND names that
// release: a diff nobody can check against stored text is the model writing a
// Document's facts — Haiku named "Gemini 4" over a line about Gemini 3.8 Flash.
// So is one against another line (sameLine). The prompt asks, the server enforces.
func applyDiff(reply string, topic *Topic, earlier []candidate) (said, kept bool, err error) {
	items, err := pipeline.DecodeLLMList[replyDiff](reply, "diffs", "digest")
	if err != nil {
		return false, false, err //nolint:wrapcheck // DecodeLLMList already names the caller
	}
	if len(items) == 0 {
		return false, false, nil
	}
	previous, diff := strings.TrimSpace(items[0].Previous), strings.TrimSpace(items[0].Diff)
	if previous == "" && diff == "" {
		return false, false, nil
	}
	idx, text := indexRefs(earlier), map[Ref]string{}
	for _, c := range earlier {
		text[c.ref] = c.line
		whole := Ref{HighlightID: c.ref.HighlightID, Bullet: -1}
		if c.ref != whole {
			text[whole] += c.line + "\n"
		}
	}
	var cited []sentRef
	seen := map[Ref]bool{}
	for _, r := range items[0].Refs {
		if ref, ok := idx[string(r)]; ok && !seen[ref.Ref] && names(text[ref.Ref], previous) {
			seen[ref.Ref] = true
			cited = append(cited, ref)
		}
	}
	if previous == "" || diff == "" || len(cited) == 0 || !sameLine(topic.Title, previous) {
		return true, false, nil
	}
	topic.Previous, topic.Diff = previous, diff
	for _, ref := range capRefs(cited, maxHistoryRefs) {
		ref.History = true
		topic.Refs = append(topic.Refs, ref)
	}
	return true, true, nil
}

// history is the earlier Highlights a History question may compare against:
// everything the Digest's Feeds produced before the window, newest first.
func (r Runner) history(ctx context.Context, d Digest, start string) ([]store.ListDigestCandidatesRow, error) {
	rows, err := r.Q.ListDigestCandidates(ctx, store.ListDigestCandidatesParams{CreatedAt: "", CreatedAt_2: start})
	if err != nil {
		return nil, fmt.Errorf("list history: %w", err)
	}
	return slices.DeleteFunc(rows, func(h store.ListDigestCandidatesRow) bool { return !d.inScope(h.FeedID) }), nil
}

// diffCall is what every second-pass call of one question shares.
type diffCall struct {
	d                      Digest
	route                  llm.Route
	ctxTokens, replyTokens int
	sent                   []candidate // the first pass's items
	history                []store.ListDigestCandidatesRow
}

// diffTopics is a History question's second pass: one call per topic that has
// earlier Highlights to be compared with. A topic with none is left as the first
// pass wrote it, and so is one whose own lines leave no room for an earlier item
// (counted in dropped). The calls' tokens are added to prov.
func (r Runner) diffTopics(ctx context.Context, c diffCall, topics []Topic, prov *pipeline.Provenance) (diffs, dropped int, err error) {
	for i := range topics {
		t := &topics[i]
		picked := pickHistory(t.Title, c.history)
		if len(picked) == 0 {
			continue
		}
		for _, h := range picked {
			if err := r.gate(c.d, h.DocumentCanonicalUrl, fmt.Sprintf("%q (feed %q)", h.Title, store.FeedTitle(h.FeedTitle, h.FeedUrl))); err != nil {
				return diffs, dropped, err
			}
		}
		head := diffHead(t.Title) + "\nNEW ITEMS:\n" + topicLines(*t, c.sent) + "\n\nEARLIER ITEMS:\n"
		budget := pipeline.ChunkBudget(c.ctxTokens, c.replyTokens, pipeline.EstimateTokens(head))
		earlier, _ := clamp(buildCandidates(picked, "h", true), budget)
		if len(earlier) == 0 {
			dropped++
			continue
		}
		route := c.route
		route.Params.ReplySchema = diffsReplySchema
		reply, usage, err := pipeline.MeteredComplete(ctx, r.Q, r.Router, Kind, route, nil, renderPrompt(head, earlier))
		if err != nil {
			return diffs, dropped, err //nolint:wrapcheck // MeteredComplete already names the caller
		}
		prov.TokensIn += usage.InputTokens
		prov.TokensOut += usage.OutputTokens
		prov.Calls = max(prov.Calls, 1) + 1
		said, kept, err := applyDiff(reply, t, earlier)
		if err != nil {
			return diffs, dropped, err
		}
		switch {
		case kept:
			diffs++
		case said:
			dropped++
		}
	}
	return diffs, dropped, nil
}

// topicLines is the first pass's lines a topic cites, as they were sent. A ref
// to a whole Highlight that was listed bullet by bullet brings all its bullets.
func topicLines(t Topic, sent []candidate) string {
	var lines []string
	for _, c := range sent {
		if slices.ContainsFunc(t.Refs, func(ref Ref) bool {
			return ref.HighlightID == c.ref.HighlightID && (ref.Bullet == c.ref.Bullet || ref.Bullet == -1)
		}) {
			lines = append(lines, c.line)
		}
	}
	return strings.Join(lines, "\n")
}
