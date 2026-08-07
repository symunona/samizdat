---
created: 2026-08-07
topic: One inbound address, many pipelines — route a Document to a pipeline by filter
excerpt: A multi-theme newsletter lands on one address. Widen the pipeline filter to match Document fields (free, deterministic), then add a `route` step kind that classifies with a local LLM and enqueues the chosen pipeline. `trigger=on_route` keeps routed pipelines out of the fan-out.
status: planned — not started
---

# Inbound email router

## Why

One personal subscription, one `@sam.tmpx.space` address, several unrelated themes in
the same mail stream. Today every enabled pipeline with `trigger=on_new_document` is
asked `MatchesDocument`, and the filter only knows *which feed* the Document came
from — so a single address can only ever get a single treatment (or N treatments, all
of them, every time).

Wanted: one address → decide per message → run the pipeline that fits.

## What already exists

`newsletterTriggerPipelines` (`server/internal/api/newsletter.go:268`) is already a
router: it lists enabled pipelines, skips `Trigger != "on_new_document"`, calls
`pipeline.MatchesDocument`, enqueues a `run_pipeline` job per match. Two things are
missing — content predicates, and a semantic decision. Nothing about the shape needs
replacing.

`PipelineFilter` (`server/internal/pipeline/pipeline.go:73`) knows `source_feed_id`,
`feed_url_contains`, and their exclude lists. That is the whole vocabulary.

## Layer 1 — deterministic router: widen the filter

Add Document-field predicates. For an email Document, `Title` is the Subject and
`Author` is the From header (set at `newsletter.go:96`), so subject/sender routing
needs no new columns.

```go
type PipelineFilter struct {
    FeedURLContains      string   `json:"feed_url_contains"`
    SourceFeedID         string   `json:"source_feed_id"`
    ExcludeFeedURLs      []string `json:"exclude_feed_url_contains"`
    ExcludeSourceFeedIDs []string `json:"exclude_source_feed_ids"`
    TitleMatches         string   `json:"title_matches"`   // regex against doc.Title
    AuthorContains       string   `json:"author_contains"` // substring, doc.Author
    BodyContains         []string `json:"body_contains"`   // any-of, lowercased substring
}
```

`MatchesDocument` gains three checks in the same style as the existing ones. A bad
regex in `title_matches` must not match everything — compile it, and on error return
`false` plus a warn log (silent-match-all would fan a personal pipeline over the whole
inbox).

Setup then is: one Feed (one address), N pipelines all filtered
`source_feed_id: <that feed>`, each with its own `title_matches`. Fan-out is the
router. Zero LLM cost, and a mail matching two themes legitimately runs both.

This covers most real newsletters — themes usually carry a stable subject prefix or a
recognizable sender.

## Layer 2 — semantic router: a `route` step kind

For themes regex cannot name. One router pipeline is the only thing matching the feed;
its single step classifies, then dispatches.

```
Feed (one address)
  ├─ Pipeline "inbox router"     trigger=on_new_document  filter={source_feed_id}
  │    step[0] = route { provider:"ollama", model:"", routes:[
  │        {label:"ai",       pipeline_id:"…", hint:"AI / ML news"},
  │        {label:"politics", pipeline_id:"…", hint:"domestic politics"},
  │        {label:"drop"}                     // no pipeline_id = discard
  │    ]}
  ├─ Pipeline "ai breakdown"     trigger=on_route
  └─ Pipeline "politics digest"  trigger=on_route
```

Handler (`server/internal/pipeline/step_route.go`), registered via `Register` like
every other kind so the config editor renders it for free:

1. Load the Document for `run.DocumentID`.
2. Rule pass first: walk `routes`, and if a route carries `title_matches` /
   `author_contains`, use it. A hit costs nothing.
3. No hit → one LLM call: labels + hints + Title + first ~1500 chars of Markdown →
   `{"label": "..."}`. Never the whole body.
4. Resolve label → `pipeline_id`. Unknown label or empty `pipeline_id` → done, no
   dispatch (that is how `drop` works).
5. `q.InsertJob(Kind: "run_pipeline", Payload: {pipeline_id, document_id,
   pipeline_name, document_title}, ParentJobID: pipeline.ParentJobIDFromCtx(ctx))`.
6. `return StepResult{Done: true, NewState: {"route":"ai","by":"llm"}}`.

### Why this shape

- **`trigger` is the guard.** The fan-out already skips `Trigger != "on_new_document"`,
  so routed targets get `trigger=on_route` and can never self-fire. Existing column,
  existing branch, no migration.
- **Dispatch via a `run_pipeline` job, not inline execution.** The child then goes
  through `handleRunPipeline` (`server/internal/worker/pipeline.go:37`) and inherits
  the false-parse gate, the content-hash skip guard, the supersede +
  `RegenerateCascade` on re-trigger, job parentage and cost metering. A router that
  ran steps itself would silently lose all five.
- **The decision is persisted** in `pipeline_runs.state`, so the Jobs UI shows why a
  mail went where it did, and a rerun re-routes deterministically.
- **Local provider by default.** Personal mail classification is exactly design rule 5;
  route it at `ollama` (xayah) and the per-message cost is zero.

## Order of work

1. Layer 1: `PipelineFilter` fields + `MatchesDocument` checks + unit tests (bad regex,
   author substring, any-of body). Filter editor fields in the app.
2. Layer 2: `step_route.go` + `KindSpec`, `on_route` accepted as a `trigger` value,
   fan-out unchanged.
3. Wire the real subscription: one Feed, one router pipeline, two target pipelines.

Layer 1 stands alone and is worth shipping even if Layer 2 never happens.

## Touchpoints

- `server/internal/pipeline/pipeline.go` — `PipelineFilter`, `MatchesDocument`
- `server/internal/pipeline/step_route.go` — new
- `server/internal/api/newsletter.go:268` — unchanged (the guard already reads `trigger`)
- `server/internal/api/` pipeline CRUD — allow `on_route` in the trigger whitelist
- `app/` pipeline editor — three filter fields + the routes table
- `pipelines.trigger` is TEXT — no schema migration

## Tests

- Unit: `MatchesDocument` over each new predicate, incl. an uncompilable regex → no match.
- Unit: `route` handler picks by rule before calling the LLM; unknown label → no job;
  `drop` → no job; hit → exactly one `run_pipeline` job with the right `pipeline_id`.
- E2E (`e2e/integration.js`): POST two mails to `/api/v1/inbound/email` with different
  subjects on the SAME token, drain jobs, assert each produced highlights from a
  *different* pipeline — and assert the router pipeline itself produced none.
- `just e2e` green, and the interaction test drives the filter editor in the app, not
  just the API.
