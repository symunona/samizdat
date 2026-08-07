---
created: 2026-08-07
topic: Feed swipe = archive; delete button always visible
excerpt: Swipe-right on a Highlight card archives (marks seen) instead of deleting; the trash button in the card footer stops being desktop-only so touch devices get an explicit, undo-able delete.
status: done (branch feat/feed-swipe-archive, awaiting user check)
---

# Feed swipe → archive, delete → footer button

## Why

Today a swipe-right on a feed card **deletes** the Highlight (5s undo, then a
tombstone). Delete is the destructive end of the lifecycle and it sits behind the
easiest, most accidental gesture, while the reversible action (archive / "seen") is
only reachable by scrolling past. That is backwards.

Meanwhile the footer trash button is gated `!touch`, so on a phone the *only* delete
path is that same accidental swipe.

## Change

1. **Swipe right (left action panel) archives** — `mut.archiveHighlight(id, now)`,
   card dims, per-card **Unread** button appears (existing `handleUnarchive`). Same
   state path the scroll-past auto-archive already uses, so nothing new syncs.
2. **Swipe left (right panel) still stars/pins** — unchanged.
3. **Footer trash is always rendered** (`HighlightCard.tsx`): drop the `!touch` gate.
   Delete keeps its 5s undo card, so an explicit tap needs no confirm dialog.
4. Swipe panels use Ionicons instead of raw emoji glyphs (`🗑`/`★`), per the app UI
   rule.

Parity note: `document-viewer.ts`'s WebView highlight card **already** renders delete
unconditionally, so 3 moves the two renderers closer together, not apart.

## Tests

`e2e/integration.js` → `runFeedSwipeArchive`:
- seed a doc + highlight, open the feed
- pointer-drag the card right past `SWIPE_DRAG_OFFSET` → assert the visible result:
  the **Unread** button appears and the card is still on screen (archived, not gone)
- tap **Unread** → assert it disappears (round-trip)
- re-open the page under **touch emulation** (`hasTouch`/`isMobile` → `pointer: coarse`)
  → assert the footer trash button is rendered; tap it → assert the card flips to the
  "deleted / Undo" state, then Undo restores it

Green `just e2e` + `just e2e-int` + `just lint` + `just build` before done.
