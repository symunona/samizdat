---
date: 2025-02-14
topic: Subscription doc count link + documents search/filter
excerpt: Show per-feed document count on Subscriptions as link to Documents; add keyword search, advanced source dropdown, URL params on Documents.
status: done
---

# Plan

1. Server: `ListFeedDocumentCounts` query (sqlc) + `GET /api/v1/feeds/document-counts` → `{feed_id: count}`.
2. `app/src/api.ts`: `fetchFeedDocumentCounts`.
3. `subscriptions.tsx`: count badge per card → `router.push(/documents?feed_id=…)`.
4. `documents.tsx`:
   - URL params: `feed_id` (exists), `pipeline_id` (exists), add `q`.
   - Free keyword search box (filters title/url/author/excerpt, case-insensitive).
   - "Advanced" toggle → source dropdown (feeds list), sets feed filter.
   - Filter bar reflects active search/source.
5. E2E: `just e2e` + agent-browser interaction test (search filters list, source link from subscriptions lands filtered).
