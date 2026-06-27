---
created: 2026-06-26
topic: Feed scroll image-flicker fix + drawer sidebar reorg
excerpt: Stop RN Image remount/flicker on feed scroll; regroup drawer nav into Feed(Main/Starred/Archived) sections; add a Starred view backed by a server pinned=1 filter.
status: done — merged to main
---

# Feed perf + sidebar nav

Two unrelated UX asks bundled into one branch (`feat/feed-perf-sidebar-nav`, off `main`).

## 1. Feed scroll image flicker

**Symptom:** scrolling the feed re-renders/reloads every visible image (flicker).

**Root cause (not image onLoad — that was the hypothesis, disproved):**
`index.tsx` `onScroll` calls `setArchivedIds` mid-scroll → `renderItem` (useCallback dep on `archivedIds`) gets a new identity → FlatList re-renders rows → unmemoized `HighlightCard` re-renders → passes fresh inline `onDocumentPress`/`onLinkAction` arrows → defeats `memo(MarkdownBody)` → its `rules` useMemo rebuilds → `ImageViewer`/RN `Image` remount → remote URI reloads → flicker.

**Fix (surgical):** hoist `onDocumentPress` + `onLinkAction` in `index.tsx` to stable `useCallback` refs (neither depends on `item`). `memo(MarkdownBody)` then holds across scroll re-renders (children/linkedDocuments already stable), so `Image` is not remounted. No change to MarkdownBody/ImageViewer/HighlightCard.

## 2. Drawer sidebar reorg

Target structure (`app/app/(drawer)/_layout.tsx`):

```
Feed                (section header)
  Main              -> /          (was "Feed")
  Starred           -> /starred   (NEW)
  Archived          -> /archived
Documents           -> /documents
Tags                -> /tags
────────────────
Subscriptions       -> /subscriptions
Pipelines           -> /pipelines
Jobs                -> /jobs
────────────────
Settings            -> /settings
[Dark mode toggle]  (footer)
```

- Replace flat `SCREENS` array with a grouped model (headers + indent + separators).
- Remove **Disconnect** from drawer footer (already available in Settings). Keep theme toggle.

### Starred view (new)
No server pinned-list filter exists today (only `archived=1`). Add one to mirror Archived:
- `queries.sql`: `ListPinnedHighlights` = `... WHERE deleted_at IS NULL AND pinned = 1 ORDER BY created_at DESC LIMIT ?`
- sqlc generate
- `highlights.go listAll`: add `pinned=1` branch
- `api.ts fetchHighlights`: add `pinned` flag → `?pinned=1`
- `app/(drawer)/starred.tsx`: mirror `archived.tsx`; action = unpin (restore removes from list)

## Verify
- `just build`, `just lint` (incl. parity — no HighlightCard action change, should pass)
- add `starred` to `e2e/smoke.js` PAGES; `just e2e` green
- agent-browser: scroll feed, confirm no image flicker; check sidebar groups + Starred loads
- restart `just dev` (server changed)
