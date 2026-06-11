---
created: 2026-06-11
topic: LLM Usage Tracking
excerpt: Track tokens/cost for every LLM call; expose per-job cost on API; total cost in Settings screen.
status: in-progress
---

## Goal

- `llm_usages` table — append-only audit log; NEVER empty/reset
- Track input/output tokens for every LLM call in pipelines
- Static pricing file (`pricing.go`) with current Anthropic prices
- Per-job cost on job API (`llm_cost_usd`)
- Total LLM usage/cost on Settings API + Settings screen

## Pricing (as of 2026-05-26)

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| claude-haiku-4-5 | $1.00 | $5.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| claude-opus-4-8 | $5.00 | $25.00 |
| claude-fable-5 | $10.00 | $50.00 |

## Changes

1. `server/internal/llm/pricing.go` — static pricing map + `EstimateCost()`
2. `server/internal/llm/llm.go` — `Usage` struct; change `Complete()` → `(string, Usage, error)`
3. `server/internal/llm/anthropic.go` — parse `usage` field from response
4. `server/internal/llm/openai_compat.go` — parse `usage` field from response
5. `server/internal/store/schema.sql` + `open.go` — add `llm_usages` table
6. `server/internal/store/queries.sql` — `InsertLLMUsage`, `GetLLMUsageTotals`, `GetLLMUsageByJob`
7. Run `just server::gen` to regenerate sqlc
8. `step_llm_summarize.go` + `step_llm_ai_newsletter.go` — record usage after each call
9. `server/internal/api/settings.go` — add `LLMUsage` to settings payload
10. `server/internal/api/jobs.go` — add `llm_cost_usd` to job get response
11. `app/src/api.ts` — extend `AppSettings` + `Job` types
12. `app/app/(drawer)/settings.tsx` — LLM Usage card
