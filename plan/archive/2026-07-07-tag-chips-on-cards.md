---
created: 2026-07-07
topic: Show tag-name chips on feed cards + document reader, tappable to open tag selector
excerpt: Render assigned tag NAME chips above the actions row on the feed HighlightCard, the webview highlight cards, and the document meta panel; tapping a chip opens TagSelectorModal.
status: done
---

# Tag chips on cards

## Problem
The "Tags" button shows on feed cards and the document reader, but assigned tag
NAMES aren't rendered / aren't tappable in every spot.

## Requirements
- Tag NAME chips on the line ABOVE the actions row.
- Wrap to multiple lines on overflow.
- Tapping a chip opens the tag selector (same as the Tags button).
- Fix in BOTH the feed card AND the document reader screen.

## Places (3)
1. `src/HighlightCard.tsx` (RN feed card) — chips already render above footer but
   are non-tappable `View`s. Wrap each chip in a `Pressable` → `onTags`.
2. `src/webview/document-viewer.ts` `renderHighlightCard()` (WebView highlight cards,
   parity partner of #1) — add tag chips above footer, tappable → post `hl_tags`.
   Add `tags` to `HlData`; pass from `toHlData` in `[id].tsx`; add chip CSS.
3. `app/(drawer)/document/[id].tsx` meta panel — fetch document tags, render chips
   above the `metaActions` row, tappable → `handleOpenDocTags`. Refresh via
   TagSelectorModal `onChanged`.

## Shared
- Extract `tagColor(name)` → `src/tagColor.ts` (dependency-free; usable in the
  WebView bundle). Reuse in HighlightCard, TagSelectorModal, doc panel, webview.

## Test
- robot-browser: assign tags to a document + a highlight, confirm chips show + wrap
  on feed card AND doc reader, tapping a chip opens the selector. Screenshot to tmp/.
- `just e2e` green; `just lint` green (parity).
