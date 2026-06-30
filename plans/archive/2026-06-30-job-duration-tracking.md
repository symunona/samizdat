---
created: 2026-06-30
topic: Persist + surface job duration (capture/download time)
excerpt: Worker already measures per-attempt elapsed but only logs it. Persist duration_ms on jobs, show it on the jobs screen, and surface the scrape duration as "Capture time" on the document metadata panel.
status: done — verified end-to-end (jobs ⏱ + doc Capture time live)
---

# Job duration tracking

## Why
Worker times every attempt (`worker.go:174` start → `:199` elapsed) but only
logs `done in <elapsed>`. Nothing persisted → not queryable, not in UI.

## Design
Keep timing on the **jobs** table (pure runtime state, never in the vault — so
this does NOT violate "DB reconstructable from vault"). The doc panel *reads*
the originating scrape job's duration; we do NOT denormalize a `capture_ms`
onto the document row (that would put telemetry in a vault-backed row).

Link doc→job: the `scrape_url` job result already is
`{"document_id": ..., "title": ...}` → look up latest non-deleted scrape job
for the doc.

## Changes

### Server
1. `schema.sql` jobs: add `duration_ms INTEGER NOT NULL DEFAULT 0`.
2. `open.go` additiveMigrations: `ALTER TABLE jobs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0`.
3. `queries.sql`:
   - `MarkJobDone` → also set `duration_ms = ?`.
   - `MarkJobFailed` → also set `duration_ms = ?` (so a dead job shows last-attempt time).
   - new `GetScrapeDurationByDocument :one` — latest scrape_url job duration for a doc id.
4. `sqlc generate` → `store.Job` gains `DurationMs`.
5. `worker.go` → pass `elapsed.Milliseconds()` into MarkJobDone + MarkJobFailed.
6. `jobs.go` `listDescendants` raw SELECT+Scan → add `duration_ms` column + `&j.DurationMs` (hand-written, sqlc won't touch it).
7. `documents.go` `get` → wrap response `{...doc, capture_ms}` (ignore ErrNoRows → 0).

### App
8. `api.ts`: `Job += duration_ms: number`; `Document += capture_ms?: number`.
9. `jobs.tsx`: card top row — show `formatDuration(duration_ms)` when >0 and status done/dead.
10. `document/[id].tsx`: meta panel — add "Capture time" row when `capture_ms > 0`.

## Verify
- `just build` green; `sqlc generate` clean.
- Run server on a test port, scrape a URL, confirm `jobs.duration_ms` > 0 and
  `GET /documents/{id}` returns `capture_ms`.
- `just e2e` (jobs screen renders).
- agent-browser: jobs screen shows duration; doc panel shows Capture time.

## Steps
1. Commit plan to main.
2. Server: schema + migration + queries + sqlc + worker + jobs.go + documents.go.
3. App: api types + jobs row + doc panel.
4. Build, restart (`just restart`), curl verify, e2e, browser check.
5. Commit. Ask user to check.
