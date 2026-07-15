---
created: 2026-07-15
topic: Idempotent scrape-job enqueue + retry-in-place + URL grouping in Jobs UI
excerpt: Stop duplicate scrape_url job rows from extension double-pin / reader re-add; make re-add retry the existing row; group same-URL jobs together in the Jobs screen.
status: planning
---

# Scrape-job dedup, retry-in-place, and URL grouping

## Problem (observed)
User saw the same scrape job ("RTX 5090, Mac Studio, or DGX Spark? I tried all three.")
appear **twice** in the Jobs list, not grouped together. Root cause:
- `POST /api/v1/jobs` (`jobsHandler.create`) does **no dedup** — always `InsertJob` with a
  fresh UUID. Shared by extension pin (`clipper/src/background.js:120`), reader add, and
  "re-add to try again". So a second submit = a second row.
- Document/scrape dedup (canonical_url, design rule 3) only prevents a duplicate **Document**
  when the job *runs*; it does not stop a duplicate **job row**.
- Jobs list sorts `ORDER BY updated_at DESC` and the UI groups by `parent_job_id` lineage,
  NOT by URL → two independent same-URL rows land apart.

## Goals (all three, user-confirmed)
1. **Idempotent enqueue (server).** Same URL submitted while a job is live or failed must not
   create a second row. Covers extension double-pin, reader re-add, manual re-add.
2. **Retry uses the retry path, not re-add.** Re-adding a *failed* URL retries the existing
   row in place (bumps it to top) instead of minting a new one. (The Jobs screen already wires
   `retryJob`; this makes the *other* enqueue paths behave the same.)
3. **Group same-URL jobs in the UI.** Any same-URL scrape jobs (e.g. a historical done + a new
   run, or legacy duplicates) render together under one URL header.

## Design

### Server — idempotent `create` (goals 1 + 2)
Rework `jobsHandler.create` (`server/internal/api/jobs.go:22`). Before inserting, look up the
latest non-deleted `scrape_url` job for the URL:
- **active** (`queued`/`running`/`paused`) exists → return that job id (HTTP 202, `deduped:true`).
  No insert. ← fixes double-pin.
- no active, latest is **dead** → `RetryJob` it in place (status→queued, bump run_after/updated_at)
  and return its id. ← fixes "re-add to retry" = same row, bumps to top.
- no active, latest is **done** → return existing id, do NOT re-scrape (honors "scrape once").
  A deliberate re-scrape stays the job of `POST /jobs/{id}/rerun` (unchanged escape hatch).
- nothing → `InsertJob` as today.

New store query `GetLatestScrapeJobForURL` (id + status, `ORDER BY updated_at DESC LIMIT 1`,
`json_extract(payload,'$.url') = ?`, `deleted_at IS NULL`). Reuse existing `RetryJob`.
URL match is on the raw submitted URL (same key both submits use); canonical normalization at
scrape time is unchanged.

### Client — Jobs screen URL grouping (goal 3)
In `app/app/(drawer)/jobs.tsx`: for top-level `scrape_url` jobs, group roots that share the same
`parsePayload(payload).url` under a single collapsible URL header (extend the existing grouping,
which currently keys on `parent_job_id` lineage). Keep the existing retry/rerun row actions.
No change needed to the reader add flow beyond server idempotency; `ScrapeQueueContext` already
keys entries by url locally.

### Extension
No code change — `clipper/src/background.js` already `POST`s the same `/jobs` endpoint, so server
idempotency covers double-pin automatically. (Add an e2e asserting it.)

## E2E self-test (write first — `e2e/`)
1. `POST /jobs {url:U}` twice → second returns same `job_id`, `GET /jobs` shows **one** active
   scrape row for U.
2. Force a job to `dead` (or use a URL that fails) → `POST /jobs {url:U}` → **same** id, status
   back to `queued`, still one row.
3. `POST /jobs {url:U}` when U already `done` → returns existing id, no new row, no re-scrape.
4. UI: seed two same-URL scrape roots (legacy path) → Jobs screen renders them under one URL
   group. Drive in browser (robot device), assert the single header.

## Steps / commits
1. plan → main (this file).
2. branch `feat/scrape-job-dedup`.
3. server: `GetLatestScrapeJobForURL` query + sqlc gen; idempotent `create`; unit/e2e. `just dev` restart.
4. client: URL grouping in jobs.tsx.
5. e2e: extend `e2e/` with the four assertions; `just e2e` green.
6. lint + `just build`; drive Jobs screen in browser (robot device).
7. ask user to check → squash-merge.

## Open questions
- Response shape for a deduped submit: reuse `{job_id}` + add `deduped:true`? (App ignores extra
  fields; clipper only checks status.) → yes, additive.
- Should a `done`-URL re-add surface "already scraped → open document" in the reader? Out of scope
  here; server returns existing id, UI behavior unchanged for now.
