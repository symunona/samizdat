---
created: 2026-08-12
topic: Size-banded chunking summarizer for every LLM pipeline step
excerpt: Replace the four hardcoded content truncations with a config-driven band router — single call, chunk→map→reduce on the local box, or a big-model call — plus a script-written truncation note when even the big model can't hold the document.
status: done — squash-merged to main 2026-08-13
---

## Result (verified 2026-08-12)

A real run on the dev server, 58,205-rune document (~19.4k estimated tokens),
map + fold both on xayah/qwen3-sum:

- 5 chunks, 6 calls, 15,434 tokens in / 526 out, **one** Highlight.
- ~19s per chunk; `StepResult.Continue` removed the 10s inter-tick delay.
- Card shows `qwen3-sum:latest · xayah… · 600 tok · 15.4k→526 · 5 chunks / 6 calls`.
- The same document previously went to the model as `markdown[:12000]` — about a
  fifth of it.

Green: `just lint`, `just test`, `just e2e`, `just e2e-int` (128 checks).

Two deviations from the plan above, both deliberate:

- The splitter lives in its own `pipeline/chunk.go`, not in `text.go` — `text.go`
  is about title/fence stripping and the two share only the sentence regexp.
- `out.Note` is dropped by the three steps whose reply is parsed as JSON: they
  split one reply into many Highlights, so there is no single body to disclose
  on. The cut still rides in each Highlight's provenance (`truncated`).

Found and fixed while testing: `ChunkBudget` returning 0 (a window too small for
the prompt) made `clampRunes` skip the clamp and send the whole document. It now
fails the step instead — that zero was the exact silent-overflow this replaces.

**Open, for the next pass:** the fold obeys the endpoint but not always the
style. qwen3-sum answered the folded partials in plain prose ("A new chip is
10,000 times more energy efficient…") rather than the caveman register its prompt
asks for — the step prompt was written to summarize an article, and it is now
summarizing five bullet lists. Prompt tuning, not mechanism.

# Chunked summarize

## Problem

Every LLM step throws content away, silently:

| File | Line | Cut |
|---|---|---|
| `server/internal/pipeline/step_llm_summarize.go` | 53 | `content[:12000]` |
| `server/internal/pipeline/step_llm_topics.go` | 71 | `content[:16000]` |
| `server/internal/pipeline/step_llm_321_newsletter.go` | 67 | `content[:16000]` |
| `server/internal/pipeline/step_llm_ai_newsletter.go` | 158 | `content[:16000]` |

~3–5k tokens. A long essay gets summarized from its first third and nothing says so.
The slices are also **byte** slices, so they can cut a multi-byte rune in half.

## Shape

One band router, shared by all four steps. Sizes in tokens, all from config.

```
t := EstimateTokens(doc.Markdown)

t <  chunk_above (4k)   → 1 call, the step's own model/provider      (today, minus truncation)
t <  big_above  (40k)   → chunk → map×N → reduce                     (map + reduce roles)
t <= big budget (~180k) → 1 call, big role
else                    → truncate to big budget, 1 call, footer note
```

`big_above`/`big budget` are config, not constants — the 3/4 boundary is
whatever the configured big model actually holds. Haiku is 200k, so a 1M-token
document lands in band 4 without anyone maintaining a threshold.

### Roles

Three: `map` (per chunk), `reduce` (aggregate), `big` (bands 3+4).
**Both map and reduce run on the local box** (xayah/qwen) — cheap and private.
`big` is the escape hatch and the failure fallback.

### Retry + fallback

```
for try in 1..max_tries:  call(role)        // 3
for try in 1..max_tries:  call(big)         // 3
fail
```

Linear backoff (1s × try). Context cancellation never retries. `big` has no
fallback — when it fails the step fails and the job retries from saved state.

**Reduce overflow uses the same escape hatch, not a fold.** If the collected
partials don't fit the local reduce budget, reduce runs on `big` (200k) instead.
No recursive fold code exists or is needed.

### Ticks, not a loop

`stuckJobAge = 10m` (`worker/worker.go:25`) resets any job whose `updated_at` is
older, sweeping every 60s. Twelve sequential qwen calls in one handler would
cross that and get requeued **while still running** → duplicate run, double
spend, duplicate highlights.

So: one chunk per tick. `StepResult{Done:false, NewState}` completes the current
job and enqueues a fresh one (`worker/pipeline.go:237-260`), keeping `updated_at`
fresh. State:

```json
{"phase":"map","chunks":12,"next":7,"partials":["…"]}
```

`map` ticks until `next == chunks` → `phase:"reduce"` → one tick reduces, inserts
the single Highlight, `Done:true`. Bands 1/3/4 never enter the state machine.

A chunk that exhausts all 6 attempts fails the step. The job retries and resumes
at that chunk from saved state — no partial-loss path, no half-summary.

`stepRetryDelay = 10s` + `pollInterval = 5s` would add ~12s of dead air per
chunk. New `StepResult.Continue` re-queues at `now` instead: progress is not
backoff.

### Token estimate

`EstimateTokens = RuneCount / 3`. Fixed, no calibration. 3 (not 4) covers
Hungarian and code; 33% headroom on top of the context window covers the rest.
Chunk target derives — it is not a knob:

```
budget = ctx_tokens*2/3 - max_tokens - promptTokens
```

### Truncation note (band 4)

Written by Go, never by the model, appended after `StripLeadingTitle`:

```markdown
---
*Truncated: summarized first ~180k of ~1.4M tokens (13%).*
```

## Config

`config.toml` (`[llm.summarize]`). Every step inherits; `steps.<kind>` overrides
only what differs.

```toml
[llm.summarize]
chunk_above   = 4000
big_above     = 40000
max_chunks    = 12       # exceeded → escalate to the big band, never drop content
overlap_runes = 200
max_tries     = 3

[llm.summarize.map]
provider = "xayah"
model = "qwen3:4b-instruct-ctx7k"
ctx_tokens = 7000
max_tokens = 300
prompt = "…fragment, facts only, no intro…"

[llm.summarize.reduce]
provider = "xayah"
model = "qwen3:4b-instruct-ctx7k"
ctx_tokens = 7000
max_tokens = 600
prompt = "…merge partials, dedupe, caveman…"

[llm.summarize.big]
provider = "anthropic"
model = "claude-haiku-4-5"
ctx_tokens = 200000

[llm.summarize.steps.llm_ai_newsletter]
big_above = 60000
```

`map` and `reduce` carry their **own prompts** — reusing the summary prompt on a
chunk yields twelve mini-articles that each open like an article. Empty prompt
falls back to a built-in default.

## Files

| File | Change | ~LOC |
|---|---|---|
| `config/config.go` | `SummarizeSection` + `RoleSection` + defaults + merge | 110 |
| `pipeline/text.go` | `Split(md, targetRunes, overlapRunes)`, `EstimateTokens` | 80 |
| `pipeline/llm_long.go` (new) | band router, tick state machine, retry, footer | 200 |
| `pipeline/pipeline.go` | `StepResult.Continue` | 5 |
| `worker/pipeline.go` | honor `Continue` | 5 |
| 4 step handlers | drop the slice, call `llmStepCallLong` | −20 |
| tests | split table, band boundaries, resume, retry→fallback | 180 |

No new step kind. No new UI knob. Four truncation bugs deleted.

`highlightProvenance` gains one field, `chunks int` — 0 renders exactly as today
in `app/src/HighlightDetail.tsx`; non-zero shows the chunk count. Token totals
sum across every call of the run; `model` names whoever wrote the final text.

## Splitting

Structural, in order: `##`+ headings → blank-line paragraphs → sentences → hard
rune cut. Overlap `overlap_runes` between adjacent chunks. Pure function, no LLM,
no DB — table-tested.

## Tests

- `Split`: heading-respecting, paragraph fallback, oversize single paragraph,
  CJK/multi-byte safety (never cuts a rune), overlap present, deterministic.
- `EstimateTokens`: monotonic, rune- not byte-based.
- Band router: boundary at `chunk_above`, `big_above`, big budget; `max_chunks`
  escalation.
- Tick machine: 3-chunk doc → 4 ticks → exactly 1 Highlight; resume from saved
  state after an injected mid-run failure inserts no duplicate.
- Retry: fake router failing 3× then a big-role success; assert 6 calls, 6 ledger
  rows, `model` = big.
- Footer: band 4 body ends with the note, percentages correct.
- `just e2e` green.

## Not doing

- Parallel chunk calls. The worker is single-goroutine (`worker/worker.go:55`)
  and xayah is one GPU — there is nothing to parallelize and no reason to.
- Self-calibrating token ratio from `usage.InputTokens`. Fixed ratio + headroom
  is enough; revisit if a real doc overflows.
- Recursive reduce folding. Overflow escalates to `big`.
