---
created: 2026-06-17
topic: WebView document viewer — standalone esbuild JS bundle
excerpt: Extract all document-viewer logic into a compiled vanilla JS bundle, communicate with RN via a typed postMessage protocol, enable fully interactive highlights (pin/delete/annotate/tags) inside the WebView without native overlays.
status: planning
---

# WebView Document Viewer — Standalone JS Bundle

## Motivation

The current approach has three problems:

1. **Highlights are a native overlay** (`HighlightsBanner`) that sits above the WebView — they don't scroll with the document and feel disconnected from the content.
2. **HTML string injection is a dead end** — the old `displayHtml` useMemo prepended highlights as static HTML, with no way to update them without reloading the whole WebView and losing scroll position.
3. **WebView logic is scattered** — scroll tracking, annotation mark rendering, link handling, and now theme injection are all spread between inline `<script>` tags in `buildDocumentHtml` and `injectJavaScript` calls from RN.

**Goal**: Compile a single `document-viewer.ts` into a self-contained IIFE bundle via esbuild. The WebView becomes a proper mini-app controlled entirely by postMessage. RN owns state; the WebView is a pure render target.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  React Native (DocumentViewer component)                        │
│                                                                 │
│  State: doc, highlights[], annotations[], hlExpanded, theme     │
│                                                                 │
│  on 'ready'  ──────────────────────────────────────────────►   │
│  { type:'init', doc, highlights, annotations, theme, hlExp }   │
│                                                                 │
│  on hl_pin/delete ─────────────────────────────────────────►   │
│  { type:'setHighlights', highlights[], expanded }              │
│                                                                 │
│  on theme change ──────────────────────────────────────────►   │
│  { type:'setTheme', theme }                                     │
│                                                                 │
│  ◄──────────────────────── 'ready'                             │
│  ◄──────────────────────── 'scroll', 'selection' (existing)    │
│  ◄──────────────────────── 'tap_annotation', 'link_press'      │
│  ◄──────────────────────── 'hl_pin', 'hl_delete'  (new)       │
│  ◄──────────────────────── 'hl_annotate', 'hl_tags' (new)     │
│  ◄──────────────────────── 'hl_toggle_section'  (new)          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  WebView / iframe  (srcdoc from buildDocumentHtml)        │  │
│  │                                                           │  │
│  │  document-viewer.ts (compiled IIFE, inlined as <script>)  │  │
│  │                                                           │  │
│  │  Page structure (rendered by JS on 'init'):               │  │
│  │    <h1>  document title                                   │  │
│  │    <section id="hl">  highlights (collapsible)            │  │
│  │      <button id="hl-toggle"> Highlights (N) [▲/▼]        │  │
│  │      <div id="hl-list">  highlight cards                  │  │
│  │        [kind] Title                                        │  │
│  │        body text (markdown pre-rendered by Go)            │  │
│  │        [★ pin]  [# tags]  [✎ annotate]  [🗑 delete]      │  │
│  │    <article id="sam-article">  pre-rendered HTML          │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## postMessage Protocol

All messages are JSON. The helper `sendMsg(obj)` in the bundle handles platform differences (`ReactNativeWebView.postMessage` vs `window.parent.postMessage`).

### RN → WebView

```ts
type RNToWebView =
  // Full init — sent once on 'ready'. WebView renders everything from this.
  | {
      type: 'init'
      doc: { title: string; articleHtml: string }   // articleHtml = pre-rendered markdown
      highlights: HlData[]
      annotations: AnnData[]
      theme: ThemeData
      hlExpanded: boolean
      scrollFraction: number                          // restore saved position
      focusAnnotationId?: string                      // deep-link to annotation
    }
  // Re-render highlights section only — no article touch, no scroll reset
  | { type: 'setHighlights'; highlights: HlData[]; expanded: boolean }
  // Swap CSS variables — no reload
  | { type: 'setTheme'; theme: ThemeData }
  // Existing (keep as-is)
  | { type: 'scrollTo'; fraction: number }
  | { type: 'addMark'; annotation: AnnData }
  | { type: 'removeMark'; id: string }
  | { type: 'highlightAnnotation'; id: string }

type HlData = {
  id: string
  kind: string           // 'summary' | 'link' | 'note'
  title: string
  bodyHtml: string       // markdown pre-rendered by Go — avoids bundling a md renderer
  pinned: 0 | 1
}

type ThemeData = {
  background: string; text: string; surface: string
  border: string; accent: string; muted: string
}

type AnnData = { id: string; exact: string; prefix: string; suffix: string; color: string; note: string }
```

### WebView → RN

```ts
type WebViewToRN =
  | { type: 'ready' }                         // page loaded, RN should send 'init'
  // Existing
  | { type: 'scroll'; fraction: number }
  | { type: 'selection'; data: SelectionData }
  | { type: 'tap_annotation'; id: string }
  | { type: 'link_press'; href: string; doc_id?: string }
  // New — highlight actions
  | { type: 'hl_pin'; id: string }            // toggle pin
  | { type: 'hl_delete'; id: string }         // delete highlight
  | { type: 'hl_annotate'; id: string }       // open annotation panel for this highlight
  | { type: 'hl_tags'; id: string }           // open tag selector for this highlight
  | { type: 'hl_toggle_section' }             // user tapped the collapse toggle
```

---

## Build Pipeline

```
app/src/webview/document-viewer.ts
    │
    │  just webview-build
    │  esbuild --bundle --platform=browser --format=iife
    ▼
app/src/webview/document-viewer-bundle.ts   ← auto-generated, gitignored
    export const DOCUMENT_VIEWER_JS = `...compiled IIFE...`
    │
    │  import in markdownToHtml.ts
    ▼
buildDocumentHtml() inlines as <script>${DOCUMENT_VIEWER_JS}</script>
    │
    ▼
WebView srcdoc / source.html
```

### `just webview-build` recipe

```bash
esbuild app/src/webview/document-viewer.ts \
  --bundle \
  --platform=browser \
  --format=iife \
  --outfile=/tmp/dvbuild.js \
  --minify \
&& node scripts/wrap-webview-bundle.mjs
```

### `scripts/wrap-webview-bundle.mjs`

Reads `/tmp/dvbuild.js`, escapes backticks/backslashes, writes:

```ts
// AUTO-GENERATED by `just webview-build` — do not edit manually
export const DOCUMENT_VIEWER_JS = `...escaped bundle...`
```

### Justfile additions

```makefile
webview-build:
    @echo "Building document-viewer bundle..."
    esbuild app/src/webview/document-viewer.ts --bundle --platform=browser --format=iife --outfile=/tmp/dvbuild.js --minify
    node scripts/wrap-webview-bundle.mjs

# dev and build depend on webview-build
dev: webview-build
    ...

build: webview-build
    ...
```

### .gitignore

Add: `app/src/webview/document-viewer-bundle.ts`

---

## document-viewer.ts Structure

```ts
// 1. Platform-aware sendMsg
function sendMsg(data: object): void

// 2. CSS — base reset + typography + highlight card styles
//    Theme colors injected as CSS vars on <html> via setTheme
const BASE_CSS: string

// 3. State
let state: { highlights: HlData[]; expanded: boolean; initialized: boolean }

// 4. Render — highlights section
function renderHighlights(): void          // rebuilds #hl-list + updates counter
function renderHighlightCard(hl: HlData): HTMLElement

// 5. Render — full init
function handleInit(msg: InitMsg): void    // injects title h1, hl section, article HTML, restores scroll

// 6. Message handler (switch on msg.type)
window.addEventListener('message', handler)

// 7. Existing logic (ported from current buildDocumentHtml inline script):
//    - scroll tracking + sendMsg({ type: 'scroll', fraction })
//    - text selection → sendMsg({ type: 'selection', data })
//    - annotation marks: addMark, removeMark
//    - ann-btn show/hide
//    - ann-gutter dots
//    - link click handler → sendMsg({ type: 'link_press', ... })

// 8. Bootstrap — send 'ready' immediately
sendMsg({ type: 'ready' })
```

**Highlight card HTML structure** (rendered by `renderHighlightCard`):

```html
<div class="hl-card" data-id="<id>">
  <div class="hl-header">
    <span class="hl-kind hl-kind-<kind>"><kind></span>
    <span class="hl-title"><title></span>
  </div>
  <div class="hl-body"><bodyHtml></div>
  <div class="hl-footer">
    <button class="hl-btn hl-pin" data-id="<id>">☆</button>
    <button class="hl-btn hl-tags" data-id="<id}"># Tags</button>
    <button class="hl-btn hl-annotate" data-id="<id>">✏ Note</button>
    <button class="hl-btn hl-delete" data-id="<id>">🗑</button>
  </div>
</div>
```

Footer buttons use event delegation on `#hl-list` — one listener, pattern-match `dataset.id` + button class.

---

## RN-side Changes (DocumentViewer component)

### Remove
- `HighlightsBanner` component and `buildBannerStyles`
- `hlExpanded`, `toggleHlSection`, `handleHlPin`, `handleHlDeleteInPane`
- `injectThemeCss` callback (replaced by `sendTheme`)
- The existing theme `useEffect` that calls `injectThemeCss`

### Add
```ts
// Send typed message to WebView (replaces injectJavaScript / postMessage calls)
const sendToWebView = useCallback((msg: RNToWebView) => {
  const json = JSON.stringify(msg)
  if (Platform.OS === 'web') {
    iframeRef.current?.contentWindow?.postMessage(json, '*')
  } else {
    webViewRef.current?.injectJavaScript(`window.__handleMsg(${json}); true;`)
  }
}, [])

// Send theme whenever colors change
const sendTheme = useCallback(() => {
  sendToWebView({ type: 'setTheme', theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu } })
}, [sendToWebView, bg, fg, su, bo, ac, mu])

// Replace injectThemeCss useEffect with:
useEffect(() => {
  if (!isDocLoadedRef.current) return
  sendTheme()
}, [sendTheme])
```

### handleParsedMessage additions

```ts
case 'ready':
  isDocLoadedRef.current = true
  sendToWebView({
    type: 'init',
    doc: { title: doc?.title ?? '', articleHtml: htmlContent ?? '' },
    highlights,
    annotations,
    theme: { background: bg, text: fg, surface: su, border: bo, accent: ac, muted: mu },
    hlExpanded,
    scrollFraction: savedProgressRef.current,
    focusAnnotationId: highlight,
  })
  savedProgressRef.current = 0
  break

case 'hl_pin': {
  const hl = highlights.find(h => h.id === msg.id)
  if (!hl || !activeUrl || !token) break
  const next = hl.pinned !== 1
  pinHighlight(activeUrl, token, msg.id, next)
    .then(() => {
      setHighlights(prev => {
        const updated = prev.map(h => h.id === msg.id ? { ...h, pinned: next ? 1 : 0 } : h)
        sendToWebView({ type: 'setHighlights', highlights: updated, expanded: hlExpanded })
        return updated
      })
    })
    .catch(() => toast('Failed to update pin', 'error'))
  break
}

case 'hl_delete':
  if (!activeUrl || !token) break
  deleteHighlight(activeUrl, token, msg.id)
    .then(() => {
      setHighlights(prev => {
        const updated = prev.filter(h => h.id !== msg.id)
        sendToWebView({ type: 'setHighlights', highlights: updated, expanded: hlExpanded })
        return updated
      })
    })
    .catch(() => toast('Failed to delete highlight', 'error'))
  break

case 'hl_annotate':
  // Open annotation panel linked to this highlight
  setPendingSelection({ exact: '', prefix: '', suffix: '', pos_start: 0, pos_end: 0, highlight_id: msg.id })
  setAnnMode('create')
  setExistingAnnotation(undefined)
  setAnnVisible(true)
  break

case 'hl_tags':
  setTagTargetId(msg.id)
  setTagTargetType('highlight')
  setTagModalVisible(true)
  break

case 'hl_toggle_section':
  setHlExpanded(prev => {
    const next = !prev
    AsyncStorage.setItem(`doc_hl_exp_${id}`, next ? '1' : '0').catch(() => {})
    sendToWebView({ type: 'setHighlights', highlights, expanded: next })
    return next
  })
  break
```

### handleDocumentLoad

Remove — the `ready` message from the WebView replaces the `onLoad` callback. `onLoad` still fires but only for the iframe `onLoad` fallback if needed.

### buildDocumentHtml changes

- Import `DOCUMENT_VIEWER_JS` from `./webview/document-viewer-bundle`
- Simplify template: no inline `<script>` blocks, no `window.__annotations`, no scroll tracking code
- Body contains only: `<div id="sam-article">${articleHtml}</div>`, `<button id="ann-btn">`, `<div id="ann-gutter">`
- The viewer JS handles everything else on `init`

### HlData.bodyHtml — Go server change

The API response for highlights should include pre-rendered `body_html` field (markdown → HTML, done in Go). This avoids bundling a Markdown renderer in the WebView JS. Alternatively, bundle a tiny md renderer (e.g. `marked` minified is ~40KB).

**Decision**: Pre-render in Go. Cheaper in bundle size, consistent with how article HTML is already produced.

---

## HTML template (simplified buildDocumentHtml output)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapedTitle}</title>
<script>${DOCUMENT_VIEWER_JS}</script>
</head>
<body>
<div id="sam-article">${articleHtml}</div>
<div id="ann-gutter"></div>
<button id="ann-btn">Annotate</button>
</body>
</html>
```

The viewer script sends `ready` on load. RN responds with `init`. The viewer inserts `<h1>` and `<section id="hl">` before `#sam-article`.

---

## Files Touched

| File | Change |
|------|--------|
| `app/src/webview/document-viewer.ts` | **NEW** — the bundle source |
| `app/src/webview/document-viewer-bundle.ts` | **AUTO-GENERATED** (gitignored) |
| `scripts/wrap-webview-bundle.mjs` | **NEW** — wraps esbuild output as TS export |
| `app/src/markdownToHtml.ts` | Import bundle, simplify HTML template, add `articleHtml` param |
| `app/app/(drawer)/document/[id].tsx` | Remove HighlightsBanner, add hl_* handlers, send init on ready |
| `server/` Go | Add `body_html` field to highlight API response |
| `justfile` | Add `webview-build`, depend from `dev` + `build` |
| `.gitignore` | Add `app/src/webview/document-viewer-bundle.ts` |
| `e2e/smoke.js` | Add highlight section toggle test |

---

## Open Questions

1. **`body_html` in Go API**: Easiest to render in Go using `blackfriday` or `goldmark`. Goldmark is already used elsewhere? Check server deps.

2. **`highlight_id` on Annotation**: `PendingSelection` type may need a `highlight_id?: string` field added so the annotation panel can tag which highlight it came from.

3. **Scroll restore on `init`**: Currently `handleDocumentLoad` fires after the iframe/WebView loads and calls `injectScrollTo`. With the new flow, `scrollFraction` is sent in `init` and the viewer JS handles it. Remove `handleDocumentLoad` or keep as fallback?

4. **`onLoad` iframe event on web**: The iframe `onLoad` fires before `ready` in some cases. Keep `ready` as the canonical trigger; drop `onLoad`-based init.

---

## E2E Test Additions

- Document with highlights: verify section renders above article
- Toggle collapse: section collapses, counter stays visible
- Pin highlight: card updates (star filled), state persists on reload
- Delete highlight: card removed, counter decrements

---

## Implementation Order

1. Go: add `body_html` to highlight API response
2. `scripts/wrap-webview-bundle.mjs` + `just webview-build`
3. `document-viewer.ts`: port existing inline JS, add hl section render
4. `markdownToHtml.ts`: import bundle, simplify template
5. `document/[id].tsx`: wire `ready`→`init`, add hl_* handlers, remove HighlightsBanner
6. Smoke test additions
7. `just build` green, `just e2e` green
