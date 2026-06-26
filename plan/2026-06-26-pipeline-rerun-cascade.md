---
created: 2026-06-26
topic: Idempotent pipeline regeneration + per-node forced rerun with cascade subtree erase
excerpt: Stop duplicate highlights. Don't regenerate unless forced. Forced rerun tombstones the whole descendant subtree (jobs + pipeline_runs + highlights) and shows superseded versions in the jobs panel. Skip guard is document-content-hash aware.
status: DRAFT — design approved by user via decisions below; not yet implemented
---

# Pipeline rerun cascade + idempotent regeneration

## Problem

1. **Duplicate highlights.** `InsertHighlight` is a plain non-idempotent insert (no unique constraint, fresh UUID each call). Two ways dups appear:
   - **Retry within a run** (primary): a step inserts highlights non-transactionally, errors mid-loop (e.g. SQLite BUSY on the 4GB box), job re-queued up to 3×, step re-runs from the top, re-inserting everything before the failure point.
   - **Re-trigger of a run** (secondary): every re-scrape / manual re-run mints a NEW `pipeline_run` and a full fresh highlight set; old runs' highlights are never reconciled. 7 enqueue sites, none dedup.
2. **No way to force a clean regenerate** that erases the stale subtree.

## Decisions (user, 2026-06-26)

- **Delete = soft tombstone** (`deleted_at` + `rev` bump), so deletion syncs to the phone (highlights are server→phone one-way machine data). PLUS the jobs panel must let you **see previous (superseded) versions**.
- **Skip guard = content-hash aware**: auto-triggered runs skip when a `done` run already exists for `(pipeline_id, document_id)` AND the document content is unchanged since that run. Changed content (or a forced rerun) regenerates.
- **Forced rerun = per job-node** in the tree: rerun any node → tombstone its whole descendant subtree (jobs + their pipeline_runs + highlights) + the node itself, then re-enqueue a fresh equivalent node.

## Current model (confirmed)

- Job tree = `jobs.parent_job_id` (adjacency list, unconstrained, soft-delete; server already walks it read-only via `WITH RECURSIVE` in `jobs.go:73`).
- `pipeline_runs` links to pipeline + document; the **run↔job link is only `job.result.pipeline_run_id` JSON** (`worker/pipeline.go:89`) — no `job_id` column.
- `highlights` FK `pipeline_run_id` (NOT NULL) — the only enforced FK in the chain. Highlights are NOT in the job tree.
- `documents` (schema.sql:41) has `markdown`, `rev`, `fetched_at` — **no content_hash**.
- Frontend `jobs.tsx:66 buildTree` rebuilds the tree from a flat list; API `GET /api/v1/jobs` paginates by ROOT jobs then appends all descendants.

---

## Design

### A. Schema changes (additive migrations in `open.go`)

```sql
-- documents: snapshot of scraped content for change detection
ALTER TABLE documents       ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
-- pipeline_runs: what the run was generated against + provenance for "versions"
ALTER TABLE pipeline_runs   ADD COLUMN document_content_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE pipeline_runs   ADD COLUMN job_id      TEXT;      -- make the run↔job link a real column (was result-JSON only)
ALTER TABLE pipeline_runs   ADD COLUMN superseded_at TEXT;    -- set when a newer run replaces it (history marker, distinct from deleted_at)
```

- `documents.content_hash` = `sha256(markdown)` computed at the end of scrape (`scraper.go`). Re-scrape with identical body → same hash → no needless regenerate.
- `pipeline_runs.job_id` makes cascade deletion a clean join instead of JSON parsing. Backfill in migration by parsing existing `jobs.result`.
- `pipeline_runs.superseded_at` lets the panel show "v1 (superseded), v2 (current)" without relying on `deleted_at` alone. (A forced rerun sets BOTH `superseded_at` and `deleted_at` on the old run; a content-change regenerate sets `superseded_at` on the old run but may keep it un-tombstoned if we want side-by-side — default: tombstone old.)

> No unique constraint on highlight content — idempotency comes from the run lifecycle (B + C), not a DB UNIQUE. Adding `UNIQUE(pipeline_run_id, kind, title, body)` is a cheap belt-and-suspenders; include it as `INSERT ... ON CONFLICT DO NOTHING` only if B proves insufficient.

### B. Step idempotency (fixes the primary dup bug — retry within a run)

At the start of **each step handler**, before inserting, clear this run+step's prior highlights so a retry is replace-not-append:

- Add `SoftDeleteHighlightsByRunAndStep` (keyed `pipeline_run_id` + a new `metadata.step` or a `step_index` column on highlights) — OR simpler: wrap each step's inserts in `WithTx` (`db.go:27`, currently unused in the job path) so a mid-loop failure rolls back the whole step. **Prefer `WithTx`** — atomic, no new column, no orphan-on-retry window. The step either fully commits its highlights or none.

This alone kills the retry-duplication class regardless of rerun work.

### C. Skip guard (content-hash aware) — centralized

In `handleRunPipeline` (`worker/pipeline.go:42`), before `InsertPipelineRun`:

```
if payload.Force != true:
    existing := latest non-deleted DONE run for (pipeline_id, document_id)
    if existing != nil && existing.document_content_hash == document.content_hash:
        mark this job done, result = {"skipped": true, "reused_run_id": existing.id}
        return   // no new run, no new highlights
```

Centralizing here covers all 7 enqueue sites. `Force` is a new payload field set only by the rerun endpoint (D).

### D. Forced per-node rerun + cascade (the main feature)

New endpoint `POST /api/v1/jobs/:id/rerun`:

1. Collect the subtree = node + all descendants via the existing recursive CTE.
2. Resolve every `pipeline_run` whose `job_id` ∈ subtree (now a clean join thanks to A).
3. **Tombstone, in one tx (`WithTx`):**
   - highlights where `pipeline_run_id` ∈ those runs **AND NOT user-interacted** → `deleted_at`, `rev++`
   - those `pipeline_runs` → `superseded_at`, `rev++`; tombstone (`deleted_at`) ONLY runs that have no surviving (interacted) highlights — a run keeping interacted highlights stays alive so the FK still resolves
   - subtree jobs (node + descendants) → `deleted_at`, `rev++`
4. **Re-enqueue** one fresh job: same `kind` + `payload`, `parent_job_id = node.parent_job_id`, with `payload.force = true` (bypass C; bypass scrape canonical_url dedup if the node is `scrape_url`).
5. The fresh job rebuilds its own subtree normally.

#### Preserve user-interacted highlights (NEVER auto-delete)

A highlight is **user-interacted** — and is kept (never tombstoned) on any rerun/regenerate — if ANY of:
- `pinned = 1`
- `archived_at IS NOT NULL`
- has ≥1 non-deleted row in `annotations` referencing it
- has ≥1 row in `highlight_tags` referencing it

Add `ListInteractedHighlightIDsByRun(run_ids)` and exclude those ids from every cascade soft-delete (both in D and in the content-change regenerate path C). Kept highlights are re-tagged in the UI as belonging to a superseded run (badge), but remain visible in the reader. This rule is shared by C and D — implement once.

New store queries (all soft-delete + rev bump, sync-safe):
- `ListJobSubtreeIDs(rootID)` — recursive CTE returning ids (read; extract from existing CTE).
- `SoftDeleteJobsByIDs`, `SoftDeletePipelineRunsByJobIDs`, `SoftDeleteHighlightsByPipelineRunIDs`.

### E. Soft-delete + history view in the jobs panel

- API: `GET /api/v1/jobs?include_superseded=true` (default false) — when true, also return tombstoned/superseded roots+subtrees, flagged.
- `Job` API type gains `superseded: bool` (derived: `deleted_at != null && was rerun`) and `pipeline_run`s gain `superseded_at`.
- `jobs.tsx`: a "Show history" toggle. Superseded subtrees render greyed/struck with a "superseded" badge and a version index (`v1`, `v2 current`) grouped by `(pipeline_id, document_id)`. Current tree is default view.
- Document view & highlight queries already filter `deleted_at IS NULL`, so tombstoned highlights vanish from the reader and the phone learns via tombstone sync. No change needed there.

---

## API summary

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/v1/jobs/:id/rerun` | Tombstone subtree + re-enqueue node (force) |
| GET | `/api/v1/jobs?include_superseded=` | List with optional history |

## Frontend

- `app/src/api.ts`: `rerunJob(id)`, `include_superseded` param on `fetchJobsPage`, `superseded` on `Job` type.
- `app/app/(drawer)/jobs.tsx`: per-node "Rerun" action. On press, **enter a preview state that visually highlights the affected subtree** (the node + all descendants get a highlighted/outlined background) so the user sees exactly what will be erased, THEN confirm ("Erase this subtree's results and regenerate? Interacted highlights are kept.") / cancel. Reuse `buildTree` depth + `byParent` grouping to mark the affected ids. Also: "Show history" toggle, superseded styling + version badges.

## Migration

Additive `ALTER TABLE` in `open.go` (matches existing additive-migration pattern). Backfill `pipeline_runs.job_id` from `jobs.result` JSON; backfill `documents.content_hash` lazily (empty hash → next run never skips, which is safe).

## Testing (write first)

E2E in `e2e/smoke.js` PAGES already hits Jobs. Add a scripted flow:
1. Scrape a fixture URL → pipeline runs → N highlights. Assert exactly N (no dups).
2. Re-trigger same doc (unchanged) → assert SKIPPED, still N highlights, no new run.
3. `POST /jobs/:id/rerun` on the run_pipeline node → assert old run+highlights tombstoned (gone from reader), new run produced, count back to N.
4. `?include_superseded=true` → old subtree visible & flagged.
5. Pin (or annotate) one highlight, then rerun the node → assert the pinned/annotated highlight SURVIVES (not tombstoned), its run stays alive, rest regenerated.
6. Confirm green `just e2e` + `just build` + linter.

Plus a Go unit test for retry idempotency: force a step to error after k inserts within a run, assert no dup highlights after retry (validates B).

## Sequencing (subagents)

1. Schema + migrations (A) + sqlc regen.
2. Step idempotency via `WithTx` (B) + Go retry test — this is the standalone dup fix; commit on its own.
3. Skip guard (C).
4. Rerun endpoint + cascade queries (D).
5. History API + frontend toggle/rerun button (E).
6. E2E + linter + build, then ask user to verify.

Branch off `main` after committing this plan; small commits; squash-merge when verified.
