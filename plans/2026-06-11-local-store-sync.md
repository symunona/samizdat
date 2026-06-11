---
created: 2026-06-11
topic: Local store + differential sync
excerpt: Zustand store synced from server via /api/v1/sync?since=; infinite scroll via react-query for jobs; client-side paging for synced collections.
status: planning
---

# Local Store + Differential Sync

## Goal

Replace per-screen fetch-on-mount with a local Zustand store that mirrors server data via differential sync. UI reads from store, not network.

Jobs stay server-side (no local store), use react-query `useInfiniteQuery`. Subscriptions stay server-side, single page.

---

## Sync strategy

**Cursor**: `updated_at` ISO8601 timestamp (server-generated, no clock skew risk since server writes it).

**Sync endpoint**: `GET /api/v1/sync?since=<ISO8601>`

Response:
```json
{
  "server_time": "2026-06-11T10:00:00Z",
  "documents": [...],
  "highlights": [...],
  "annotations": [...],
  "tags": [...],
  "document_tags": [{ "document_id": "...", "tag_id": "...", "deleted_at": null }],
  "annotation_tags": [...],
  "highlight_tags": [...]
}
```

Each item includes tombstones (`deleted_at` set). Client upserts non-deleted, removes deleted.

Default `since` = `1970-01-01T00:00:00Z` → full sync on first run.

**Trigger**: on app foreground (`AppState` change) + once on mount.

---

## Server changes

### New SQL queries (queries.sql)

```sql
-- name: ListDocumentsSince :many
SELECT * FROM documents WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListHighlightsSince :many
SELECT * FROM highlights WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListAnnotationsSince :many
SELECT * FROM annotations WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListTagsSince :many
SELECT * FROM tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListDocumentTagsSince :many
SELECT * FROM document_tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListAnnotationTagsSince :many
SELECT * FROM annotation_tags WHERE updated_at > ? ORDER BY updated_at ASC;

-- name: ListHighlightTagsSince :many
SELECT * FROM highlight_tags WHERE updated_at > ? ORDER BY updated_at ASC;
```

### New API handler: `sync.go`

`GET /api/v1/sync?since=<ISO8601>`
- Parse `since` param (default `1970-01-01T00:00:00Z`)
- Run 7 queries in parallel (goroutines)
- Return bundle + `server_time = time.Now().UTC()`

### Jobs paging

Add to `GET /api/v1/jobs`:
- `limit` (default 50, max 200)
- `cursor` (last `created_at` value from previous page, for keyset pagination)

Response changes to `{ items: Job[], next_cursor: string | null }`.

### Indexes needed

```sql
CREATE INDEX IF NOT EXISTS documents_updated_at ON documents(updated_at);
CREATE INDEX IF NOT EXISTS highlights_updated_at ON highlights(updated_at);
CREATE INDEX IF NOT EXISTS annotations_updated_at ON annotations(updated_at);
CREATE INDEX IF NOT EXISTS tags_updated_at ON tags(updated_at);
CREATE INDEX IF NOT EXISTS document_tags_updated_at ON document_tags(updated_at);
CREATE INDEX IF NOT EXISTS annotation_tags_updated_at ON annotation_tags(updated_at);
CREATE INDEX IF NOT EXISTS highlight_tags_updated_at ON highlight_tags(updated_at);
```

---

## Frontend changes

### Install

```bash
npx expo install zustand @tanstack/react-query
```

No MMKV (avoid native dep for now) — persist via AsyncStorage.

### Store shape (`app/src/store/syncStore.ts`)

```ts
type SyncStore = {
  documents: Record<string, Document>
  highlights: Record<string, HighlightWithDoc>
  annotations: Record<string, Annotation>
  tags: Record<string, Tag>
  documentTags: Record<string, string[]>   // docId → tagId[]
  annotationTags: Record<string, string[]> // annId → tagId[]
  highlightTags: Record<string, string[]>  // hlId → tagId[]
  lastSyncedAt: string | null
  syncStatus: 'idle' | 'syncing' | 'error'
  syncError: string | null
  // actions
  applySync(payload: SyncPayload): void
  setSyncing(v: boolean): void
  setSyncError(e: string | null): void
}
```

Persisted keys: `documents`, `highlights`, `annotations`, `tags`, `*Tags`, `lastSyncedAt`.
Serialized to AsyncStorage under key `samizdat_sync_store`.

### Sync engine (`app/src/store/syncEngine.ts`)

```ts
export async function runSync(conn: StoredConnection) {
  // 1. Read lastSyncedAt from store
  // 2. Call fetchSync(serverUrl, token, since)
  // 3. Call store.applySync(payload)
  // 4. Persist store to AsyncStorage
}
```

Triggered from `ConnectionContext` (or a new `SyncContext`) on:
- App mount
- `AppState` change to `active`
- After local mutations (create/delete annotation, etc.)

### Hooks (`app/src/store/hooks.ts`)

```ts
useDocuments(page, pageSize)      // sorted by created_at desc, sliced
useDocument(id)
useHighlights(docId?)             // filtered from store
useAnnotations(docId)
useTags()
useTag(id)
useSyncStatus()
```

**Paging for client-side collections**: sorted IDs array → slice by `page * pageSize`. FlatList `onEndReached` increments page. No re-fetch needed, just slice more.

### React Query for jobs

Wrap app in `QueryClientProvider`. `useInfiniteQuery` in jobs screen:

```ts
useInfiniteQuery({
  queryKey: ['jobs', status, kind],
  queryFn: ({ pageParam }) => fetchJobsPage(serverUrl, token, { cursor: pageParam, limit: 50 }),
  getNextPageParam: (last) => last.next_cursor ?? undefined,
})
```

### Subscriptions

Keep existing fetch-on-mount pattern (single page, small dataset). No changes needed.

---

## Migration path for existing screens

| Screen | Before | After |
|--------|--------|-------|
| documents.tsx | `fetchDocuments` on focus | `useDocuments(page)` from store |
| document/[id].tsx | `fetchDocument` on mount | `useDocument(id)` from store |
| tags.tsx | `fetchTags` on focus | `useTags()` from store |
| jobs.tsx | `fetchJobs` on mount | `useInfiniteQuery` |
| subscriptions.tsx | `fetchSubscriptions` on focus | unchanged |

Local mutations (create/delete annotation) still call server immediately, then trigger a re-sync or optimistic store update.

---

## Out of scope (this plan)

- Media assets (excluded per user)
- Conflict resolution for concurrent edits (LWW is fine for now)
- Background sync / push notifications
- Offline write queue (annotations still require connectivity)

---

## Implementation order

1. Server: schema indexes + sync queries + `sync.go` handler + jobs paging
2. Frontend: install deps + syncStore + syncEngine + hooks
3. Wire sync into ConnectionContext
4. Migrate document list + tags list to store
5. Migrate jobs screen to react-query infinite scroll (subagent)
6. Migrate document detail to store
7. Test E2E: full sync, incremental sync, delete tombstone propagation
