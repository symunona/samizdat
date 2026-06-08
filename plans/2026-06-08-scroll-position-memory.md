---
created: 2026-06-08
topic: Document viewer scroll position memory
excerpt: Remember scroll position per device/document; restore on reopen; debounced save to DB.
status: done
---

# Scroll Position Memory

## Goal
When user reopens a document, restore their last reading position.

## Changes

### Server
1. `schema.sql` — add `read_states` table (device_id, document_id, scroll_y)
2. `queries.sql` — add `UpsertReadState`, `GetReadState`
3. Run `sqlc generate`
4. `read_states.go` — handler for GET + PUT
5. `router.go` — wire `GET/PUT /api/v1/documents/{id}/progress`
6. `middleware.go` — add PUT to CORS allowed methods

### App
1. `api.ts` — add `fetchReadingProgress`, `saveReadingProgress`
2. `app/document/[id].tsx` — scroll ref, `onScroll` debounce, restore on load

## Data model
`read_states`: id, device_id, document_id, scroll_y (REAL, 0.0–1.0 fraction), created_at, updated_at, rev, deleted_at
Unique index on (device_id, document_id).

## Scroll fraction
`scroll_y = contentOffset.y / max(contentSize.height - layoutMeasurement.height, 1)`
Restore: `scrollTo({ y: fraction * (contentHeight - viewHeight) })`

## API
- `GET /api/v1/documents/{id}/progress` → `{scroll_y: float}` or 404
- `PUT /api/v1/documents/{id}/progress` body `{scroll_y: float}` → 200

## Status
- [ ] Schema + queries
- [ ] sqlc generate
- [ ] Handler + router
- [ ] App API functions
- [ ] Viewer: save + restore
