---
created: 2026-07-04
topic: Fix server→phone sync dropping Document updates (cursor race)
excerpt: The sync cursor (server_time) was sampled AFTER the read queries, so a Document upserted during the read window sat below the returned cursor and was skipped forever. Sample it before the reads.
status: done — fix + regression tests; verified live cursor loop re-delivers an updated doc
---

# Sync cursor race — updated Documents never reached the phone

## Symptom
New Documents appear on the phone; **updates** to existing ones (re-scrape /
pipeline re-process) do not. Reported by another agent.

## Root cause (two independent investigations converged)
- App apply is a correct upsert (`syncStore.ts` `next[item.id] = item`) — NOT the bug.
- `UpsertDocument` correctly bumps `updated_at` + `rev` — NOT the bug.
- **The cursor.** `sync.go` sampled `server_time = time.Now()` **after** the 7
  `*Since` read queries. A row upserted during that read window gets
  `updated_at <= server_time` yet is absent from the batch. The client stores
  `server_time` as its next `since`; the next `updated_at >= since` pull never
  re-selects it. Background updates (re-scrape/pipeline) run concurrently with the
  30s poll, so they land in the window and vanish; user-created docs are viewed
  after creation so their timestamp reliably clears the cursor.

## Fix
`server/internal/api/sync.go`: sample `serverTime` **before** the reads, so it is a
guaranteed lower bound — any row that commits during/after the reads has
`updated_at >= serverTime` and is re-selected by the next `>=` pull. One-point
server fix; the app is already correct, so no Android rebuild/redeploy needed.
(Mirrors the export path, which derives its cursor from data via `overlap(-1s)`.)

## Tests
`server/internal/api/sync_test.go`:
- `TestSync_UpdatedDocumentReDelivered` — update after a sync is re-delivered on the
  next pull using the returned cursor.
- `TestSync_SameSecondUpdateNotSkipped` — `>=` covers the RFC3339 second boundary.
Live E2E on dev: sync → re-scrape (rev 1→2) → sync from prior cursor re-delivers the
updated doc (full 32.9k text).

Note: the sub-second race is timing-dependent and not force-reproducible in a black-box
test; the fix is correct by construction (sampling order) + guarded by the contract tests.

## Not touched
App sync code (already a correct idempotent upsert). Optional future hardening: have
the client derive its cursor from `max(updated_at)` too (defense in depth) — needs an
app rebuild, deferred.
