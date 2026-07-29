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
