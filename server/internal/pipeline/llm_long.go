package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/symunona/samizdat/server/internal/config"
	"github.com/symunona/samizdat/server/internal/llm"
	"github.com/symunona/samizdat/server/internal/logger"
	"github.com/symunona/samizdat/server/internal/store"
)

var logChunk = logger.New("chunk")

// llmStepCallLong is how every LLM step hands a document to a model. It replaces
// the per-step `content[:12000]` slices, which threw away everything past the
// first few thousand tokens and said nothing about it.
//
// Three bands, sized from config (see config.SummarizeLimits):
//
//	small  → one call, exactly as before
//	medium → split, one call per chunk, one call to fold the parts together
//	large  → one call to the big model, truncated to what that model holds
//
// The medium band spans several jobs: one chunk per tick. A handler therefore
// must return longResult.Step untouched when it is not Done, and only insert its
// Highlight on the tick that is.
func llmStepCallLong(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router,
) (longResult, error) {
	lim := router.Summarize(req.Kind)

	st, err := loadChunkState(run.State, req.Kind)
	if err != nil {
		return longResult{}, err
	}
	// A run already mid-chunking continues on its original plan. Re-deciding the
	// band here would strand the partials a previous tick paid for.
	if st == nil {
		st, err = planRun(lim, req)
		if err != nil {
			return longResult{}, err
		}
	}
	if st == nil {
		return singleCall(ctx, q, run, req, router, lim)
	}
	return chunkedTick(ctx, q, run, req, router, lim, st)
}

// longRequest is what a step knows: which kind it is, how it is configured, and
// the document text it has already preprocessed its own way.
type longRequest struct {
	Kind    string
	Cfg     llmStepConfig
	Title   string
	Content string
	// Vars carries template placeholders beyond title/content (recently_covered).
	Vars map[string]string
}

// longResult is the reply plus everything the step needs to finish. Step is not
// Done while chunks remain; Note is the truncation disclosure, empty unless the
// document did not fit even the big model. Steps that write prose append Note to
// the body; a step whose reply is parsed (JSON topics) leaves it alone.
type longResult struct {
	Reply string
	Meta  string
	Note  string
	Step  StepResult
}

// chunkState is the medium band's progress, carried in pipeline_runs.state
// between ticks. The chunk TEXT is not stored: Split is deterministic, so each
// tick re-derives the same chunks from the document and takes the one it needs.
// Storing them would put a copy of the whole document in the runs table.
type chunkState struct {
	Phase string `json:"phase"` // phaseMap | phaseReduce
	// Kind guards against reading a state some other step kind wrote. Step state
	// is cleared on every step advance, so this should never fire — it is what
	// makes that a checked assumption rather than a remembered one.
	Kind      string   `json:"kind"`
	Chunks    int      `json:"chunks"`
	Next      int      `json:"next"`
	Partials  []string `json:"partials"`
	Calls     int      `json:"calls"`
	TokensIn  int      `json:"tokens_in"`
	TokensOut int      `json:"tokens_out"`
}

const (
	phaseMap    = "map"
	phaseReduce = "reduce"
)

// mapDefaultPrompt is what a chunk is summarized with. It exists separately from
// every step's own prompt for one reason: a chunk is NOT an article. Handed the
// summary prompt, a model writes twelve little articles, each opening with its
// own framing sentence, and the fold pass then has to see through all of it.
//
// It also deliberately has no __NOT_PARSEABLE__ clause. That sentinel kills the
// whole Document, and a nav bar or a cookie notice is a perfectly normal chunk of
// a perfectly real article — letting chunk 9 fire it would throw away the nine
// chunks already paid for.
const mapDefaultPrompt = "You are given ONE FRAGMENT (chunk {{chunk}} of {{chunks}}) of a longer document, not the whole thing. " +
	"Extract only what THIS fragment states: concrete facts, claims, numbers, names. " +
	"Caveman style: drop articles (a/an/the), filler (just/really/basically), hedges (seems/appears). Fragments OK. " +
	"Max 5 short bullets. No intro, no outro, no heading, no conclusion, no summary-of-the-summary. " +
	"Never write 'This article', 'The text' or 'The author'. " +
	"If the fragment is navigation, ads, a cookie notice, a footer or otherwise carries no facts, return exactly an empty string." +
	"\n\n# {{title}}\n\n{{content}}"

// planRun decides the band. A nil state means the small or large band — one call,
// no ticks — which singleCall then serves.
func planRun(lim config.SummarizeLimits, req longRequest) (*chunkState, error) {
	docTokens := EstimateTokens(req.Content)
	if docTokens < lim.ChunkAbove || docTokens >= lim.BigAbove {
		return nil, nil
	}
	chunks, err := splitForMap(lim, req)
	if err != nil {
		return nil, err
	}
	// More pieces than the ceiling allows: hand the whole document to the big
	// model instead. Dropping the tail to fit the ceiling would be the silent
	// truncation this function exists to remove.
	if len(chunks) > lim.MaxChunks {
		return nil, nil
	}
	if len(chunks) < 2 {
		return nil, nil
	}
	return &chunkState{Phase: phaseMap, Kind: req.Kind, Chunks: len(chunks)}, nil
}

// splitForMap cuts the document to what the map endpoint can hold. The overlap is
// subtracted from the target because it is added back to every chunk afterwards.
func splitForMap(lim config.SummarizeLimits, req longRequest) ([]string, error) {
	budget := ChunkBudget(lim.Map.CtxTokens, lim.Map.MaxTokens, EstimateTokens(mapPrompt(lim)))
	target := budget - lim.OverlapRunes
	if target < 1 {
		return nil, fmt.Errorf("%s: map ctx_tokens %d leaves no room for content", req.Kind, lim.Map.CtxTokens)
	}
	return Split(req.Content, target, lim.OverlapRunes), nil
}

func mapPrompt(lim config.SummarizeLimits) string {
	if lim.Map.Prompt != "" {
		return lim.Map.Prompt
	}
	return mapDefaultPrompt
}

// singleCall serves both one-call bands. The small band sends the step's own
// config untouched; the large band swaps in the big role and clamps the document
// to what that endpoint holds, disclosing the cut in the returned Note.
func singleCall(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router, lim config.SummarizeLimits,
) (longResult, error) {
	var acc usageAcc
	c := req.Cfg
	content := req.Content
	note := ""

	if EstimateTokens(content) >= lim.ChunkAbove {
		c = roleConfig(lim.Big, req.Cfg, req.Cfg.Prompt)
		budget := ChunkBudget(bigCtxTokens(lim), lim.Big.MaxTokens, EstimateTokens(req.Cfg.Prompt))
		// No room left for any document at all. Failing here is the point: a zero
		// budget silently skipping the clamp would send the WHOLE document to an
		// endpoint that cannot hold it, which is the overflow this band exists to
		// prevent — and an Ollama would answer it without complaint.
		if budget < 1 {
			return longResult{}, fmt.Errorf("%s: big ctx_tokens %d leaves no room for content after a %d-token prompt",
				req.Kind, bigCtxTokens(lim), EstimateTokens(req.Cfg.Prompt))
		}
		if kept, cut := clampRunes(content, budget); cut {
			note = truncationNote(EstimateTokens(kept), EstimateTokens(content))
			content = kept
			acc.truncated = true
		}
	}

	// The big role is the escalation target for the small band too — a step whose
	// own endpoint is down should still produce a summary. When the big role names
	// nothing of its own it resolves to the same endpoint, and callWithFallback
	// skips it rather than retrying the same box twice.
	reply, err := callWithFallback(ctx, q, run, req.Kind, c, bigFallback(lim, req.Cfg, c.Prompt), lim.MaxTries,
		renderPrompt(c.Prompt, req.vars(content)), router, &acc)
	if err != nil {
		return longResult{}, err
	}
	return longResult{
		Reply: reply,
		Meta:  acc.provenance(req.Kind, req.Cfg),
		Note:  note,
		Step:  StepResult{Done: true},
	}, nil
}

// chunkedTick runs exactly one LLM call and hands the run back to the worker.
//
// One call per job is not fastidiousness: worker.stuckJobAge resets any job whose
// updated_at is older than 10 minutes, and a dozen sequential calls to a local
// model cross that comfortably. The reset would requeue the job WHILE IT RUNS —
// two workers on one run, double spend, duplicate Highlights. Returning between
// calls keeps updated_at fresh, and makes a crash cost one chunk instead of all.
func chunkedTick(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router, lim config.SummarizeLimits, st *chunkState,
) (longResult, error) {
	chunks, err := splitForMap(lim, req)
	if err != nil {
		return longResult{}, err
	}
	if len(chunks) != st.Chunks {
		// The document changed under a running plan (a re-scrape mid-run). Start over
		// rather than fold partials of one revision into a summary of another.
		st = &chunkState{Phase: phaseMap, Kind: req.Kind, Chunks: len(chunks)}
	}

	var acc usageAcc
	if st.Phase == phaseMap {
		return mapTick(ctx, q, run, req, router, lim, st, chunks, &acc)
	}
	return reduceTick(ctx, q, run, req, router, lim, st, &acc)
}

func mapTick(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router, lim config.SummarizeLimits,
	st *chunkState, chunks []string, acc *usageAcc,
) (longResult, error) {
	i := st.Next
	c := roleConfig(lim.Map, req.Cfg, mapPrompt(lim))
	vars := req.vars(chunks[i])
	vars["chunk"] = strconv.Itoa(i + 1)
	vars["chunks"] = strconv.Itoa(st.Chunks)

	reply, err := callWithFallback(ctx, q, run, req.Kind, c, bigFallback(lim, req.Cfg, c.Prompt),
		lim.MaxTries, renderPrompt(c.Prompt, vars), router, acc)
	if err != nil {
		// The tick fails, the job retries, and the saved state resumes AT THIS CHUNK.
		// Nothing already summarized is re-paid for, and no half-document summary is
		// ever written.
		return longResult{}, err
	}

	if reply = strings.TrimSpace(reply); reply != "" {
		st.Partials = append(st.Partials, reply)
	}
	st.Next++
	st.Calls += acc.calls
	st.TokensIn += acc.tokensIn
	st.TokensOut += acc.tokensOut
	if st.Next >= st.Chunks {
		st.Phase = phaseReduce
	}

	state, err := json.Marshal(st)
	if err != nil {
		return longResult{}, fmt.Errorf("%s: encode chunk state: %w", req.Kind, err)
	}
	return longResult{Step: StepResult{NewState: string(state), Continue: true}}, nil
}

func reduceTick(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router, lim config.SummarizeLimits,
	st *chunkState, acc *usageAcc,
) (longResult, error) {
	joined := strings.Join(st.Partials, "\n\n")

	// The fold runs on the STEP's own prompt, not a generic one: the step's output
	// contract (caveman bullets, a JSON topic list, a newsletter section) is the
	// whole point of the step, and only its prompt states it. The reduce role
	// contributes the endpoint, nothing else.
	c := roleConfig(lim.Reduce, req.Cfg, req.Cfg.Prompt)

	// Partials that outgrew the fold endpoint escalate to the big model rather than
	// folding recursively. Same escape hatch as the large band — one code path.
	budget := ChunkBudget(lim.Reduce.CtxTokens, lim.Reduce.MaxTokens, EstimateTokens(req.Cfg.Prompt))
	if utf8.RuneCountInString(joined) > budget {
		c = roleConfig(lim.Big, req.Cfg, req.Cfg.Prompt)
	}

	reply, err := callWithFallback(ctx, q, run, req.Kind, c, bigFallback(lim, req.Cfg, c.Prompt),
		lim.MaxTries, renderPrompt(c.Prompt, req.vars(joined)), router, acc)
	if err != nil {
		return longResult{}, err
	}

	acc.chunks = st.Chunks
	acc.merge(st.Calls, st.TokensIn, st.TokensOut)
	return longResult{
		Reply: reply,
		Meta:  acc.provenance(req.Kind, req.Cfg),
		Step:  StepResult{Done: true},
	}, nil
}

// vars builds the template variables for one call: the step's own extras plus the
// title and whichever slice of content this call gets.
func (r longRequest) vars(content string) map[string]string {
	v := map[string]string{"title": r.Title, "content": content}
	for k, val := range r.Vars {
		if _, taken := v[k]; !taken {
			v[k] = val
		}
	}
	return v
}

// roleConfig turns a configured role into a step config. A role naming neither a
// provider nor a model keeps the step's own routing: an instance with no
// [llm.summarize] block must change how much it sends, never where it sends it.
func roleConfig(role config.SummarizeRole, base llmStepConfig, prompt string) llmStepConfig {
	c := llmStepConfig{
		Provider:  role.Provider,
		Model:     role.Model,
		MaxTokens: role.MaxTokens,
		Temp:      base.Temp, // temperature stays the step's, it is a style knob
		Prompt:    prompt,
	}
	if c.Provider == "" && c.Model == "" {
		c.Provider, c.Model = base.Provider, base.Model
	}
	return c
}

// bigFallback is the config a role falls back to after exhausting its retries, or
// nil when the role IS the big one (nothing left to escalate to).
func bigFallback(lim config.SummarizeLimits, base llmStepConfig, prompt string) *llmStepConfig {
	big := roleConfig(lim.Big, base, prompt)
	return &big
}

// bigCtxTokens is what the large band may actually send.
//
// When the big role names no endpoint of its own, the call still goes wherever
// the step points — which may be a 7k local box — so sizing it at the configured
// 200k would hand that box 30x its window. An Ollama does not reject an oversized
// prompt; it drops the front and answers about the rest. So an unconfigured big
// role is sized like the map role.
func bigCtxTokens(lim config.SummarizeLimits) int {
	if lim.Big.Provider == "" && lim.Big.Model == "" {
		return min(lim.Big.CtxTokens, lim.Map.CtxTokens)
	}
	return lim.Big.CtxTokens
}

// callWithFallback tries primary up to tries times, then fb up to tries times.
// Every attempt is metered, because every attempt that reached the endpoint cost
// tokens whether or not its reply was usable.
func callWithFallback(ctx context.Context, q *store.Queries, run store.PipelineRun,
	kind string, primary llmStepConfig, fb *llmStepConfig, tries int,
	userMsg string, router *llm.Router, acc *usageAcc,
) (string, error) {
	if tries < 1 {
		tries = 1
	}
	attempt := func(c llmStepConfig) (string, error) {
		var last error
		for i := 1; i <= tries; i++ {
			reply, err := llmCall(ctx, q, run, kind, c, userMsg, router, acc)
			if err == nil {
				return reply, nil
			}
			last = err
			if ctx.Err() != nil {
				return "", last
			}
			if i < tries {
				if err := sleepCtx(ctx, time.Duration(i)*time.Second); err != nil {
					return "", err
				}
			}
		}
		return "", last
	}

	reply, err := attempt(primary)
	if err == nil {
		return reply, nil
	}
	if fb == nil || ctx.Err() != nil || sameEndpoint(primary, *fb) {
		return "", err
	}
	logChunk.Warnf("%s: %d attempts failed (%v); escalating to %s", kind, tries, err, endpointName(*fb))
	reply, fbErr := attempt(*fb)
	if fbErr != nil {
		return "", fmt.Errorf("%s: primary failed (%w) and fallback failed: %w", kind, err, fbErr)
	}
	return reply, nil
}

// sameEndpoint reports whether escalating would just repeat the same call.
func sameEndpoint(a, b llmStepConfig) bool {
	return a.Provider == b.Provider && a.Model == b.Model
}

func endpointName(c llmStepConfig) string {
	switch {
	case c.Provider != "" && c.Model != "":
		return c.Provider + "/" + c.Model
	case c.Provider != "":
		return c.Provider
	case c.Model != "":
		return c.Model
	default:
		return "the configured chain"
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return fmt.Errorf("backoff interrupted: %w", ctx.Err())
	case <-t.C:
		return nil
	}
}

// loadChunkState reads a tick's saved progress. A state written by a different
// step kind, or no state at all, reads as "not started".
func loadChunkState(raw, kind string) (*chunkState, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "{}" {
		return nil, nil
	}
	st, ok := decodeChunkState(raw)
	if !ok || st.Kind != kind || st.Chunks < 1 {
		return nil, nil
	}
	if st.Phase != phaseMap && st.Phase != phaseReduce {
		return nil, fmt.Errorf("%s: chunk state has unknown phase %q", kind, st.Phase)
	}
	return st, nil
}

// decodeChunkState parses a saved state. Unreadable is not an error and is not
// reported as one: run.State is shared with whatever other step kinds a pipeline
// holds, and only the step that wrote it can parse it.
func decodeChunkState(raw string) (*chunkState, bool) {
	var st chunkState
	if json.Unmarshal([]byte(raw), &st) != nil {
		return nil, false
	}
	return &st, true
}

// clampRunes cuts a string to at most budget runes, rune-safe. Reports whether it
// had to cut.
func clampRunes(s string, budget int) (string, bool) {
	if budget < 1 || utf8.RuneCountInString(s) <= budget {
		return s, false
	}
	return string([]rune(s)[:budget]), true
}

// truncationNote is the disclosure appended to a body the model could not read in
// full. Written here, never by the model: a model asked to admit truncation
// either forgets or invents the numbers.
func truncationNote(kept, total int) string {
	pct := 100
	if total > 0 {
		pct = kept * 100 / total
	}
	return "\n\n---\n*Truncated: summarized first ~" + humanTokens(kept) +
		" of ~" + humanTokens(total) + " tokens (" + strconv.Itoa(pct) + "%).*"
}

func humanTokens(n int) string {
	switch {
	case n >= 1_000_000:
		return strconv.FormatFloat(float64(n)/1_000_000, 'f', 1, 64) + "M"
	case n >= 1_000:
		return strconv.Itoa(n/1_000) + "k"
	default:
		return strconv.Itoa(n)
	}
}

// appendNote attaches a truncation disclosure to a prose body. Steps whose reply
// is parsed rather than displayed skip it.
func appendNote(body, note string) string {
	if note == "" || strings.TrimSpace(body) == "" {
		return body
	}
	return body + note
}
