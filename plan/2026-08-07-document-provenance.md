---
created: 2026-08-07
topic: Show how a Document got here (feed / manual add / pipeline link) on the document meta panel
excerpt: The meta panel's "Source" row says "Manual" for everything that isn't a feed — including documents a pipeline's extract_links step pulled in. Derive provenance from the scrape job's parent and render it, with a tap-through to the document that linked here.
status: built + verified (go unit test, `just e2e-int` 91 checks, `just e2e`, `just lint`)
---

## Why

`documents.source_feed_id` records exactly one provenance: a feed poll. Everything else
falls into the panel's `else` branch and renders **"Manual"** — including the documents
that `extract_links` / `extract_list_items` pulled in while running a pipeline over another
document. So a feed of 40 auto-scraped link targets looks identical to a URL the user pasted
into the add sheet, and there is no way back to the document that linked them.

## What already exists

- `scrape_url` jobs record their result as `{"document_id": ...}` — `GetScrapeDurationByDocument`
  already maps document → scrape job that way (drives the panel's "Capture time" row).
- Pipeline-spawned scrapes carry `parent_job_id` = the driving `run_pipeline_step` job
  (`ParentJobIDFromCtx`). That job's payload holds `pipeline_name`, `document_id`,
  `document_title` — i.e. the pipeline **and** the document whose links were followed.
- Manual adds (`POST /api/v1/jobs`, app add sheet + clipper + CLI) have no parent job and
  carry `device_id` / `device_name` in the payload.

So provenance is already in the DB — it is just never read. No schema change, no new column
to keep reconstructable from the vault (rule 1).

## Plan

1. **Query** `GetScrapeJobByDocument` (`queries.sql`): payload + `parent_job_id` of the
   `scrape_url` job that produced this document. Sibling of `GetScrapeDurationByDocument`.
2. **API** `GET /api/v1/documents/{id}` grows `added_via` next to `capture_ms`:
   `{kind: feed|manual|pipeline|unknown, device_name?, pipeline_name?, document_id?, document_title?}`.
   - `source_feed_id` set → `feed` (the panel already renders the feed itself).
   - parent job is `run_pipeline_step`/`run_pipeline` → `pipeline` + names + linking document.
   - otherwise → `manual` + device name.
   - no scrape job on record (pre-existing docs, imports) → `unknown`.
3. **App** `Document.added_via` type + the meta panel "Source" row renders it: pipeline name
   with a pressable "from <title>" that navigates to the linking document; manual shows the
   device that added it.

## Test

`e2e/integration.js`: run a pipeline with `extract_links` over a seeded document, open the
spawned document, open the meta panel, assert it reads `Pipeline` + the linking document's
title and that tapping it lands on that document — then a manually added URL's panel reads
`Manual`. API-only proof is explicitly not enough (a silent render failure returns 200).
