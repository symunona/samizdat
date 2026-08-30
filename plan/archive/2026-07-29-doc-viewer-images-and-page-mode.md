---
created: 2026-07-29
topic: Document viewer — image lightbox + page mode
excerpt: Tapping an image in the document body opens a zoomable lightbox; a "Page mode" toggle in the doc meta panel paginates the document into swipeable/keyboard-navigable pages.
status: in-progress
---

# Document viewer: image lightbox + page mode

Two independent features on the document viewer (`app/app/(drawer)/document/[id].tsx`
+ the WebView bundle `app/src/webview/document-viewer.ts`).

## Context

The document body is **raw DOM inside a WebView** (native) / **iframe** (web), built by
`document-viewer.ts` and compiled to `document-viewer-bundle.ts` via `just webview-build`.
It talks to the RN host over `postMessage` (`sendMsg` → `handleMessage` in `[id].tsx`).

`src/ImageViewer.tsx` already implements a tap-to-zoom lightbox, but it is a **React Native**
component used only by `MarkdownBody` (highlight bodies). Images in the document body are
plain `<img>` with CSS only (`BASE_CSS`: `img{max-width:100%;…}`) — **no tap handler at all**.
That is the gap.

---

## Feature 1 — image lightbox in the document body

**Goal:** tapping/clicking any `<img>` in the document body pops a full-screen zoomable viewer.

### Design

1. `document-viewer.ts`: add a click delegate on `img` (skip imgs inside a highlight card's
   controls). Post `{type:'image_tap', src, alt}`. Guard: do not fire while a swipe/selection
   gesture is in progress.
2. `ImageViewer.tsx`: extract the modal into a **controlled** `ImageLightbox`
   (`src`, `alt`, `onClose`) and have `ImageViewer` render thumb + `ImageLightbox`. DRY —
   one lightbox implementation, two callers.
3. `[id].tsx`: handle `image_tap` → `setLightbox({src, alt})` → render `<ImageLightbox …>`.
   Src absolutization already happens for the WebView HTML (`markdownToHtml.ts:28`), and
   `ImageViewer` re-absolutizes relative `/api/v1/media/...` via `activeUrl` — keep that path
   (see memory: native RN `Image` cannot resolve relative URLs).
4. Rebuild the bundle (`just webview-build`).

### Test
- e2e/integration: open a document with an image, click the `img` inside the iframe, assert
  the lightbox overlay is visible and closes on ✕.

---

## Feature 2 — page mode

**Goal:** a "Page mode" toggle in the doc meta panel (⋮ → right sheet). When on, the document
is broken into discrete pages sized to the current viewport; navigate by horizontal swipe
(touch) or scroll / ← → keys (desktop). Recalculate on resize, throttled.

### Design

- **Where:** entirely inside the WebView (`document-viewer.ts`), because that is where the
  laid-out body lives — only it knows real box heights. RN host owns only the toggle + persistence.
- **Pagination:** CSS columns on a fixed-height container
  (`column-width: 100vw; height: 100vh; overflow-x: auto`) + `scroll-snap-type: x mandatory`
  on the scroller with `scroll-snap-align: start` per page. This lets the browser do the
  reflow; no manual box measuring.
- **Recalc:** `ResizeObserver` on the body, throttled (~150ms) → re-measure page count, clamp
  the current page index so the reader keeps their place.
- **Summaries / highlights:** the highlights section and any summary block become **their own
  page each** (`break-before: column; break-after: column`), and are individually scrollable
  (`overflow-y:auto`) rather than being paginated — the user explicitly accepts cut content there.
- **Navigation:** pointer drag (reuse the existing swipe plumbing's thresholds), `wheel` →
  page step, `ArrowLeft`/`ArrowRight` keys. A page indicator (`n / N`) pinned bottom-centre.
- **Toggle:** RN meta panel row (Switch) → `sendMsg({type:'setPageMode', on})` into the WebView;
  persisted per-user in the app store so it survives reopening.
- **Interactions preserved:** annotation selection, highlight cards and the gutter must keep
  working in page mode (the gutter is absolutely positioned against the body — verify).

### Test
- e2e/integration: toggle page mode, assert the body gets the page-mode class, assert
  ArrowRight advances the page index, resize the viewport and assert the page count recalcs.

---

## Status log
- 2026-07-29 — plan written.
- 2026-07-29 — **feature 1 DONE**: `ImageLightbox` extracted from `ImageViewer`,
  `image_tap` posted from the viewer's click delegate (checked before links so a linked
  figure zooms instead of navigating), handled in `[id].tsx`. Verified live in
  agent-browser (screenshot `tmp/screenshots/image-lightbox.png`) + 4 new checks in
  `e2e/integration.js` (`runImageLightbox`) — `just e2e-int` 31/31 green.
- 2026-07-29 — feature 2 delegated.
- 2026-07-29 — **feature 2 DONE**. CSS columns held up; scroll-snap did not.

  **Approach as built.** `html.pg` (set by the viewer) turns the *body* into a
  horizontal multi-column scroller: `column-width:var(--pgw)` + `column-fill:auto`
  on a `100vh` box, `html{overflow:hidden}` so the body's overflow is NOT
  propagated to the viewport and the body really is the scroll container. Every
  page-mode rule is scoped to `html.pg` and **no DOM node is added or moved**, so
  with the toggle off the reader is byte-identical, and body-text offsets — hence
  every annotation anchor — are the same in both modes.

  **Deviations from the plan, with reasons:**
  - *No `scroll-snap`.* Column boxes are anonymous; nothing can carry
    `scroll-snap-align`, so CSS snapping is impossible on a multicol. Replaced by
    native panning + a 140ms scroll-idle snap to the nearest page (`onBodyScroll`).
    That also removes the need for a bespoke pointer-drag: on touch, the body's own
    horizontal pan IS the "pull left/right", and it settles on a page. Desktop gets
    wheel steps (one page per gesture, 320ms cooldown, yielding to an inner
    scroller) and ←/→ handled inside the frame (the frame swallows keydown).
  - *One page per highlight card, not one page for the whole section* — the user's
    wording ("make them one per page, they can scroll within"). `.hl-card` gets
    `max-height:var(--pgh); overflow-y:auto; break-after:column`: a scroll container
    never fragments, so the card is placed whole in one column and scrolls
    internally when it doesn't fit. Same cap on `pre`/`img` (both are already
    monolithic, so uncapped they would spill past their page). The section chrome
    and its collapse toggle are hidden in page mode.
  - *Card swipe-triage is off in page mode* — a horizontal drag turns the page
    there; the footer buttons still pin/delete. `touch-action` is reset to `auto`
    on the card, otherwise the base `pan-y` would swallow the page pan.
  - *Gutter:* dots position by page index (`gutterPct`) instead of pixel height,
    and a dot click calls the new `revealElement` (page jump vs `scrollIntoView`),
    shared with `highlightAnnotation` and the `focusId` deep-link.
  - *Progress:* one `reportFraction` used by both modes — vertical position when
    scrolling, `pageIdx/(pageCount-1)` when paginated; `seekFraction` restores in
    whichever mode is active.
  - *Resize:* throttled 150ms (leading + one trailing). **Bug found and fixed
    live:** resizing with an anchor read *inside* the handler loses the reader's
    place, because `resize` fires AFTER the browser has already reflowed. The
    anchor is now captured whenever the scroll settles (`_anchor`), with a
    proportional fallback. Verified: the element at the top of page 41/85 landed
    exactly on page 30/63 after a resize, indicator 30/63.
  - Preference is **global** (`samizdat_page_mode`), not per-doc — it's a reading
    preference. The pagination lives entirely in the WebView; the host owns only
    the meta-panel `Switch` + persistence + the `pageMode` field on `init`.

  **Verified:** `just lint` clean (incl. `spec parity` OK), `just build`,
  `just webview-build`, `just e2e` green, `just e2e-int` 39/39 (7 new page-mode
  checks). Live in agent-browser on a 109-page real document: real ArrowLeft/Right
  keypresses with focus in the frame, a synthetic wheel gesture, a mid-page free
  pan settling onto a page boundary, selection→Annotate, image→lightbox, gutter dot
  → page jump, highlight pin, internal card scrolling at 390px wide, and toggle
  off restoring continuous scroll. Screenshots in `tmp/screenshots/pagemode-*.png`.
  **Not verifiable headless:** a real finger swipe on Android — it rides the
  WebView's native horizontal overflow scroll, which no synthetic event exercises.
