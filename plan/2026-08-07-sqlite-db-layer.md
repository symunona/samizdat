---
created: 2026-08-07
topic: Replace zustand-persist replica with a real SQLite DB layer
excerpt: One db layer own all storage. UI and sync both talk only to it. SQLite under, expo-sqlite on native, wa-sqlite on web. Linter guard the wall.
status: built on feat/sqlite-db-layer — steps 1-4 done, awaiting the on-device check (step 5's last line)
---

# SQLite DB layer

## Why

Old way: whole replica one JSON blob in AsyncStorage. Every `set()` re-serialize
everything. Blob pass 6MB Android cap → every write throw → replica frozen 6 days,
cursor stuck, phone re-pull same delta forever. See
`plan/2026-08-07-persist-failure-visibility.md` for the loud-failure fix already shipped.

New way: rows in SQLite. Row write cheap. No cap that matter (100MB+ fine). Bodies stay
in the row — sync unchanged, backend unchanged.

## Decisions (locked)

- **Full SQLite.** Bodies (`markdown`, `transcript`) stay columns on `documents`. No
  separate body store.
- **Sync unchanged.** One differential query. `GET /api/v1/sync?since=` as today. `since`
  null → full pull, big, slow, show loading. Fine. Chunked sync = later problem.
- **Backend: zero change.**
- **Wall:** `sync` and `ui` both go through db layer. Nothing else touch DB. Linter enforce.

```
sync ──┐
       ├──> db layer (src/db/*) ──> driver ──> expo-sqlite (native)
ui   ──┘                                   └─> wa-sqlite   (web)
```

## Engine choice

| target | driver | why |
|---|---|---|
| native (android/ios) | `expo-sqlite` | first-party, SDK 56, system SQLite, no cap |
| web | `@journeyapps/wa-sqlite` + `OPFSCoopSyncVFS` | real SQL, **no COOP/COEP**, all modern browsers |
| node (tests only) | `node:sqlite` | built into node 22, zero dep, TDD runner |

**Do NOT use expo-sqlite web target.** Docs say alpha, and it need COOP/COEP headers for
SharedArrayBuffer. COEP is recursive → YouTube embed (`src/YtPlayer.web.tsx`) break.
wa-sqlite VFSes need no such header. This is the whole reason for two drivers.

**Use the `@journeyapps/wa-sqlite` fork, NOT upstream.** Upstream `rhashimoto/wa-sqlite`
last released v1.1.1 in Apr 2024; the `wa-sqlite` npm package is a stale 1.0.0 stub from
Jan 2024 with no exports map. `@journeyapps/wa-sqlite` (PowerSync) is v2.0.1, published
2026-08-03, same VFS set, real npm package. Same code family, maintained.

Web fallbacks to note (not build now): Safari incognito have no OPFS; wa-sqlite
`IDBBatchAtomicVFS` is the escape hatch. Driver pick VFS at open, log which one.

## The wall

Three rules. Linter `tooling/check-db-layer.mjs`, wired into `just lint`:

1. Only `app/src/db/**` may import `expo-sqlite` / `wa-sqlite` / `node:sqlite`.
2. Only `app/src/db/queries.ts` may contain SQL text (`SELECT `/`INSERT `/`UPDATE `/
   `DELETE FROM`/`CREATE TABLE`).
3. Only `app/src/db/**` and `app/src/storage.ts` may import `@react-native-async-storage/async-storage`.
   (`storage.ts` keep ONLY the connection record — must survive a corrupt DB, else no way
   to re-pull. Everything else move into the `settings` table.)

Append rules to `app/CLAUDE.md` at the end (own section: "DB layer is the only storage").

---

# Step 1 — scan (DONE, results below)

## Who read the replica

| file | reads | becomes |
|---|---|---|
| `app/(drawer)/index.tsx` | `highlightsFromStore(h => !h.archived_at)`, `hasHydrated`, `highlights` count | `useFeedHighlights()` |
| `app/(drawer)/starred.tsx` | `highlightsFromStore(h => h.pinned===1)`, count | `useStarredHighlights()` |
| `app/(drawer)/archived.tsx` | `highlightsFromStore(h => !!h.archived_at)`, count | `useArchivedHighlights()` |
| `app/(drawer)/documents.tsx` | `useDocuments`, `useSyncStatus` | same names, from `db` |
| `app/(drawer)/notes.tsx` | `useAnnotations`, `useSyncStatus` | same names, from `db` |
| `app/(drawer)/tags.tsx` | `useTagsWithCounts`, `useSyncStatus` | same names, from `db` |
| `app/(drawer)/offline-cache.tsx` | `state.documents` | `useDocuments()` |
| `app/(drawer)/settings.tsx` | `clearStore` | `db.wipe()` |
| `app/(drawer)/document/[id].tsx` | `getState().documents` (2×, incl. body) | `db.getDocument(id)` |
| `src/HighlightDetail.tsx` | `state.annotations` | `useAnnotationsFor(...)` |
| `src/TagSelectorModal.tsx` | `st.tags`, `st[junction]` | `useTags()`, `useTagLinks(type,id)` |

## Who wrote

All via `src/store/mutations.ts` (`mut.*`) — 12 funcs, callers in `index`, `archived`,
`starred`, `notes`, `document/[id]`, `HighlightDetail`, `TagSelectorModal`,
`VideoDocument`. **Keep this exact facade + names.** Only its body change.

`src/store/syncEngine.ts` → `applySync(payload)`.
`src/store/pushEngine.ts` → `onIntentSuccess` / `onIntentRetry` / `dropIntent`.

## Loose AsyncStorage (must move)

| key | file | goes to |
|---|---|---|
| `samizdat_sync_store` + `.N` chunks | `store/syncStore.ts`, `store/chunkedStorage.ts` | **deleted** — SQLite tables |
| `doc_hl_exp_<id>` | `app/(drawer)/document/[id].tsx:148,487` | `settings` table |
| `video_audio_<docId>` | `src/VideoDocument.tsx:269,662`, `src/offlineCache.ts` | `media_files` table |
| `samizdat_theme`, `samizdat_debug_log_stream`, `samizdat_reading_mode`, `samizdat_page_threshold`, `samizdat_last_url`, `samizdat_url_last_used` | `src/storage.ts` | `settings` table |
| `samizdat_connection` | `src/storage.ts` | **STAYS in AsyncStorage** (bootstrap) |

## Interface commands the scan demands

Reads: documents list · one document (with body) · highlights by filter (feed/starred/
archived) with doc title+url+tags joined · annotations (all, with tags + doc title) ·
annotations for one doc/highlight · tags with counts · tag links for object · sync status ·
hydrated flag · media file for doc · settings get/set.

Writes: applySync(payload) · 12 `mut.*` · outbox drain callbacks · wipe.

---

# Step 2 — the interface

`app/src/db/index.ts` is the ONLY module anything outside `src/db/` imports.

```
// lifecycle
open(): Promise<void>              // idempotent; opens, migrates, warms index
wipe(): Promise<void>              // drop all rows, keep schema; for Settings + broken replica
isReady(): boolean

// sync (called ONLY by syncEngine / pushEngine)
applySync(payload: SyncPayload): Promise<void>
getCursor(): Promise<string | null>          // lastSyncedAt
setSyncStatus(status, error?): void
onIntentSuccess(intentId, serverRev): Promise<void>
onIntentRetry(intentId): Promise<void>
dropIntent(intentId): Promise<void>
listOutbox(): Promise<OutboxIntent[]>

// reads — imperative
getDocument(id): Promise<Document | null>    // FULL row incl. markdown/transcript
getMediaFile(docId): Promise<string | null>
listMediaFiles(): Promise<{docId, uri}[]>
getSetting(key): Promise<string | null>
setSetting(key, value): Promise<void>

// reads — react hooks (reactive, backed by memory index)
useDocuments(): Document[]                   // metadata only, NO body
useDocument(id): Document | null             // full row, incl. body
useFeedHighlights(): HighlightWithDoc[]
useStarredHighlights(): HighlightWithDoc[]
useArchivedHighlights(): HighlightWithDoc[]
useHighlightCount(): number
useAnnotations(): AnnotationWithContext[]
useAnnotationsFor(opts: {documentId?, highlightId?}): Annotation[]
useTags(): Tag[]
useTagsWithCounts(): TagWithCounts[]
useTagLinks(type: JunctionType, objectId): string[]
useSyncStatus(): {status, error, lastSyncedAt}
useHydrated(): boolean

// mutations — SAME NAMES as today's src/store/mutations.ts
pinHighlight · archiveHighlight · deleteHighlight · addTag · removeTag · createTag ·
createAnnotation · updateAnnotation · deleteAnnotation · saveProgress · saveMediaPos ·
setMediaFile(docId, uri|null)
```

## Reactivity — how

DB is truth. zustand stay, but **only as memory index**, owned inside `src/db/`, never
imported by a screen.

- `open()` runs one `SELECT` per table **without body columns** → fills index.
- Every write: SQLite first, then patch index. Write fail → index not patched → UI never
  lies.
- Bodies never enter the index. `useDocument(id)` do a real query, cache one doc.
- All existing `useShallow` selector rules still apply. Same trap, same fix
  (raw slices + `useMemo`) — see app/CLAUDE.md.

Index size ≈ 4KB/doc. 251 docs = 0.72MB. Fine to ~10k docs. Past that → per-screen
queries. Later problem.

## Schema (`app/src/db/schema.ts`)

Mirror server tables, same names, same columns. `id TEXT PRIMARY KEY`, `created_at`,
`updated_at`, `rev INTEGER`, `deleted_at TEXT NULL` on every synced table.

```
documents(… markdown TEXT, transcript TEXT, media_metadata TEXT, …)
highlights · annotations · tags
document_tags · annotation_tags · highlight_tags
outbox(id, kind, args JSON, tries, created_at, base_rev, coalesce_key)
dirty(key TEXT PRIMARY KEY, base_rev INTEGER)
settings(key TEXT PRIMARY KEY, value TEXT)
media_files(document_id TEXT PRIMARY KEY, uri TEXT)
meta(key, value)   -- schema_version, last_synced_at
```

Indexes: `highlights(document_id)`, `highlights(archived_at)`, `highlights(pinned)`,
`annotations(document_id)`, `annotations(highlight_id)`, every junction on both FKs,
`documents(created_at DESC)`.

**No migration from old store.** Bump nothing, just wipe: on first `open()` after upgrade,
delete AsyncStorage keys `samizdat_sync_store*` and re-pull from `since=null`. Rule 1 —
server is authoritative, replica is rebuildable.

---

# Step 3 — build order (per file, dumb-model-safe)

## 3a. New files — write in THIS order

| # | file | content | depends on |
|---|---|---|---|
| 1 | `app/src/db/types.ts` | re-export `Document`/`Highlight`/`Annotation`/`Tag`/junction/`SyncPayload` types from `../api`; add `TagWithCounts`, `AnnotationWithContext`, `HighlightWithDoc` (copy from `src/store/hooks.ts`) | — |
| 2 | `app/src/db/driver.ts` | `SqlDriver` interface: `exec(sql)`, `all(sql, params)`, `run(sql, params)`, `tx(fn)`, `close()`. No impl. | — |
| 3 | `app/src/db/schema.ts` | `SCHEMA_SQL` const (DDL above) + `SCHEMA_VERSION` + `migrations: string[]` | 2 |
| 4 | `app/src/db/queries.ts` | **every SQL string in the app.** Named exports, one per operation. No logic. | 1,3 |
| 5 | `app/src/db/driver.node.ts` | `node:sqlite` impl. knip-ignore. Test-only. | 2 |
| 6 | `app/src/db/driver.native.ts` | `expo-sqlite` impl (`openDatabaseAsync`, `withTransactionAsync`) | 2 |
| 7 | `app/src/db/driver.web.ts` | `wa-sqlite` + `OPFSCoopSyncVFS`; fall back `IDBBatchAtomicVFS`; log chosen VFS | 2 |
| 8 | `app/src/db/memoryIndex.ts` | zustand store: `documents`/`highlights`/`annotations`/`tags`/3 junctions/`outbox`/`dirty`/`syncStatus`/`lastSyncedAt`/`hydrated`. **NOT persisted.** Plain `create()`. | 1 |
| 9 | `app/src/db/repo.ts` | all imperative ops: open/wipe/applySync/mut*/outbox. Calls `queries.ts` + patches `memoryIndex`. | 4,8 |
| 10 | `app/src/db/hooks.ts` | every `use*` from the interface, reading `memoryIndex` | 8 |
| 11 | `app/src/db/index.ts` | barrel: re-export repo funcs + hooks. Nothing else. | 9,10 |

`app/src/store/outbox.ts` — **keep as is.** Pure reducers, no zustand, already unit-tested.
`repo.ts` imports it.

`app/src/store/persistHealth.ts` — **keep.** Retarget: `repo.ts` reports every DB write
error to it instead of the chunked adapter. Settings card copy change from "device full"
to "cannot save locally". Alert wiring in `src/useServices.ts` unchanged.

## 3b. Files to DELETE

- `app/src/store/syncStore.ts`
- `app/src/store/chunkedStorage.ts`
- `app/src/store/hooks.ts`
- `app/src/store/mutations.ts`  → replaced by `db/index.ts` exports, SAME names
- `app/src/store/highlightsFromStore.ts`
- `e2e/chunked-storage-unit.mjs`

## 3c. Files to EDIT — exact per-file instruction

| file | do this |
|---|---|
| `app/src/store/syncEngine.ts` | replace `useSyncStore.getState()` with `db`. `since = await db.getCursor() ?? '1970-01-01T00:00:00Z'`. `await db.applySync(payload)`. `db.setSyncStatus(...)`. |
| `app/src/store/pushEngine.ts` | `useSyncStore.getState().outbox` → `await db.listOutbox()`. Callbacks → `db.onIntentSuccess/onIntentRetry/dropIntent`. |
| `app/src/store/useOutboxPush.ts` | subscribe to `db` outbox length instead of store slice |
| `app/app/_layout.tsx` | call `await db.open()` before rendering children; keep `hasHydrated` gate on `db.useHydrated()` |
| `app/app/(drawer)/index.tsx` | `highlightsFromStore(h => !h.archived_at)` → `useFeedHighlights()`; `useSyncStore(st=>st.hasHydrated)` → `useHydrated()`; count → `useHighlightCount()`; `mut.*` → `db.*` |
| `app/app/(drawer)/starred.tsx` | → `useStarredHighlights()`, `useHighlightCount()`, `db.pinHighlight` |
| `app/app/(drawer)/archived.tsx` | → `useArchivedHighlights()`, `useHighlightCount()`, `db.archiveHighlight` |
| `app/app/(drawer)/documents.tsx` | import `useDocuments`,`useSyncStatus` from `../../src/db` |
| `app/app/(drawer)/notes.tsx` | import `useAnnotations`,`useSyncStatus` from `../../src/db`; `mut.*`→`db.*` |
| `app/app/(drawer)/tags.tsx` | import `useTagsWithCounts`,`useSyncStatus` from `../../src/db` |
| `app/app/(drawer)/offline-cache.tsx` | `useSyncStore(s=>s.documents)` → `useDocuments()`; media list → `db.listMediaFiles()` |
| `app/app/(drawer)/settings.tsx` | `clearStore` → `db.wipe()`; persistHealth card copy |
| `app/app/(drawer)/document/[id].tsx` | drop `AsyncStorage` import. `getState().documents[id]` → `useDocument(id)` (line ~281, ~317). `doc_hl_exp_<id>` → `db.getSetting`/`db.setSetting` (line 148, 487). `mut.*`→`db.*` |
| `app/src/HighlightDetail.tsx` | `useSyncStore(s=>s.annotations)` → `useAnnotationsFor({highlightId})`; `mut.*`→`db.*` |
| `app/src/TagSelectorModal.tsx` | `st.tags`→`useTags()`; `st[SLICE[…]]`→`useTagLinks(type,id)`; `mut.*`→`db.*` |
| `app/src/VideoDocument.tsx` | drop `AsyncStorage`. `video_audio_<id>` get/set → `db.getMediaFile`/`db.setMediaFile` (line 269, 662). `mut.*`→`db.*` |
| `app/src/offlineCache.ts` | `getAllKeys`/`getItem` scan → `db.listMediaFiles()`; delete → `db.setMediaFile(id,null)` + unlink |
| `app/src/storage.ts` | keep ONLY `saveConnection`/`loadConnection`/`clearConnection`/`removeServerUrl`. Move theme, debug-log, reading-mode, page-threshold, last-url, url-last-used to `db.getSetting`/`setSetting`. Keep the `samizdat_page_mode` legacy migration, run it once inside `db.open()`. |
| `app/src/store/readingModeStore.ts` | back it with `db.getSetting`/`setSetting` |
| `app/src/store/debugLogStore.ts` | same |
| `app/src/offlineSim.ts` | drop `samizdat_force_storage_full` chunk-wrapper; new sim = make `SqlDriver.run` reject. Keep `samizdat_force_offline` untouched. |
| `app/src/webview/document-viewer.ts` | **no change** — comment says AsyncStorage never enters the bundle. Verify still true after refactor. |
| `justfile` | add `e2e-db` recipe; add `check-db-layer` to the `lint` chain |
| `app/CLAUDE.md` | new section "DB layer is the only storage" — the 3 wall rules, the engine table, why not expo-sqlite web (COEP↔YouTube), the reactivity contract |

---

# Step 4 — tests, TDD, write BEFORE the impl

## 4a. `e2e/db-unit.mjs` — new, `just e2e-db`

Zero-dep node runner, same shape as `e2e/outbox-unit.mjs`. Uses `driver.node.ts`
(`node:sqlite`), fresh in-memory DB per test.

**One test per interface func, written first, red before green:**

- schema: `open()` twice is idempotent; `SCHEMA_VERSION` recorded in `meta`
- `applySync`: inserts · updates by `rev` · tombstone hides row · dirty row NOT clobbered
  by older server rev · cursor advances to `payload.server_time` · empty payload no-op
- `getCursor` null on fresh DB
- `getDocument` returns body; `useDocuments` projection excludes body (assert column absent)
- each `mut.*`: writes row AND enqueues exactly one outbox intent with right `base_rev`
- `addTag`/`removeTag` per junction type × 3
- `createTag`/`createAnnotation` mint UUID, honor client id
- `saveProgress`/`saveMediaPos` coalesce by key — 10 calls → 1 intent
- `onIntentSuccess` removes intent + clears dirty; `onIntentRetry` bumps tries;
  `dropIntent` removes without clearing others
- `listOutbox` FIFO order preserved across reopen (**the durability fix — assert it**)
- `wipe()` empties rows, keeps schema, resets cursor to null
- write error → `persistHealth` flagged; next success clears
- highlight joins: `useFeedHighlights` shape == old `highlightsFromStore` output
  (**port the old expectations verbatim so parity is provable**)
- `getSetting`/`setSetting` round-trip incl. overwrite + missing key

## 4b. Keep

`e2e/outbox-unit.mjs` unchanged (pure reducers untouched). `just e2e-offline` still green.

## 4c. `e2e/integration.js` — edit

- `runPersistFailure` → drive the new SQL-write simulator, same visible assertions
- new `runDbLayer`: seed via API → reload → assert list renders from DB with network cut
  (`samizdat_force_offline`) → mutate offline → reload → **assert mutation survived**
  (this is what the old blob store silently lost)
- new `runLargeReplica`: seed ~50 docs w/ bodies, assert no write error, assert feed renders

## 4d. `e2e/smoke.js`

No new page. Verify every existing page still green after the swap.

## 4e. Order of work per step-3c file

For each file: edit → `npx tsc --noEmit` → `just e2e-db` → next. Do NOT batch.

---

# Step 5 — done gate

- `just lint` green, incl. new `check-db-layer`
- `just build` green
- `just e2e-db` all green
- `just e2e-offline` 12/12 still
- `just e2e` green
- `just e2e-int` green incl. `runDbLayer` + `runLargeReplica`
- manual: install APK on device, confirm cursor advances across a restart
  (`journalctl … | grep SYNCED` must show a MOVING `since=`, not a frozen one)

## Risks

- **wa-sqlite bundle**: Metro must serve `.wasm`. If it fight, that is the one place this
  plan can stall on web. Native path is independent — ship native first if needed.
- **Safari incognito**: no OPFS. Driver must fall back, not crash.
- **First full pull** after wipe = 7.8MB, one request, slow. Accepted; show loading.
- Body columns make `documents` rows fat — never `SELECT *` for a list. queries.ts must
  name columns explicitly for list queries.

## Sources

- [Expo SQLite docs](https://docs.expo.dev/versions/latest/sdk/sqlite/)
- [SQLite persistence on the web, May 2026](https://powersync.com/blog/sqlite-persistence-on-the-web)
- [opfs-sahpool needs no COOP/COEP](https://www3.sqlite.org/cgi/forum/info/3b7ca2d0221e0a2a3010b83b1d4d80c6529b782089c3658e56859ef6cc4231d0)
- [COEP breaks YouTube embeds](https://github.com/WordPress/wordpress-playground/issues/411)
