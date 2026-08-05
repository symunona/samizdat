---
created: 2026-08-05
topic: Pipeline step config — prompts into JSON, step catalog, KV editor UI
excerpt: Move hardcoded Go prompts into pipelines.steps config JSON, expose a step-kind catalog, add a per-step key/value editor + raw JSON view on the Pipelines screen, fix summarizeFilter
status: done — squash-merged to main 2026-08-05
---

## Why

`pipelines.steps` is a JSON string of `{kind, config}`. Everything that makes a step *do*
something — the prompt — is a Go const (`topicsSystemPrompt`, `aiNewsletterSystemPrompt`,
`nl321SystemPrompt`, and the inline default in `step_llm_summarize.go:40`). The UI therefore
cannot show what a pipeline does even though it already receives the full step list, and
tuning a prompt requires a rebuild + redeploy.

Two live bugs found while scoping:
1. `summarizeFilter` (`app/app/(drawer)/pipelines.tsx:48-58`) checks `feed_id`/`tag`/`domain`/
   `url_pattern`. The real filter keys are `feed_url_contains`/`source_feed_id`/
   `exclude_feed_url_contains`/`exclude_source_feed_ids` (`pipeline.go:75-80`). Zero overlap →
   every pipeline renders **"all documents"**, the maximally wrong answer for a feed-scoped
   LLM pipeline.
2. The app's Pipelines empty state (`pipelines.tsx:306`) claims *"Pipelines are defined in YAML
   config files on the server"*. There is no pipeline YAML — they are DB rows. Stale text.

## Decisions (confirmed with user)

- **Backfill on migrate.** A one-shot data migration writes the current Go default prompt into
  every existing step's config. Behavior stays byte-identical; prompts become visible+editable
  immediately. Guarded by a `server_settings` flag so it runs once.
- **`api_key` is hidden from the UI entirely.** Not rendered, not editable. Server redacts it
  from GET responses and preserves the stored value when a PUT omits it.
- **No per-step run telemetry.** Run history keeps showing job kind only. Steps are exposed as
  a simple view + raw JSON on the Pipelines screen.

## Prompt templating

All four LLM steps compose identically today:

```go
userMsg := PROMPT [+ seen] + "\n\n# " + doc.Title + "\n\n" + content
```

So one renderer covers all of them. Placeholders:

| token                     | value                                                        |
|---------------------------|--------------------------------------------------------------|
| `{{title}}`               | `doc.Title`                                                   |
| `{{content}}`             | truncated document markdown                                   |
| `{{recently_covered}}`    | `recentlyCoveredBlock(...)` — `llm_ai_newsletter` only, else ``|

Default templates keep the legacy tail verbatim:
`<prompt>{{recently_covered}}\n\n# {{title}}\n\n{{content}}`.

**Back-compat guard:** if a stored template contains no `{{content}}`, the legacy tail is
appended automatically. A hand-typed one-line prompt therefore still works.

## Server changes

### `internal/pipeline/catalog.go` (new)
```go
type FieldSpec struct {
    Key, Label, Type string      // type: string|text|int|bool
    Default any
    Secret  bool                 // api_key — never serialized to clients
    Help    string
}
type KindSpec struct {
    Kind, Label, Description string
    Fields []FieldSpec
}
```
`Register(spec KindSpec, h Handler)` replaces `Register(kind string, h Handler)` — one registry,
spec and handler cannot drift. All 7 step files updated to pass their spec.

### Prompts
Move each `*SystemPrompt` const into its `KindSpec` default. Steps gain a `Prompt` config field
(`llm_topics`, `llm_321_newsletter`, `llm_ai_newsletter` — `llm_summarize` already has one) and
render via the shared `renderPrompt(tmpl, vars)` helper. Empty config prompt falls back to the
catalog default (safety for bare new pipelines).

### API
- `GET /api/v1/pipeline-steps` → `[]KindSpec` with `Secret` fields omitted. Bearer-authed.
- `GET /api/v1/pipelines` + `/{id}` — redact `api_key` from every step config before returning.
- `PUT /api/v1/pipelines/{id}` — merge: a step config omitting `api_key` keeps the stored value.
  Prevents the UI (which never sees the key) from wiping it on save.

### Migration (`store/open.go`)
One-shot, guarded by `server_settings.pipeline_step_prompts_backfilled`. For each non-deleted
pipeline, for each step, if the kind has a `prompt` field and config has none, insert the
catalog default. Bumps `updated_at`/`rev` so the change syncs.

## App changes

- `app/src/api.ts` — `PipelineStep = {kind: string; config: Record<string, unknown>}`,
  `parseSteps(p: Pipeline): PipelineStep[]`, `PipelineFilter` type mirroring the Go struct,
  `fetchStepCatalog()`, `putPipelineSteps()`.
- `pipelines.tsx`:
  - Fix `summarizeFilter` to the real key set; render unknown keys verbatim so a future Go-side
    key can never go invisible again.
  - Fix the false YAML empty-state string.
  - Third collapsible section **Steps** next to Recent runs / Documents. Per step: `kind` header
    (catalog label) + key/value table. Values editable (`TextInput`, multiline for `text`),
    `secret` fields not rendered. Save → PUT. Loading/disabled/error per the UI guidelines.
  - Raw JSON toggle showing pretty-printed `pipeline.steps`.

## E2E

- `e2e/smoke.js` — `/pipelines` already listed, no change.
- `e2e/integration.js` — new `runPipelineStepsUi`: seed a pipeline with a `source_feed_id`
  filter, assert the card reads the feed (not "all documents"), expand Steps, assert the prompt
  KV row shows real text, assert `api_key` is absent from the DOM, edit the model field, save,
  re-fetch and assert it persisted.
- Go unit tests: `renderPrompt` placeholder + legacy-tail fallback; the backfill migration is
  idempotent; PUT preserves an omitted `api_key`.

## Order

1. Server: catalog + Register signature + prompt extraction + renderPrompt (+ unit tests).
2. Server: endpoint, redaction, PUT merge, backfill migration.
3. App: types, catalog fetch, Steps section + editor, both bug fixes.
4. `just build`, `just lint`, `just e2e`, `just e2e-int`, agent-browser interaction check.

## Risks

- Backfill is a bulk UPDATE on `pipelines` — confirmed by user. Reversible only from a DB backup.
- `Register` signature change touches all 7 step files; a missed one is a compile error, not a
  silent failure. Acceptable.
- Prompt text is long; the KV table must not blow up the card layout — multiline field collapses
  to ~4 lines with expand.
