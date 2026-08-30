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
// Four bands, sized from config (see config.SummarizeLimits):
//
//	small     → one call, exactly as before
//	chunked   → split, one call per chunk (mapDefaultPrompt), one call to fold
//	            the parts together with the step's OWN prompt — lossy, correct
//	            only for a step whose contract is already lossy prose
//	partition → split, the step's OWN prompt run on every chunk, every reply
//	            unioned — no fold, so nothing is ever paraphrased from a summary
//	big       → one call to the big model, truncated to what that model holds
//
// chunked and partition both span several jobs: one chunk per tick. A handler
// therefore must return longResult.Step untouched when it is not Done, and only
// insert its Highlight(s) on the tick that is.
func llmStepCallLong(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router,
) (longResult, error) {
	lim := router.Summarize(req.Kind)

	// Applied BEFORE the band is decided, not just before the call: link-noise
	// (tracking URLs) both inflates EstimateTokens — which counts runes, so a
	// URL costs as much as prose — and can be the entire reason a document
	// crosses chunk_above at all. A real newsletter measured 76% tracking-URL
	// noise; compacting first is what decides which band a document lands in.
	req.Content = CompactForLLM(req.Content)

	st, err := loadChunkState(run.State, req.Kind)
	if err != nil {
		return longResult{}, err
	}
	// A run already mid-chunking continues on its original plan. Re-deciding the
	// band here would strand the partials a previous tick paid for.
	if st != nil {
		return chunkedTick(ctx, q, run, req, router, lim, st)
	}

	bd, st, err := planRun(lim, req)
	if err != nil {
		return longResult{}, err
	}
	switch bd {
	case bandSmall:
		return singleCall(ctx, q, run, req, router, lim, false)
	case bandBig:
		return singleCall(ctx, q, run, req, router, lim, true)
	case bandChunked, bandPartition:
		return chunkedTick(ctx, q, run, req, router, lim, st)
	}
	return longResult{}, fmt.Errorf("%s: unknown band %d", req.Kind, bd)
}

// band is the explicit result of planRun. singleCall and chunkedTick used to
// re-derive which band they were serving from EstimateTokens(content) >=
// lim.ChunkAbove — a threshold that cannot tell "small" apart from "chunked but
// only one chunk resulted" (see planRun). Naming the band explicitly, once,
// closes that dead zone instead of asking every consumer to re-guess it.
type band int

const (
	bandSmall band = iota
	bandBig
	bandChunked   // map → reduce fold (lossy prose; llm_summarize only)
	bandPartition // step's own prompt per chunk, replies unioned (lossless)
)

// chunkStrategyFor decides which chunking band a step's own contract requires,
// once — every other place in this file dispatches on the answer instead of
// re-deciding it. Default is bandPartition, the SAFE behaviour: extraction must
// opt OUT of losslessness explicitly, not opt in, the same polarity as
// toleratesTruncatedReply. llm_summarize is the one opt-out, because its
// contract already IS lossy prose — folding chunk summaries through one more
// model call is what "summarize" means, not the fabrication bug this exists to
// remove.
func chunkStrategyFor(kind string) band {
	if kind == kindLLMSummarize {
		return bandChunked
	}
	return bandPartition
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
// Done while chunks remain; Note is the truncation disclosure — either the
// document not fitting even the big model, or the provider cutting the reply
// itself off at max_tokens (both can appear together). Steps that write prose
// append Note to the body; a step whose reply is parsed (JSON topics) never gets
// a non-empty Note in the first place — toleratesTruncatedReply fails those
// steps outright instead (see callWithFallback).
type longResult struct {
	// Reply is the single final text a small/big/chunked(map→reduce) call
	// produced.
	Reply string
	// Replies is set instead of Reply by a finished bandPartition run: one
	// verbatim reply per chunk, never folded. See AllReplies.
	Replies []string
	Meta    string
	Note    string
	Step    StepResult
}

// AllReplies is the one way a handler reads "what did the model say", whichever
// band produced it: Replies for a partitioned run, or the single Reply wrapped
// in a slice otherwise. A handler that parses a JSON list ranges over this and
// never touches Reply/Replies directly.
func (r longResult) AllReplies() []string {
	if len(r.Replies) > 0 {
		return r.Replies
	}
	if strings.TrimSpace(r.Reply) == "" {
		return nil
	}
	return []string{r.Reply}
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
	phaseMap       = "map"
	phaseReduce    = "reduce"
	phasePartition = "partition"
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

// planRun decides the band explicitly — see the band type. A nil state means
// bandSmall or bandBig — one call, no ticks — which singleCall then serves.
func planRun(lim config.SummarizeLimits, req longRequest) (band, *chunkState, error) {
	docTokens := EstimateTokens(req.Content)
	if docTokens < lim.ChunkAbove {
		return bandSmall, nil, nil
	}
	if docTokens >= lim.BigAbove {
		return bandBig, nil, nil
	}
	strategy := chunkStrategyFor(req.Kind)
	chunks, err := splitForStrategy(lim, req, strategy)
	if err != nil {
		return bandSmall, nil, err
	}
	// More pieces than the ceiling allows: hand the whole document to the big
	// model instead. Dropping the tail to fit the ceiling would be the silent
	// truncation this function exists to remove.
	if len(chunks) > lim.MaxChunks {
		return bandBig, nil, nil
	}
	// Estimated over chunk_above, but the actual split still fits in ONE piece —
	// the dead zone this branch exists to close. A document of chunk_above..
	// (map budget) runes lands here: docTokens over the threshold, yet one call
	// serves it. Before this branch existed, planRun returned nil for this case
	// exactly as it does for "too small to chunk", and singleCall re-derived the
	// band from the SAME docTokens>=ChunkAbove threshold — which can't tell the
	// two apart — and escalated straight to the big role's max_tokens cap.
	if len(chunks) < 2 {
		return bandSmall, nil, nil
	}
	return strategy, freshChunkState(strategy, req, len(chunks)), nil
}

// freshChunkState starts a chunked run's state at chunk 0, in the phase its
// strategy begins in.
func freshChunkState(strategy band, req longRequest, chunks int) *chunkState {
	phase := phaseMap
	if strategy == bandPartition {
		phase = phasePartition
	}
	return &chunkState{Phase: phase, Kind: req.Kind, Chunks: chunks}
}

// splitForStrategy dispatches to the split sized for each strategy's own prompt
// and reply shape — see splitForMap and splitForPartition.
func splitForStrategy(lim config.SummarizeLimits, req longRequest, strategy band) ([]string, error) {
	if strategy == bandPartition {
		return splitForPartition(lim, req)
	}
	return splitForMap(lim, req)
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

// splitForPartition cuts the document to what the map endpoint can hold when a
// PARTITION tick sends it — sized for the STEP's OWN prompt and completion cap,
// not mapDefaultPrompt's: a partition call sends the full extraction prompt and
// gets back the step's own JSON list, both routinely much larger than
// mapDefaultPrompt's "max 5 bullets" contract that splitForMap sizes for.
func splitForPartition(lim config.SummarizeLimits, req longRequest) ([]string, error) {
	maxTokens := req.Cfg.MaxTokens
	if maxTokens == 0 {
		// "0" means "the provider's own default" — not a number ChunkBudget can
		// subtract. The map role's own cap is the best known stand-in for sizing
		// THIS SAME endpoint; partitionRoleConfig still sends 0 to the provider,
		// this only affects how big a chunk we dare send it.
		maxTokens = lim.Map.MaxTokens
	}
	budget := ChunkBudget(lim.Map.CtxTokens, maxTokens, EstimateTokens(req.Cfg.Prompt))
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

// singleCall serves both one-call bands. Which one is the caller's call
// (planRun decided it, once) — this function no longer re-derives it from
// EstimateTokens(content) >= lim.ChunkAbove, which is what created the dead zone
// documented on planRun's "len(chunks) < 2" branch: that threshold cannot tell
// "small" apart from "chunked but only one chunk resulted". The small band sends
// the step's own config untouched; the big band swaps in the big role and clamps
// the document to what that endpoint holds, disclosing the cut in the returned
// Note.
func singleCall(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router, lim config.SummarizeLimits, big bool,
) (longResult, error) {
	var acc usageAcc
	c := req.Cfg
	role := "" // "" = the step's own config, not a SummarizeRole override
	content := req.Content
	note := ""

	if big {
		c = roleConfig(lim.Big, req.Cfg, req.Cfg.Prompt)
		role = "big"
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
	reply, err := callWithFallback(ctx, q, run, req.Kind, c, role, bigFallback(lim, req.Cfg, c.Prompt), lim.MaxTries,
		renderPrompt(c.Prompt, req.vars(content)), router, &acc, !toleratesTruncatedReply(req.Kind))
	if err != nil {
		return longResult{}, err
	}
	// Reached only when the reply survived (strict steps already failed inside
	// callWithFallback) — this is the disclosure path, not the error path.
	if acc.last.Truncated {
		acc.outputTruncated = true
		note += outputTruncationNote(acc.last)
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
	strategy := chunkStrategyFor(req.Kind)
	chunks, err := splitForStrategy(lim, req, strategy)
	if err != nil {
		return longResult{}, err
	}
	if len(chunks) != st.Chunks {
		// The document changed under a running plan (a re-scrape mid-run). Start over
		// rather than fold partials of one revision into a summary of another.
		st = freshChunkState(strategy, req, len(chunks))
	}

	var acc usageAcc
	switch st.Phase {
	case phaseMap:
		return mapTick(ctx, q, run, req, router, lim, st, chunks, &acc)
	case phaseReduce:
		return reduceTick(ctx, q, run, req, router, lim, st, &acc)
	case phasePartition:
		return partitionTick(ctx, q, run, req, router, lim, st, chunks, &acc)
	default:
		// loadChunkState already rejects an unknown phase before this is ever
		// reached; freshChunkState only ever writes the three above.
		return longResult{}, fmt.Errorf("%s: chunk state has unknown phase %q", req.Kind, st.Phase)
	}
}

// partitionRoleConfig routes a partition tick through the map role's endpoint —
// the same box the chunked band would use for a document this size — but keeps
// the STEP's own completion cap, not the map role's ~300-token bullet budget: a
// partition reply is the full step-shaped JSON (verbatim sections, ideas,
// quotes), not five caveman bullets.
func partitionRoleConfig(lim config.SummarizeLimits, req longRequest) llmStepConfig {
	c := roleConfig(lim.Map, req.Cfg, req.Cfg.Prompt)
	c.MaxTokens = req.Cfg.MaxTokens
	return c
}

// partitionTick runs the STEP's OWN prompt on exactly one chunk and appends the
// reply to Partials verbatim. Unlike mapTick, there is nothing folded here:
// extraction is embarrassingly parallel — each chunk already carries its own
// complete sections/ideas/quotes — so there is nothing for a reduce pass to
// synthesize. Folding here is exactly the step that fabricated text in the bug
// this strategy exists to remove: the model saw only chunk summaries, not the
// original wording, and wrote plausible-sounding text instead.
func partitionTick(ctx context.Context, q *store.Queries, run store.PipelineRun,
	req longRequest, router *llm.Router, lim config.SummarizeLimits,
	st *chunkState, chunks []string, acc *usageAcc,
) (longResult, error) {
	i := st.Next
	c := partitionRoleConfig(lim, req)
	vars := req.vars(chunks[i])

	// Strict, like reduceTick/singleCall: this reply IS the step's own JSON,
	// parsed by the handler, so a completion cut at max_tokens is not a degraded
	// answer worth keeping — see toleratesTruncatedReply.
	reply, err := callWithFallback(ctx, q, run, req.Kind, c, "map", bigFallback(lim, req.Cfg, req.Cfg.Prompt),
		lim.MaxTries, renderPrompt(c.Prompt, vars), router, acc, !toleratesTruncatedReply(req.Kind))
	if err != nil {
		// The tick fails, the job retries, and the saved state resumes AT THIS
		// CHUNK — same recovery contract as mapTick.
		return longResult{}, err
	}

	if reply = strings.TrimSpace(reply); reply != "" {
		st.Partials = append(st.Partials, reply)
	}
	st.Next++

	if st.Next < st.Chunks {
		st.Calls += acc.calls
		st.TokensIn += acc.tokensIn
		st.TokensOut += acc.tokensOut
		state, err := json.Marshal(st)
		if err != nil {
			return longResult{}, fmt.Errorf("%s: encode chunk state: %w", req.Kind, err)
		}
		return longResult{Step: StepResult{NewState: string(state), Continue: true}}, nil
	}

	// The last chunk answered on THIS call — acc already carries its numbers, so
	// only the EARLIER ticks' totals (still sitting in st, never folded in above
	// on the final tick) need merging in. Same pattern as reduceTick.
	acc.chunks = st.Chunks
	acc.merge(st.Calls, st.TokensIn, st.TokensOut)
	return longResult{
		Replies: st.Partials,
		Meta:    acc.provenance(req.Kind, req.Cfg),
		Step:    StepResult{Done: true},
	}, nil
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

	// Never strict here: a map chunk is always caveman bullets (mapDefaultPrompt),
	// never the step's own JSON — a truncated chunk just loses some facts, folded
	// into the reduce pass same as a chunk that was navigation/ads and came back
	// empty. The reply that actually gets parsed is the reduce/big call below.
	reply, err := callWithFallback(ctx, q, run, req.Kind, c, "map", bigFallback(lim, req.Cfg, c.Prompt),
		lim.MaxTries, renderPrompt(c.Prompt, vars), router, acc, false)
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
	role := "reduce"

	// Partials that outgrew the fold endpoint escalate to the big model rather than
	// folding recursively. Same escape hatch as the large band — one code path.
	budget := ChunkBudget(lim.Reduce.CtxTokens, lim.Reduce.MaxTokens, EstimateTokens(req.Cfg.Prompt))
	if utf8.RuneCountInString(joined) > budget {
		c = roleConfig(lim.Big, req.Cfg, req.Cfg.Prompt)
		role = "big"
	}

	// This IS the call whose reply becomes the step's output — strict rules apply
	// exactly as they do in singleCall.
	reply, err := callWithFallback(ctx, q, run, req.Kind, c, role, bigFallback(lim, req.Cfg, c.Prompt),
		lim.MaxTries, renderPrompt(c.Prompt, req.vars(joined)), router, acc, !toleratesTruncatedReply(req.Kind))
	if err != nil {
		return longResult{}, err
	}

	note := ""
	if acc.last.Truncated {
		acc.outputTruncated = true
		note = outputTruncationNote(acc.last)
	}
	acc.chunks = st.Chunks
	acc.merge(st.Calls, st.TokensIn, st.TokensOut)
	return longResult{
		Reply: reply,
		Meta:  acc.provenance(req.Kind, req.Cfg),
		Note:  note,
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
//
// This survives the band-inference fix (planRun/singleCall's explicit `big
// bool`) unchanged: that fix closed a DIFFERENT ambiguity — "which band is this
// call" — which singleCall no longer has to guess. This one is "which endpoint
// is the big role, once we're genuinely there" — a real, still-live question for
// every big-band call whether or not the dead zone ever misrouted one to it. The
// two are independent; only the first one was the bug.
func bigCtxTokens(lim config.SummarizeLimits) int {
	if lim.Big.Provider == "" && lim.Big.Model == "" {
		return min(lim.Big.CtxTokens, lim.Map.CtxTokens)
	}
	return lim.Big.CtxTokens
}

// callWithFallback tries primary up to tries times, then fb up to tries times.
// Every attempt is metered, because every attempt that reached the endpoint cost
// tokens whether or not its reply was usable.
//
// primaryRole is the SummarizeRole name ("map"/"reduce"/"big", "" for a step's own
// unrouted config) primary was built from — the fallback role is always "big"
// (see bigFallback). Both feed truncatedReplyErr's config hint; a call that never
// truncates never looks at them.
//
// strict means a truncated reply is fatal, not just noted (see
// toleratesTruncatedReply): on strict, a completion cut off at max_tokens returns
// immediately as an error INSTEAD of the reply, without exhausting the remaining
// tries — retrying the same call at the same cap would truncate identically, so
// the only thing burned by the other `tries-1` attempts would be time and money
// (see job 461fce04: 3 tries, 3 identical truncations, 45s, before the real cause
// surfaced). Escalating to a genuinely different endpoint (fb, when it isn't the
// same one) still happens — a bigger cap there might actually not truncate.
func callWithFallback(ctx context.Context, q *store.Queries, run store.PipelineRun,
	kind string, primary llmStepConfig, primaryRole string, fb *llmStepConfig, tries int,
	userMsg string, router *llm.Router, acc *usageAcc, strict bool,
) (string, error) {
	if tries < 1 {
		tries = 1
	}
	attempt := func(c llmStepConfig, role string) (string, error) {
		var last error
		for i := 1; i <= tries; i++ {
			reply, err := llmCall(ctx, q, run, kind, c, userMsg, router, acc)
			if err == nil {
				if strict && acc.last.Truncated {
					return "", truncatedReplyErr(kind, role, acc.last)
				}
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

	reply, err := attempt(primary, primaryRole)
	if err == nil {
		return reply, nil
	}
	if fb == nil || ctx.Err() != nil || sameEndpoint(primary, *fb) {
		return "", err
	}
	logChunk.Warnf("%s: %d attempts failed (%v); escalating to %s", kind, tries, err, endpointName(*fb))
	reply, fbErr := attempt(*fb, "big")
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
	if st.Phase != phaseMap && st.Phase != phaseReduce && st.Phase != phasePartition {
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

// toleratesTruncatedReply answers "can this step's reply survive a completion cut
// off at max_tokens". Everything defaults to NO: a JSON-parsed reply missing its
// tail is not valid JSON, so failing the step is the only sane response, and a
// future JSON-parsing step needs no opt-in to get that protection. llm_summarize
// is the one opt-out — its reply is prose with a disclosure mechanism already
// built for exactly this (truncationNote/appendNote).
func toleratesTruncatedReply(kind string) bool {
	return kind == kindLLMSummarize
}

// outputTruncationNote is the disclosure for a completion the PROVIDER cut short
// at max_tokens. Distinct from truncationNote: that one discloses the INPUT
// document being clamped before the call ever ran. Both can fire on the same
// reply, and each says only what it actually knows.
func outputTruncationNote(u llm.Usage) string {
	return "\n\n---\n*Reply cut short at the " + strconv.Itoa(u.MaxTokens) + "-token completion cap.*"
}

// truncatedReplyErr is what a JSON-parsing step's call fails with when the
// provider cuts the completion off at max_tokens: a partial JSON reply is not a
// degraded answer, it is not an answer, so this names the cap and the exact
// config key to raise rather than letting the caller find out via a bare
// json.Unmarshal error (see job 461fce04, where the real cause only surfaced by
// cross-referencing llm_usages).
func truncatedReplyErr(kind, role string, u llm.Usage) error {
	hint := "this step's own max_tokens (pipeline step config)"
	if role != "" {
		hint = fmt.Sprintf("[llm.summarize.steps.%s].%s.max_tokens", kind, role)
	}
	return fmt.Errorf("%s: llm reply truncated at max_tokens=%d (%s/%s); raise %s",
		kind, u.MaxTokens, u.Provider, u.Model, hint)
}
