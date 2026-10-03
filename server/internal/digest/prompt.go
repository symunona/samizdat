package digest

import (
	"strconv"
	"strings"

	"github.com/symunona/samizdat/server/internal/pipeline"
)

// promptContract is the fixed half of every question's prompt: the output shape
// the server parses. The question's own prompt is the editable half.
//
// Grouping and semantic dedup happen in this one call — there are no embeddings
// in the stack, and at this size none are needed.
const promptContract = `You are given numbered ITEMS: bullets and highlights extracted from recent newsletter issues, one per line, as
[ref] newsletter · headline — text

QUESTION: {{question}}

Answer with at most {{top_n}} topics, most important first.
- One topic per distinct thing (a product, model, release, event) — never a category or umbrella theme.
- Fewer than {{top_n}} topics is fine; return only items that actually answer the question. Never pad.
- Items about the same thing are ONE topic, however differently they word it: merge them and list the refs that cover it, at most {{max_refs}}, from as many different newsletters as you can.
- Only say several newsletters covered something when the cited refs come from different newsletters.
- Use only what the items say. Never add a fact, name or number of your own.
- title: a few words naming the topic. why: one short sentence on why it answers the question.
- refs: the bracketed refs exactly as written, e.g. "17.2" or "31". A topic without refs is discarded.
- Leave out anything on the ALREADY COVERED list unless an item adds something materially new.
- Nothing in the items answers the question: return no topics.

Return ONLY this JSON, no prose around it:
{"topics":[{"title":"…","why":"…","refs":["17.2","31"]}]}
`

// maxTopicRefs caps the refs one topic keeps. The cleanest grouping in the eval
// cited 7; Haiku, told "at most 6", cited 25 — so the prompt asks and the server
// enforces (capRefs).
const maxTopicRefs = 7

// promptHead is the prompt up to the items: the contract with the question in
// it, and what the previous issue already told the reader.
func promptHead(q Question, covered []string) string {
	head := strings.NewReplacer("{{question}}", q.Prompt, "{{top_n}}", strconv.Itoa(q.TopN),
		"{{max_refs}}", strconv.Itoa(maxTopicRefs)).Replace(promptContract)
	if len(covered) > 0 {
		head += "\nALREADY COVERED:\n- " + strings.Join(covered, "\n- ") + "\n"
	}
	return head + "\nITEMS:\n"
}

func renderPrompt(head string, sent []candidate) string {
	lines := make([]string, len(sent))
	for i, c := range sent {
		lines[i] = c.line
	}
	return head + strings.Join(lines, "\n")
}

// replyRef accepts a ref however the model spelled it: "17.2", "[17.2]" or the
// bare number 17.2.
type replyRef string

func (r *replyRef) UnmarshalJSON(b []byte) error {
	*r = replyRef(strings.Trim(string(b), "\"[] \t"))
	return nil
}

type replyTopic struct {
	Title string     `json:"title"`
	Why   string     `json:"why"`
	Refs  []replyRef `json:"refs"`
}

// parseTopics turns a reply into ranked topics. The model contributes a title
// and a why, nothing else: a ref the index does not hold is dropped, and a topic
// left with no ref is dropped with it — a pass that never saw the Document must
// not be allowed to write its facts. dropped counts those topics, trimmed the
// refs capRefs cut from the rest.
func parseTopics(reply string, q Question, idx refIndex) (topics []Topic, dropped, trimmed int, err error) {
	items, err := pipeline.DecodeLLMList[replyTopic](reply, "topics", "digest")
	if err != nil {
		return nil, 0, 0, err //nolint:wrapcheck // DecodeLLMList already names the caller
	}
	for _, it := range items {
		if len(topics) == q.TopN {
			break
		}
		title := strings.TrimSpace(it.Title)
		if title == "" {
			continue
		}
		var cited []sentRef
		seen := map[Ref]bool{}
		for _, r := range it.Refs {
			if ref, ok := idx[string(r)]; ok && !seen[ref.Ref] {
				seen[ref.Ref] = true
				cited = append(cited, ref)
			}
		}
		if len(cited) == 0 {
			dropped++
			continue
		}
		refs := capRefs(cited, maxTopicRefs)
		trimmed += len(cited) - len(refs)
		topics = append(topics, Topic{
			QuestionID:    q.ID,
			QuestionTitle: q.Title,
			Rank:          len(topics) + 1,
			Title:         title,
			Why:           strings.TrimSpace(it.Why),
			Refs:          refs,
		})
	}
	return topics, dropped, trimmed, nil
}

// capRefs keeps at most n of a topic's refs, in the order the model cited them.
// The first ref from each Feed is kept before any second one from the same Feed,
// so a topic trimmed down still carries its cross-newsletter proof — the thing
// the Digest exists to find.
func capRefs(cited []sentRef, n int) []Ref {
	keep := make([]bool, len(cited))
	kept, feeds := 0, map[string]bool{}
	for i, r := range cited {
		if kept < n && !feeds[r.feed] {
			feeds[r.feed] = true
			keep[i] = true
			kept++
		}
	}
	for i := range cited {
		if kept < n && !keep[i] {
			keep[i] = true
			kept++
		}
	}
	refs := []Ref{}
	for i, r := range cited {
		if keep[i] {
			refs = append(refs, r.Ref)
		}
	}
	return refs
}
