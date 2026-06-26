---
created: 2026-06-26
topic: Expose LLM model/provider on the jobs panel
excerpt: llm_usages already logs provider+model+tokens per job_id; surface it in the jobs list API and render a model badge per job row.
status: awaiting-review — implemented, build+e2e green, badge verified in browser
---

# Jobs panel: show which model ran behind each job

## Context
- Investigating glued-bold render bug → discovered HTML→md is pure Go (`trafilatura` + `html-to-markdown/v2` commonmark), **no LLM**. Bold gluing is a converter spacing bug (separate follow-up, not in scope here).
- LLM only runs in pipeline steps (`step_llm_summarize.go`, `step_llm_*_newsletter.go`). Each logs `provider`, `model`, tokens into `llm_usages` keyed by driving `job_id`.
- Gap: model/provider never surfaced. `jobs.go:get` computes `llm_cost_usd` but drops model; list/page returns plain `store.Job`.

## Scope (this branch)
Surface existing `llm_usages` data on the jobs panel. No new logging needed — already logged.

## Steps
1. **Query** — add `GetLLMUsageByJobs` (batch, `json_each` over job_id list) → rows of `job_id, provider, model, input_tokens, output_tokens`. `queries.sql` + `sqlc generate`.
2. **List API** (`jobs.go`) — build `map[job_id][]usage`, attach to each job. New response struct: each item carries `llm: [{provider, model, input_tokens, output_tokens, cost_usd}]` + `llm_cost_usd`. Apply to both legacy flat + paginated paths.
3. **Detail API** (`jobs.go:get`) — add `llm` array alongside existing `llm_cost_usd`.
4. **Frontend** (`jobs.tsx`) — render a compact model badge (e.g. `opus` / `sonnet` / `haiku`, shortened) on rows that used LLM; keep existing cost display.
5. **Build** — `just build`. **e2e** — `just e2e` (jobs page already in PAGES).

## Out of scope / follow-up
- Glued-bold fix in `scraper.go` (commonmark converter spacing) — separate branch.
