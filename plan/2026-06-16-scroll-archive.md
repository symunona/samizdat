---
created: 2026-06-16
topic: Scroll-to-archive highlights + Archived tab
excerpt: Auto-archive highlights as user scrolls past them; faded look for archived items; dedicated Archived drawer screen.
status: in-progress
---

# Scroll-to-Archive Highlights

## Goal
- As user scrolls down the Feed, highlights that leave the top of the viewport get archived (server-side `archived_at`)
- Archived items fade in the list during current session
- On reload, feed excludes archived items by default
- New "Archived" drawer screen shows archived highlights

## E2E Test Plan
1. Start server, open feed with highlights
2. Scroll down past 2+ highlights
3. Scroll back up — those highlights appear faded (opacity ~0.4)
4. Reload feed — faded items gone
5. Open Archived drawer → see them there

## Implementation

### 1. Schema — `server/internal/store/schema.sql`
Add `archived_at TEXT` to `highlights` table (ALTER TABLE or in IF NOT EXISTS block via migration).

### 2. SQL Queries — `server/internal/store/queries.sql`
- Modify `ListHighlights` → add `AND archived_at IS NULL`
- Add `ListArchivedHighlights :many` → `WHERE deleted_at IS NULL AND archived_at IS NOT NULL`
- Add `ArchiveHighlight :exec` → UPDATE `archived_at`
- Run `just server::gen`

### 3. API — `server/internal/api/highlights.go`
- `listAll`: honor `?archived=1` param → call `ListArchivedHighlights`
- `patchOne`: add `ArchivedAt *string` field → call new `ArchiveHighlight` query

### 4. App API — `app/src/api.ts`
- Add `archived_at: string | null` to `Highlight` type
- Add `archiveHighlight(serverUrl, token, id)` — PATCH with `{"archived_at": now}`
- Update `fetchHighlights` to accept `archived?: boolean` param

### 5. Feed Screen — `app/app/(drawer)/index.tsx`
- Add `onScroll` ref tracking `scrollY`
- Add `onViewableItemsChanged` + `viewabilityConfig`
- When item leaves viewport AND scrollY increased since it first appeared → archive it
- Track `archivedIds` local Set → render archived items with opacity 0.4

### 6. Archived Screen — `app/app/(drawer)/archived.tsx`
- New screen, same structure as feed
- Calls `fetchHighlights(url, token, 200, true)` (archived=true)
- Shows faded cards; unarchive action via swipe or button

### 7. Drawer — `app/app/(drawer)/_layout.tsx`
- Add `{ name: 'archived', label: 'Archived', href: '/archived' }` to SCREENS
- Add `<Drawer.Screen name="archived" options={{ title: 'Archived' }} />`
