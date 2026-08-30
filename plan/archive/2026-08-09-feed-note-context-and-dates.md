---
created: 2026-08-09
topic: Feed note indicator, visible ingest-vs-published dates, selection context in the annotation composer, and killing the doc-viewer highlight swipe
excerpt: Four UI fixes on the highlight card and the annotation panel. The feed sorts by highlights.created_at DESC but renders documents.published_at, so the order looks random; a highlight with a note looks identical to one without; the annotation composer never shows the text you selected; and the doc viewer's highlight cards steal horizontal drags for a pin/delete triage that duplicates buttons already in the footer.
status: built + verified (just e2e-int 125/125, just e2e 25/25, just build, agent-browser walkthrough on the dev server). `just lint` mechanical checks pass; lint-parity detects both card renderers changed but its LLM review step cannot run here — ANTHROPIC_API_KEY in this shell is rejected by the API.
---

## Why

Four separate complaints, all on the highlight card / annotation path.

1. **Doc-viewer highlight swipe** — `document-viewer.ts:1024-1119` gives every `.hl-card`
   in the WebView a pointer-drag triage (right → delete, left → star), with
   `touch-action:pan-y` on the card (`:153`). The same two actions are **already
   unconditional buttons in the card footer** (`:283` trash, star/pin), so the gesture
   buys nothing and costs accidental deletes plus a swallowed horizontal pan.
   *Scope confirmed with the user: only this swipe. Page-turn (native horizontal
   overflow scroll, no bespoke handler) and the RN feed's `ReanimatedSwipeable`
   (`app/(drawer)/index.tsx:338`) stay.*

2. **A highlight with a note is invisible as such.** `Annotation.highlight_id` exists
   (`api.ts:606`, local index `db/queries.ts:63`) and is already queried by
   `HighlightDetail.tsx:51` via `db.useAnnotationsFor({highlightId})`, but no card reads
   it. Zero API change needed — the replica already has the link.

3. **Ordering is invisible / contradicted by the shown date.**
   - Server: `queries.sql:514` — `ORDER BY created_at DESC` on `highlights`.
   - Replica: `db/hooks.ts:44` — same key, same direction.
   - Card: `HighlightCard.tsx:41-46,130` renders `document_published_at`.
   So the list is ordered by ingest and labelled by publication. Two different dates.
   Fix = show the sort key, and make BOTH readable on demand.

4. **The annotation composer never shows what you selected.** `PendingSelection`
   (`AnnotationPanel.tsx:15-21`) is exported from the panel's own file yet is not one of
   its props; every caller keeps the selection in local state and only uses it at save
   time (`document/[id].tsx:240,523`). On a long article you tap Annotate and get a bare
   textarea with no idea which sentence you anchored.

## What changes

### 1. Remove the WebView highlight-card swipe (`src/webview/document-viewer.ts`)

Delete, not gate — no dead code:
- the `#hl-swipe-hint` CSS block (`:155-159`) and its comment,
- `touch-action:pan-y` on `.hl-card` (`:153`) plus the page-mode `touch-action:auto`
  reset that exists only to undo it (`:217-220`),
- `SWIPE_START/SWIPE_TRIGGER/SWIPE_MAX`, `_swipe`, `swipeHint()`, `updateSwipeHint()`,
  `clearSwipe()`, the `pointerdown`/`pointermove`/`pointerup`/`pointercancel`
  listeners and `endSwipe()` (`:1024-1119`),
- the `.hl-swiping` CSS.

`hl_pin` / `hl_delete` messages and their host handlers (`document/[id].tsx:460,470`)
stay — the footer buttons post them.

Regenerate `document-viewer-bundle.ts` with `just webview-build` (generated, gitignored,
never hand-edited).

### 2. Note indicator on the highlight card — BOTH renderers

Rule: `hasNote` = at least one non-deleted `Annotation` with `highlight_id = hl.id`.

- **RN (`src/HighlightCard.tsx`)** — new optional prop `hasNote?: boolean` (the card
  stays presentational; the screens own the data read, matching how `pinned`/`tags`
  already arrive). Feed / starred / archived pass
  `db.useAnnotationsFor({highlightId: item.id}).length > 0`, derived once per screen
  into a `Set<string>` so a FlatList row does not mount a hook each.
  - card style: `borderStyle: 'dotted'`, `borderColor: t.colors.accent`,
    `borderWidth: 2`. `cardPinned` (solid accent 2px) still wins when both are true —
    the ★ is the pinned tell, and the accent note icon below still marks the note.
  - `NoteEditButton` gets `color={t.colors.accent}` when `hasNote`.
- **WebView (`src/webview/document-viewer.ts` `renderHighlightCard`)** — mirror it:
  `HlData` gains `hasNote`, the card gets `border:2px dotted var(--ac)`, the annotate
  glyph gets `fill/stroke: var(--ac)`. The host (`document/[id].tsx`) computes the flag
  from the same `db.useAnnotationsFor` source when it builds the highlight payload.

`just lint-parity` enforces the mirroring; both files change in the same commit.

### 3. Dates: sort key visible, both dates on demand (`src/DateStamp.tsx`, new)

One small reusable component, because the same stamp will be wanted on Documents later.

- **Primary label = the sort key**: `highlight.created_at` ("ingested"), formatted as
  today's `publishedLabel` is. This is what the list is actually ordered by, so the
  order stops looking random.
- **Detail text** (two labelled lines, missing values omitted):
  ```
  Ingested 9 Aug 2026, 14:32
  Article created 3 Aug 2026
  ```
- **Reveal, per input type — `isTouchDevice()` (`src/touch.ts`), never `Platform.OS`**
  (app/CLAUDE.md: web ≠ desktop):
  - non-touch: a real hover tooltip. RNW does not forward a `title` prop, so set it on
    the host node from a ref in an effect (`el.setAttribute('title', detail)`), guarded
    to web.
  - touch: `onLongPress` → existing `ToastContext` (`src/ToastContext.tsx`) with the
    same detail string. No new overlay primitive.
- `HighlightCard.tsx:41-46,130` swaps `publishedLabel` for `<DateStamp>` fed both
  `item.created_at` and `item.document_published_at`.
- **Replica gap to close:** `selectHighlights` (`db/hooks.ts:38-56`) never joins
  `document_published_at` (nor `source_feed_title`/`added_via`), so offline the card has
  no published date at all today. Add `document_published_at: d?.published_at ?? null`
  to that projection — `DocumentMeta` already carries it — otherwise the tooltip's
  second line is permanently missing on the offline path.

### 4. Selected text in the annotation composer (`src/AnnotationPanel.tsx`)

- New optional prop `selection?: PendingSelection` (the type already lives in this file).
- Above the note input, when `selection.exact` (create) or `existing.exact` (edit) is
  non-empty, render a quoted context block: left accent rule, italic muted text, clipped
  to ~4 lines with `numberOfLines` so a long selection cannot push the input off screen.
  Nothing renders when the anchor is empty (doc-level note, standalone note).
- Wire every caller to pass what it already holds:
  `document/[id].tsx:662`, `HighlightDetail.tsx:211`, `VideoDocument.tsx:986`,
  `index.tsx:470` (feed — it fakes the anchor as `body.slice(0,300)`; pass that same
  value so the panel shows exactly what will be anchored), `notes.tsx:167` (none).

## E2E self-tests (write first, `e2e/integration.js`)

1. `runDocViewerNoSwipe` — open a doc with highlights, pointer-drag an `.hl-card`
   140px right; assert `card.style.transform` stays empty, `#hl-swipe-hint` never
   exists, and the highlight is still present after `pointerup`. Also assert the footer
   trash button still deletes (the capability must survive the gesture removal).
2. `runFeedNoteIndicator` — seed a highlight, POST an annotation with its
   `highlight_id`, load `/`; assert the card's computed `border-style` is `dotted` and
   its border colour is the accent, and that a sibling card without a note is `solid`.
   Negative half is what makes it a real test.
3. `runFeedDateStamp` — assert the visible label equals the **ingest** date (not the
   published one) for a fixture where the two differ, that the host node's `title`
   contains both `Ingested` and `Article created`, and that feed order matches
   `created_at DESC`.
4. `runAnnotationSelectionContext` — extend `runSelectionLifecycle`: after the
   multi-node selection opens the panel, assert the panel shows the selected string
   (the hard case, crossing the inline `<a>`) *above* the textarea, and that re-opening
   an existing mark shows its stored `exact`.

Plus `just e2e`, `just lint` (incl. `lint-parity`), `just build`.

## Not doing

- No server change. No new API field — the annotation↔highlight link is already synced.
- No change to the ordering itself. `created_at DESC` is correct; it was only unlabelled.
