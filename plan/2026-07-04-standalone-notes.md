---
created: 2026-07-04
topic: Standalone notes — drawer "Notes" screen, parentless annotations
excerpt: New left-drawer "Notes" item. Create/tag random markdown notes not tied to any Document/Highlight, reusing the annotation editor + tag picker. Modeled as parentless Annotations (document_id nullable) per the user's chosen data model.
status: in-progress
---

# Standalone notes

## Decision (user-chosen)
Model a standalone note as a **parentless Annotation** (`document_id` nullable),
NOT a new `Note` entity. Reuses the annotation table, sync, and tagging wholesale.
Trade-offs accepted: a NOT-NULL-drop migration on the live DB, a nullable-pointer
ripple, and export must handle doc-less rows. (Recommended alternative was a real
`Note` entity; user picked speed.)

## Editor/UX (reuse, no change)
`AnnotationPanel` (body + tag button + delete + save) and `TagSelectorModal`
(`objectType='annotation'`) are already generic/controlled with no document
dependency — reused as-is. A note = an Annotation with `document_id = NULL`,
`exact = ''`.

## Slices
1. **Schema + migration** (`store/schema.sql`, `store/open.go`)
   - schema.sql: `annotations.document_id TEXT NOT NULL REFERENCES documents(id)`
     → `TEXT REFERENCES documents(id)` (nullable).
   - open.go `migrate()`: guarded table-rebuild — if `PRAGMA table_info(annotations)`
     shows `document_id` NOT NULL, rebuild the table nullable (explicit column list,
     copy data, drop, rename, recreate indexes) inside a txn. Skip if already nullable
     (fresh/migrated DB). **Test on a COPY of the real DB first; back up app.db.**
2. **sqlc regen + ripple** (`store/queries.sql*`, `api/annotations.go`, `export/export.go`)
   - `Annotation.DocumentID` → `*string`. Fix: `InsertAnnotation` param (`&docID` for
     doc-scoped create), `ListAnnotationsByDocument` param if it becomes `*string`,
     `export.go:185` `dirty[*a.DocumentID]` guarded by nil.
3. **Create endpoint** (`api/annotations.go`, `api/router.go`)
   - `POST /api/v1/annotations` → `createStandalone`: body `{note, color?}`, inserts an
     annotation with `document_id = NULL`, `exact = ''`, server-minted id. 400 if
     `note` empty. Update/delete/tag routes already work (key on annotation id).
4. **Export standalone notes** (`export/export.go`) — honor Rule 2 (everything exports)
   - Sweep: for `annos` with nil `DocumentID`, export directly as a note file (not
     grouped under a doc); tombstones already handled by `removeAnnotation`.
   - `renderAnnotation`: when `docName == ""`, omit the `document:` frontmatter and use
     a plain `> [!note]` quote instead of `From [[doc]]`. `annFilename` already
     doc-independent.
5. **App** (`app/(drawer)/_layout.tsx`, new `app/(drawer)/notes.tsx`, `src/api.ts`,
   `src/store/hooks.ts`)
   - `_layout.tsx`: add `NAV_BLOCKS` row `{name:'notes', label:'Notes', href:'/notes'}`
     + `<Drawer.Screen name="notes" options={{title:'Notes'}}/>`.
   - `notes.tsx`: list (template `tags.tsx`) of `useNotes()`; create-FAB → `AnnotationPanel`
     create → `createNote()`; tap → edit/delete/tag via `AnnotationPanel` + `TagSelectorModal`.
   - `api.ts`: `createNote(url, token, {note, color?})` → `POST /api/v1/annotations`.
     Reuse `updateAnnotation`/`deleteAnnotation`/`*AnnotationTag`.
   - `hooks.ts`: `useNotes()` = `Object.values(annotations)` where `!document_id && !deleted_at`;
     `useAnnotationTags(id)`.
   - Follow app/CLAUDE.md: `IconButton`+Ionicons for new icons; plain `TextInput` for the
     casual note body (already what AnnotationPanel uses).

## E2E self-test (write/verify before calling done)
- **Go (store):** seed a DB at the OLD schema (document_id NOT NULL) with an annotation
  → run `migrate` → assert row data intact, `document_id` now nullable, and inserting a
  NULL-doc annotation succeeds.
- **Go (api):** `POST /api/v1/annotations {note:"random thought"}` → 200, annotation with
  null document_id; `GET /sync` includes it; `POST /annotations/{id}/tags` → sync includes
  the tag link.
- **Export:** create a standalone note → vault gets its note file (no `document:` backlink,
  `[!note]` quote), no crash.
- **App (robot-browser, web build):** drawer shows "Notes" → open → empty state → create
  "test note via robot" → appears in list → open it → attach a tag → tag shows.

## Concurrency note
Another worker has UNCOMMITTED edits in `app/(drawer)/documents.tsx`,
`src/ShareIntentBridge.tsx`, `app/CLAUDE.md`. This feature touches `_layout.tsx` (not
theirs) + new files, so low conflict risk. Do NOT stage their files.

## Merge
Per repo workflow: implement on branch `feat/standalone-notes`, small commits, then ASK
the user to verify before squash-merging to main.
