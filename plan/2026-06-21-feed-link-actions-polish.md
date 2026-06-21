---
created: 2026-06-21
topic: Main feed — inline link actions, status icons, touch polish
excerpt: Click link in feed → same LinkActionSheet as doc viewer; non-blocking scrape with inline link/document/spinner icon; hide on-card buttons on touch; show tags; standardize annotate icon; fix markdown link spacing.
status: decided — ready to branch
---

## Resolved decisions (2026-06-21)
- **Non-blocking** = global persistent bottom overlay (`ScrapeQueueProvider`, mounted in `_layout` like ToastProvider). Per scrape: card with link name + spinner; on done → clickable (navigate to doc), auto-dismiss after 10s, X to dismiss now. Survives navigation. Exposes per-url status to feed inline icons.
- **Annotate icon** = icon-only; standardize feed glyph to match doc viewer create-outline (no label/pill).
- **Tags** = add to highlights list API (server `highlights.go`, batch query).

# Main feed link actions + polish

## Goals (from user)
1. Markdown render: links lack surrounding space.
2. Click link → same selector as document viewer.
3. Selector non-blocking.
4. Link already a document → 📄 doc icon next to it.
5. Link not yet a document → 🔗 link icon.
6. Choose "make document" → spinner next to icon (background).
7. Touch device → hide on-card star + delete (swipe only).
8. Show tags on cards.
9. Feed annotate icon == doc viewer annotate icon.

## Architecture — link → document (items 2-6)

### State
- `docByUrl: Map<url,docId>` — seeded in FeedScreen by merging every highlight's `linked_documents` (server already computes this). Source of truth for "is link a document?".
- **`ScrapeQueueProvider`** (global, in `_layout`) owns in-flight + done scrapes: `Map<url,{status:'scraping'|'done'|'error',jobId,docId?,title}>`. Exposes `startScrape(url,title)` and status lookup. Renders interactive bottom overlay cards. Survives navigation.
- MarkdownBody reads scrape status from the provider + `docByUrl` prop for the inline icon.

### MarkdownBody custom `link` rule (mdRules)
Render link text + trailing inline status icon:
- url ∈ docByUrl → 📄 ; tap → navigate `/document/{docId}`
- url ∈ scrapingUrls → `<ActivityIndicator/>`
- else → 🔗 ; tap → `onLinkAction(url)` opens LinkActionSheet
Also fixes spacing (rule controls whitespace around link).

### LinkActionSheet (NEW shared component) — DRY
Extract doc viewer's inline `linkUrl` sheet (`[id].tsx` lines 588-622) into `src/LinkActionSheet.tsx`. Props: `url`, `onReadAsDocument`, `onOpenInBrowser`, `onClose`. Used by BOTH feed and doc viewer.

### Flow
1. Tap 🔗 → open sheet (non-blocking).
2. "Read as document" → FeedScreen `submitScrapeJob(url)`; add `url→jobId` to scrapingUrls; **close sheet immediately**; icon flips 🔗→spinner.
3. Job watcher effect: poll `fetchJob(jobId)` @2s per active url. done → set `docByUrl[url]=document_id`, drop from scrapingUrls (spinner→📄), toast "Document ready". dead → toast error, drop.
4. Tapping 📄 later → navigate to doc.

Non-blocking = sheet dismisses on action, feed stays scrollable, work runs in bg, inline spinner. No full-screen blocking "Scraping…".

## Item 7 — touch hides on-card buttons
HighlightCard: hide header star + footer delete when `window.matchMedia('(pointer: coarse)').matches` (per app/CLAUDE.md — NOT Platform.OS). Keep tags + annotate. Swipe stays primary triage.

## Item 8 — tags on cards
Server: add `tags []` (id+name+color) to highlights list response in `highlights.go listAll` (batch query, avoid N+1). App: render tag chips on HighlightCard. **Backend change → restart `just dev`.**

## Item 9 — annotate icon
Feed already uses `NoteEditButton` (Ionicons create-outline). Doc viewer webview highlight footer uses same create-outline SVG. AWAIT clarify on exact desired difference.

## Test (e2e)
- `just e2e` green.
- agent-browser via `just debug-session`: feed shows 🔗/📄 icons; tap 🔗 → sheet; "Read as document" → spinner → 📄; tap 📄 → doc opens. Touch emulation hides star/delete. Tags render.

## Open questions → AskUserQuestion before branch
- Non-blocking meaning (bg scrape vs non-dimming popover).
- Annotate icon exact desired change.
- OK to add tags to highlights API (backend change)?
