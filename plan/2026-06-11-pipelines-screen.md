---
created: 2026-06-11
topic: Pipelines screen + job output + URL param filters
excerpt: New Pipelines drawer menu, collapsible job/document outputs, feed_id filter on docs, pipeline_id filter on docs
status: in-progress
---

## Goal
1. **Pipelines screen** — new drawer item between Subscriptions and Jobs
2. **Jobs screen** — clickable document links on run_pipeline jobs
3. **Documents screen** — `?feed_id=` URL param filter (client-side from sync store)
4. **Pipelines screen → Documents** — via `GET /api/v1/pipelines/{id}/documents`

## Server changes
- `queries.sql`: add `ListDocumentsByPipeline` (JOIN pipeline_runs), `ListDocumentsByFeed`, `ListJobsByPipelineId`
- `pipelines.go`: add `listDocuments` + `listJobs` handlers
- `documents.go`: add `?feed_id=` param filter
- `router.go`: register `GET /api/v1/pipelines/{id}/documents`, `GET /api/v1/pipelines/{id}/jobs`

## App changes
- `api.ts`: add `fetchPipelineDocuments`, `fetchPipelineJobs`; add `feed_id` opts to `fetchDocuments`
- New `app/(drawer)/pipelines.tsx` — list + toggle enabled + collapsible jobs + collapsible docs per pipeline
- `_layout.tsx` — add Pipelines to SCREENS
- `documents.tsx` — accept `?feed_id=` URL param
- `jobs.tsx` — make run_pipeline document title a Pressable link to document

## E2E
- Add `/pipelines` to `e2e/smoke.js` PAGES
