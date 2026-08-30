---
created: 2026-08-30
topic: LLM step failures — stale xayah model, silent output truncation, JSON shape drift
excerpt: Four pipelines pin a model deleted from xayah; truncation at max_tokens is never detected and surfaces as a JSON parse error; a 4B model drops the JSON wrapper.
status: shipped on branch fix/llm-truncation-and-stale-model; verified live
---

# Diagnosis (2026-08-29/30)

Three independent faults chained into "xayah summarizer broken":

1. **Stale model id.** 4 pipelines in `app.db` pin `qwen3:4b-instruct-ctx7k`, deleted from
   xayah (renamed `qwen3-sum:latest`). `config.toml` was updated, the DB rows were not.
   `roleConfig` overrides provider/model with the map/reduce role, so only the
   **single-call small band** (doc < `chunk_above`) uses the step's own model → 404 ×3 →
   silent escalation to Anthropic. Local box bypassed, Anthropic billed.
2. **Silent output truncation.** No adapter reads `finish_reason`/`stop_reason`. A reply cut
   at `max_tokens` returns as a normal reply and dies in `json.Unmarshal` three attempts
   later as `unexpected end of JSON input`. Job `461fce04`: `out=1024` exactly, 3×.
3. **JSON shape drift.** qwen3-sum returns a bare top-level array instead of
   `{"highlights":[...]}` → `cannot unmarshal array into pipeline.nl321Response`.

Plus a band dead zone: docs of 12000–12640 runes estimate over `chunk_above` (4000 tok =
12000 runes) but split into 1 chunk (map target 12640 runes), so `planRun` returns nil and
`singleCall` escalates to Big for no reason.

# Work items

- [x] 1. Repointed the 4 pipeline rows to `qwen3-sum:latest` (backup
      `~/.samizdat/app.db.bak-stalemodel-2026-08-30`). Latency at correctly-sized inputs
      is 3–11s, far under the 10-minute `stuckJobAge` ceiling.
- [x] 2. `Usage.Truncated` from `stop_reason`/`finish_reason`; JSON steps fail fast naming
      the cap and the config key; `llm_summarize` keeps the note-disclosure path.
      Provenance key `output_truncated`, kept distinct from the input-clamp `truncated`.
- [x] 3. Answered, not built. Constrained decoding is the right destination for SHAPE:
      measured on xayah (Ollama 0.32.7), `response_format: json_schema` holds the wrapper
      even when the prompt demands a bare array. It is NOT a retry loop — the sampler masks
      violating tokens. It does NOT fix LENGTH: schema-constrained output at `max_tokens=40`
      still returns `finish_reason: length` and unparseable JSON. So item 2 is not redundant.
      Deferred: `Params.Schema` for openai_compat only, once a second case asks for it.
- [x] 4. Closed. `planRun` returns an explicit band; `singleCall` no longer re-derives one.
- [x] 5. `DecodeLLMList` tolerates a bare top-level array and folds in the fence-stripping
      that was copy-pasted into three handlers.
- [x] 6. `sam llm check` validates every pinned pipeline model against what its provider
      serves, exits non-zero on mismatch. Verified by planting a bogus pin.

# Measured on 2026-08-30, worth keeping

- **`EstimateTokens` (runes/3) under-counts by up to 1.76x** on newsletter markdown.
  Real document: 3000 runes = 983 real tokens (3.05 runes/tok), but 18000 runes = 10546
  real tokens (1.71). Cause: **76% of that document is ConvertKit tracking URLs**, which
  tokenize far denser than prose. `chunk.go` claims runes/3 is "wrong in the safe
  direction" — for this corpus it is wrong in the DANGEROUS direction.
- **`qwen3-sum:latest` really holds 12288 tokens, not the 7168 `ctx_tokens` declares.**
  The two errors currently cancel: chunks sized off the under-declared 7168 land at
  ~7100 real tokens and fit. **Correcting `ctx_tokens` to 12288 alone would BREAK it** —
  chunks would reach ~12800 real tokens and 400. Fix the estimator first.
- **This Ollama errors on overflow rather than truncating silently**:
  `exceed_context_size_error ... request (13594 tokens) exceeds the available context
  size (12288 tokens)`. The repo docs' "answers confidently about whatever survived"
  warning is stale for 0.32.7 — still true for the `num_ctx` default, not for overflow.
- Biggest untaken win: **strip tracking URLs from newsletter markdown at ingest.** Three
  quarters of every such document is link noise being paid for as tokens on every call.

# Round 2 (2026-08-30): the fabrication bug

map->reduce was applied to EVERY step. For the steps whose prompt says "verbatim"
that guarantees invention: the fold only ever sees five-bullet chunk summaries.

Confirmed on the James Clear 3-2-1 issue — it produced a Dolly Parton quote she
never said, and gave Carl Jung a Steve Jobs line. Both real people. Contained: the
vault dir was empty, so nothing exported to Obsidian.

- [x] `partition` strategy: step's own prompt per chunk, union the results, no fold.
      Default for every kind; `llm_summarize` opts out.
- [x] `CompactForLLM` strips tracking links before the band is chosen.
      doc321: 23238 -> 6651 runes, 7746 -> 2217 est tokens, so it no longer chunks.
      Image targets (incl. `/api/v1/media/<id>`) are left byte-identical — the vault
      export keys on them.
- [x] `DecodeLLMList` takes the first complete JSON value, ignoring trailing noise.
      A single stray `}` after a valid six-item array had thrown away six correct
      verbatim highlights.
- [x] Verified end to end: re-ran the pipeline, **6/6 Highlight bodies now appear
      verbatim in the source document**. The fabricated rows were tombstoned by
      `rerun`'s own subtree semantics, not by a manual delete.

Still open: `last_error` is not cleared on a successful retry, so a `done` job can
display a stale failure. A truncated `map` chunk still records no provenance.