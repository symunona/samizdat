---
created: 2026-08-10
topic: LLM provenance on highlights — model + params that actually ran
excerpt: One helper records what model/provider/params served an LLM step, stores it in highlights.metadata, and the app shows it under the highlight body.
status: done
---

# Highlight LLM provenance

## Problem

A summary highlight says nothing about how it was made. `highlights.metadata` already
carries `{"model": "..."}` (written identically in four LLM steps), but:

- provider, token counts and call params are missing — and params (`max_tokens`,
  `temperature`) don't exist at all: `anthropic.go` hardcodes `MaxTokens: 4096`,
  `openai_compat.go` sends none.
- nothing in the app ever reads `metadata`.
- the same ~15 lines (`InsertLLMUsage` + `json.Marshal(map[string]string{"model": model})`)
  are copy-pasted in `step_llm_summarize`, `step_llm_topics`, `step_llm_321_newsletter`,
  `step_llm_ai_newsletter`.

## Rules this must respect

- **Provenance goes in `highlights.metadata`, never in `body`.** Body is markdown that
  syncs to the app, exports to the vault and the user edits; appending provenance there
  duplicates on regenerate and gets eaten on edit.
- **Record what RAN, not what was asked** — the existing `servedModel()` doctrine
  (`pipeline.go:140`). A pinned step config may name no model (provider default) and the
  fallback chain may serve another provider entirely. Same for params: the adapter echoes
  the values it actually sent.
- `llm_usages` stays the append-only ledger; highlight metadata is the display copy. No
  merge.
- No dead knobs: a param is only added if a step config can set it and the app can edit it.

## Design

### 1. `llm`: params are first-class

```go
type Params struct {
    Model       string
    MaxTokens   int      // 0 = adapter default
    Temperature *float64 // nil = provider default
}
type Route struct { Provider string; Params Params }
type Client interface { Complete(ctx, Params, []Message) (string, Usage, error) }
```

`Usage` grows `MaxTokens int` + `Temperature *float64`, filled by the adapter with the
**effective** values (anthropic: 4096 when unset; openai_compat: omitted fields stay unset
so the box's own default is reported as "not set", not as a lie).

Call sites: `Router.Complete/CompleteRoute`, `fallbackClient`, `probe.go:167`, the four
steps, tests. Contained — nothing outside `llm` builds a `Client`.

### 2. `pipeline`: one provenance helper

`server/internal/pipeline/llm_provenance.go`

```go
// recordLLMCall writes the llm_usages ledger row and returns the JSON to store in
// highlights.metadata.
func recordLLMCall(ctx context.Context, q *store.Queries, run store.PipelineRun,
    kind string, req llm.Params, u llm.Usage, prompt string) string
```

Metadata shape (all optional on read — old rows carry `{"model": …}` only):

```json
{"model":"qwen3:4b-instruct-ctx7k","provider":"ollama-xayah","step":"llm_summarize",
 "max_tokens":4096,"temperature":0.4,"tokens_in":5120,"tokens_out":180,
 "prompt_sha":"a3f19c2d","at":"2026-08-10T09:12:00Z"}
```

`prompt_sha` = first 8 hex of sha256 of the prompt TEMPLATE (not the rendered message —
that carries the article and would differ per document) — enough to tell "this summary
predates the prompt change" without storing the prompt on every row.

`provider` prefers the step's PINNED provider id: a pin never falls back, and
`localhost:11434` says which box where the adapter's `openai_compat` says only which
protocol. The ledger row keeps the transport name (`llm_status` aggregates spend by it).

Replaces the four copy-pasted blocks.

### 3. Step config

Two new fields on the four LLM step kinds, via a shared `llmCommonFields()` so they can't
drift: `max_tokens` (`int`) and `temperature` (`float`). `float` is a new `FieldSpec.Type`
— `catalog.go` doc comment, plus `FieldType`/`SPEC_TYPES`/parse+`inputMode` in
`app/app/(drawer)/pipelines.tsx` (which already handles `int` the same way).

Unset = today's behavior exactly.

### 4. App

- `parseHighlightMetadata()` in `api.ts` next to `parseMediaMetadata` (same try/catch
  shape, takes the field not the row).
- `HighlightDetail`: one dim line under the body sheet —
  `qwen3:4b-instruct-ctx7k · ollama-xayah · 4096 tok · t 0.4 · 5.1k→180`. Missing fields
  are skipped, an empty parse renders nothing (old highlights, hand-made notes).
- Feed cards stay clean — provenance lives in the "more" overlay only.

## Test plan (write first)

1. `go test ./server/...` — new: adapter echoes params into `Usage`; `recordLLMCall`
   returns the fields and writes one ledger row; a fallback-served call reports the
   fallback's provider/model, not the requested one.
2. `just lint` + `just build`.
3. `just e2e` (smoke stays green).
4. **agent-browser interaction** (`just robot-browser`): open feed → open a summary
   highlight's "more" overlay → assert the provenance line is VISIBLE and names the model
   that the API says served it. Then open a highlight whose metadata is `{}` and assert no
   empty/blank line renders.

## Steps

1. plan commit on `main`, branch `feat/highlight-llm-provenance`.
2. `llm`: `Params`, `Route.Params`, `Client` signature, adapters echo effective params.
3. `pipeline`: `llm_provenance.go`, rewire the four steps, `llmCommonFields()`.
4. app: parse + detail footer + `float` field type.
5. tests, lint, build, e2e, agent-browser.
6. squash-merge after the user checks.

## Outcome

All six steps done. Two things only the real UI could have caught:

1. **`max_tokens` matched the credential name test** (`token`), so the server stripped it
   from every read path and the field never rendered — the knob would have been silently
   undroppable-into-config. Fixed with an exact-match exemption on both sides
   (`notCredentialRe` / `NOT_SECRET_KEY`), with tests.
2. **The transport name is not an endpoint.** The first real run wrote
   `provider: "openai_compat"`, which does not say which box. Pinned steps now record the
   provider id.

Verified: `go test ./internal/...`, `just lint`, `just e2e`, `just e2e-int` (128 checks,
twice), and a real summarize run driven through the app — params set in the step editor,
seen on the wire, rendered as `qwen3:4b-instruct-ctx7k · localhost:11434 · 512 tok · t 0.3
· 5.1k→180` under the overlay body. The xayah Ollama box was unreachable and the Anthropic
key is invalid, so the run went to a local stub rather than spending OpenRouter credit.

Also fixed en route: `ann panel: re-opening a saved mark shows its stored anchor too` was
intermittently failing on main — it clicked whichever mark rendered first. It now tracks
the mark it just saved.
