---
created: 2026-06-09
topic: Pipeline engine + Highlights
excerpt: Job-queue-driven Document→Highlight pipeline. extract_links + llm_summarize steps. Thorsten newsletter demo.
status: in_progress
---

# Pipeline Engine

## Goal
After a Document is scraped, matching Pipelines fire automatically. Each Pipeline has ordered Steps.
Steps are registered Go handlers (extensible). Two built-in steps: `extract_links`, `llm_summarize`.

## Q1: Pipeline config storage → DB (like Subscriptions)
Pipelines are operational config, not content. Need CRUD API (rerun button, enable/disable).
Vault is for Documents/Annotations/Notes. This matches the Subscription pattern.

## Schema additions
- `pipelines` — id, name, enabled, trigger, filter (JSON), steps (JSON array)
- `pipeline_runs` — id, pipeline_id, document_id, status, step_index, state (JSON per-step intermediate)
- `highlights` — id, document_id, pipeline_run_id, kind, body, metadata (JSON), created_at, updated_at, rev, deleted_at

## Pipeline filter (Q2)
JSON blob matched against new Document on scrape completion.
If filter is `{}` → match all. If no match → pipeline does not run.
Supported keys: `feed_url_contains`, `source_feed_id`.

## Step kinds (Q3: registered Go handlers)
- `extract_links`: parse markdown links → check DB for each → scrape missing ones → wait (polling via re-queue) → create Highlights (link_text + excerpt)
- `llm_summarize`: LLM call with document markdown → one Highlight of kind "summary"

## Fan-out/wait pattern for extract_links
step_state JSON tracks: `{phase: "waiting", pending: [{url, text, job_id}], done: [{url, text, doc_id, excerpt}]}`
Step re-queues itself with 10s delay until all pending jobs complete.

## LLM config (new config section)
```toml
[llm]
provider = "anthropic"   # or "openai_compat"
api_key = "sk-ant-..."
base_url = ""            # for openai_compat (Ollama): "http://localhost:11434/v1"
default_model = "claude-haiku-4-5-20251001"
```

## Trigger in scraper
After `handleScrapeURL` upserts Document → query enabled pipelines → for each matching → InsertJob run_pipeline.

## New job kinds
- `run_pipeline` — creates PipelineRun, enqueues first `run_pipeline_step`
- `run_pipeline_step` — executes current step, advances or re-queues

## API endpoints
- `GET/POST /api/v1/pipelines`
- `PUT/DELETE /api/v1/pipelines/{id}`
- `POST /api/v1/pipelines/{id}/run` — body: {document_id}
- `GET /api/v1/documents/{id}/highlights`
- `DELETE /api/v1/highlights/{id}`
- `DELETE /api/v1/documents/{id}/highlights`
- `GET /api/v1/documents/{id}/pipeline-runs`

## App changes
- `api.ts`: Pipeline, PipelineRun, Highlight types + API calls
- `document/[id].tsx`: right sidebar gets "Pipelines" section
  - Shows pipeline runs + status
  - Lists Highlights per pipeline run (kind badge + body)
  - Delete individual highlight button
  - "Delete all & rerun" button
  - Auto-refreshes every 3s while any run is in-progress

## Thorsten demo pipeline
```json
{
  "name": "Thorsten Newsletter",
  "enabled": true,
  "trigger": "on_new_document",
  "filter": {"feed_url_contains": "thorstenball"},
  "steps": [
    {"kind": "extract_links", "config": {}},
    {"kind": "llm_summarize", "config": {"model": "claude-haiku-4-5-20251001"}}
  ]
}
```

## Implementation checklist
- [x] Plan written
- [ ] schema.sql: 3 new tables
- [ ] queries.sql: pipeline/run/highlight CRUD
- [ ] sqlc generate
- [ ] internal/llm: interface + anthropic + openai_compat adapters
- [ ] config.go: LLM section
- [ ] internal/pipeline: step registry, extract_links, llm_summarize
- [ ] worker/pipeline.go: run_pipeline + run_pipeline_step handlers
- [ ] worker/scraper.go: trigger pipelines after scrape
- [ ] worker/worker.go: wire new job kinds + llm client
- [ ] api/pipelines.go: CRUD + run endpoint
- [ ] api/highlights.go: list/delete
- [ ] api/router.go: wire new handlers
- [ ] app/src/api.ts: new types + API calls
- [ ] app document viewer: highlights panel
- [ ] just dev (rebuild + restart)
- [ ] Create Thorsten pipeline via API
- [ ] Trigger on existing Thorsten doc
- [ ] agent-browser E2E verification
