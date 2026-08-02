---
created: 2026-08-02
topic: Route the summarizer to a local Ollama box (xayah) as primary, Anthropic as fallback
excerpt: Pick a local model on xayah's GTX 1050 Ti, prove it summarizes real docs, make the config's default_model the model every step actually asks for, and surface per-endpoint routing counts in Settings.
status: done — qwen3:4b-instruct-ctx7k is primary, summaries served locally, Settings shows the split
---

# Local LLM as primary summarizer

## Why
Summaries are the highest-volume LLM call in the pipeline and the least demanding one.
Running them on xayah (Tailscale `100.111.210.47:11434`, 12 cores / 30 GB / GTX 1050 Ti 4 GB)
costs nothing per call and keeps credentialed content off the cloud (design rule 5).
Anthropic stays as the fallback, so a box that is asleep degrades instead of breaking.

## What exists already
- `llm.New` builds primary + `[[llm.fallback]]` chain; falls through **only** on `ErrTransport`.
- `openai_compat` client already speaks Ollama's `/v1/chat/completions`.
- `llm.Record` health registry → `GET /api/v1/llm/status` → Settings "LLM Services" card.

## The blocker (found while reading)
Every LLM step hardcodes `c.Model = "claude-haiku-4-5-20251001"` when the step config omits a
model. Point the primary at Ollama and it is asked for a Claude model → **404 from Ollama →
a 4xx → NOT ErrTransport → no fallback → the pipeline fails hard.** So "wire it in as primary"
is not a config change; the model must resolve per provider.

Also: Ollama's default context is **4096 tokens**, and the summarize step feeds up to 12 000
chars. Measured `prompt_tokens=4096` exactly on a 7 k-char doc → silent truncation. The model
needs a `num_ctx` variant; `OLLAMA_CONTEXT_LENGTH` is not set on xayah and changing it there
would hit other users of that box (workcafe).

## Steps
1. **Explore xayah** ✅ — ollama 0.21.0, models `qwen2.5:3b`, `qwen2.5:1.5b`, `nomic-embed-text`.
   GTX 1050 Ti = 4 GB VRAM → a 4B Q4 model plus an 8 k KV cache is the ceiling.
2. **Pick a model** — `qwen2.5:3b` **fails the bench**: emits `_NOT_PARSEABLE_` on two real
   English articles (would mark good Documents unparseable and kill their highlights) and
   produces Hungarian word-salad. Test `gemma3:4b` (better multilingual) at 8 k ctx; keep the
   bench script so the choice is reproducible.
3. **Bench the real prompt** — the actual `step_llm_summarize` prompt against real rows from
   `~/.samizdat/app.db`: one English, one Hungarian, one long. Judge: no false
   `__NOT_PARSEABLE__`, ≤3 bullets, no echoed title, readable Hungarian, wall time.
4. **Wire as primary**
   - `llm.Usage` gains `Model` — the model that actually served, so `llm_usages` and the Jobs
     model badge stop recording a model that was never called.
   - Each single client carries its section's `DefaultModel` and fills in an empty model
     (anthropic keeps its haiku default). Steps stop hardcoding Claude and pass `""` through.
   - The fallback chain already overrides per-entry models — the primary entry now resolves
     through its own client, so a chain of Ollama → Anthropic asks each for its own model.
   - `config.toml`: `[llm]` → `openai_compat` @ xayah with the chosen model; `[[llm.fallback]]`
     → anthropic/haiku. `config.example.toml` documents the pattern.
5. **Show the routing split in Settings** — per-endpoint rows exist but the usage line is keyed
   by provider *name*, so two `openai_compat` boxes collapse into one. Key the routing count by
   the health registry's per-endpoint `calls`, and show each row's **share of all calls** plus
   the model that served, so "how much went local" is answerable at a glance.
6. **Settings screen spacing** — text overlaps in the provider head row (name / role / model on
   one line, no wrap budget). Screenshot, fix, screenshot again.

## Tests (write before implementing)
- `server/internal/llm/*_test.go`: model resolution — empty model + section default → default;
  explicit model wins; fallback entry overrides; anthropic with neither → haiku.
- Bench script output pasted into this plan (model choice must be defensible).
- `just e2e` green + agent-browser screenshot of Settings showing the local row with its share.
- End-to-end: enqueue a real summarize job with the local primary and assert a Highlight lands
  with `metadata.model` = the local model.

## Bench results (real `Summarizer` prompt from the pipelines table, real Documents)

The GPU is the constraint: 4 GB, so the model + its KV cache must fit or throughput halves.
`ollama ps` prints the split; the chosen size is the largest that stays **100% GPU**.

| model | ctx | `ollama ps` | wall/doc | verdict |
|---|---|---|---|---|
| qwen2.5:3b | 4096 | — | 6-9 s | **rejected** — emits `_NOT_PARSEABLE_` on two real English articles (would flag good Documents), Hungarian output is word-salad |
| gemma3:4b | 8192 | 44%/56% CPU/GPU | 20-22 s | good English, but answered a **Hungarian** football piece **in Portuguese** |
| gemma3:4b | 6144 | 44%/56% CPU/GPU | — | still spills — gemma3's KV cache is too big for this card |
| qwen3:4b (thinking) | 7168 | **100% GPU** | 17-223 s | correct, but burns 300-3800 hidden reasoning tokens; `/no_think` does not stop it |
| qwen3:4b (thinking) | 8192 | 16%/84% CPU/GPU | ~52 s | spills |
| **qwen3:4b-instruct** | **7168** | **100% GPU (4.0 GB)** | **17-36 s** | **chosen** — accurate, keeps the source language, no false flags, no thinking tax |

Live proof: retried the dead summarize jobs → 4 Highlights written with
`metadata.model = qwen3:4b-instruct-ctx7k`, `llm_usages.provider = openai_compat`,
and the feed renders real summaries (`tmp/feed-local-summary.png`).

## What shipped

- **Model resolution moved into the client** (`newSingle` → `defaultModel`), `Usage.Model`
  reports what ran, `pipeline.servedModel` logs it. The four LLM steps no longer hardcode
  a Claude id. Covered by `server/internal/llm/model_test.go`.
- **`routed_share`** per endpoint in `GET /api/v1/llm/status` → the Settings row reads
  `4 calls · 100% routed here`. New `just e2e-int` check asserts the 80/20 split.
- **Settings spacing**: `cardSubtitle` cancelled the card's `gap` with a negative margin,
  which collapsed title onto subtitle in every card whose pair sat inside a header column
  (YouTube Proxy, Export Vault, Background Polling, Transcript Languages, …). Replaced with
  a `titleGroup` wrapper + explicit line heights.
- **Pipelines re-routed** (backup: `tmp/pipelines-backup-2026-08-02.json`): the two
  `llm_summarize` pipelines dropped their pinned `claude-haiku` model → they inherit the
  local primary; `llm_topics` / `llm_ai_newsletter` / `llm_321_newsletter` gained an
  explicit `provider: anthropic` pin, since verbatim section-splitting and structured JSON
  are past what a 4B does well.

## Risks / open
- xayah asleep → every summarize pays the 90 s transport timeout before falling back to
  Haiku. Not shortened: the shared timeout also covers slow legitimate local generations.
- **Anthropic has no credits right now** (`Your credit balance is too low`), so the
  anthropic-pinned newsletter/topics steps still fail — that is the pre-existing state, not
  a regression. The fallback leg is equally dead until the balance is topped up; the local
  primary is what is keeping summaries working.
- A 4B stays a 4B: expect thinner summaries than Haiku, and watch for language drift on
  non-English sources (qwen3-instruct held the source language in every bench doc, gemma3
  did not).
