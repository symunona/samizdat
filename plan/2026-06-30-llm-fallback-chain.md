---
created: 2026-06-30
topic: LLM transport-only fallback chain (primary → ordered fallbacks)
excerpt: Wrap the provider-agnostic llm.Client in an ordered fallback chain. When the primary provider (e.g. a local Ollama that dies) fails at the transport level — connection refused, timeout, DNS, or 5xx — try the next configured provider (e.g. Anthropic Haiku). Real API errors (4xx) propagate immediately without burning fallbacks.
status: in-progress
---

# LLM transport-only fallback chain

## Goal

Run a local Ollama (`openai_compat`) as primary; when it dies, transparently fall back
to Anthropic Haiku — with **no per-call-site changes**, since every pipeline step already
calls a single `llm.Client.Complete(...)`.

Only fall through on **transport failures** (the local box being down), not on real API
errors (bad request / auth / 4xx) — those should surface so we don't mask bugs or waste a
cloud call on a request the primary correctly rejected.

## Design

### Chokepoint
`llm.Client` is the single interface; `llm.New(cfg)` builds it; the global client is wired
once in `api/router.go` and threaded through every pipeline step. Wrapping `New()`'s return
in a chain client requires zero changes to the steps.

### Transport sentinel
`var ErrTransport = errors.New("llm: transport failure")`. Adapters wrap an error with it
**only** when:
- `httpClient.Do(req)` returns a non-nil error (conn refused / timeout / DNS), or
- the response status is `>= 500` (transient server-side).

A `4xx` is a real error → NOT `ErrTransport` → propagates immediately. (429 is intentionally
*not* treated as transport: a cloud fallback won't fix a local 429, and Ollama rarely 429s.)

### Chain client
`fallbackClient{ entries []entry }`, each `entry{ client Client; model string }`. `Complete`
tries each entry in order; on `nil` error returns; on `ErrTransport` continues to the next;
on any non-transport error returns immediately; respects `ctx.Err()` (no fallback on cancel).

### Model override per entry — the key subtlety
The caller (a pipeline step) always passes a concrete `model` string (steps default to
`claude-haiku-4-5-20251001`). That tier model is meaningful for the **primary**, but a
**fallback** on a *different* provider can't run the primary's model name (Ollama can't run
`claude-*`; Anthropic can't run `llama3.1`).

Resolution:
- **Primary entry:** `model = ""` → **respects the caller's model** (preserves tier routing
  triage→Haiku / breakdown→Sonnet / digest→Opus). If you run Ollama as primary you must set
  the pipeline step's `model` (or the provider's `default_model`) to an Ollama model name —
  this is already true today and is a config concern, not code.
- **Fallback entries:** `model = entry.DefaultModel` → **overrides** the caller's model, since
  the tier model won't exist on the fallback provider. Each `[[llm.fallback]]` block must set
  `default_model` (e.g. `claude-haiku-4-5-20251001`).

Note: `LLMSection.DefaultModel` is currently **dead config** (nothing reads it). This change
gives it a real meaning for fallback entries — the cleanest available semantics, no new field.

Rejected alternative: also overriding the primary with its own `default_model`. That would
discard the step's tier model and break tier routing, so primary stays caller-driven.

### Config shape
```toml
[llm]
provider      = "openai_compat"
base_url      = "http://localhost:11434/v1"
default_model = "llama3.1"          # set the step model to an Ollama model when Ollama is primary

[[llm.fallback]]
provider      = "anthropic"          # api_key from ANTHROPIC_API_KEY env
default_model = "claude-haiku-4-5-20251001"
```

`New()` returns the single client unchanged when there are no fallbacks (no behavior change),
or a `fallbackClient` when `Fallback` is non-empty.

## Files
- `server/internal/config/config.go` — add `Fallback []LLMSection` to `LLMSection`.
- `server/internal/llm/llm.go` — `ErrTransport`, `transportErr` helper, `entry`,
  `fallbackClient`, refactor `New()` → `newSingle()` + chain assembly.
- `server/internal/llm/anthropic.go` — wrap `Do()` error + `>=500` with `ErrTransport`.
- `server/internal/llm/openai_compat.go` — same.
- `server/internal/llm/fallback_test.go` — stub-client tests: falls through on transport,
  propagates on non-transport, returns last error when all fail.
- `config.example.toml` — documented `[[llm.fallback]]` example (config.toml is gitignored).

## Verification
- `go test ./internal/llm/...` — chain unit tests green.
- `just build` green; `just lint-go` clean (logger, not stdlib `log`).
- Redeploy: `just build` then `just restart` (user systemd `samizdat-sam`); confirm active.

## Status log
- 2026-06-30: plan written.
