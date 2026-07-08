---
created: 2026-07-08
topic: Selection-based annotations in the highlight details overlay
excerpt: >
  Make the highlight "more" overlay a WebView/iframe (reusing the document-viewer
  bundle + AnnotationPanel) so the user can select text → create a highlight-anchored
  annotation (W3C TextQuoteSelector), and existing highlight annotations render as marks.
status: in-progress
---

# Highlight selection annotation

## Problem
Tapping a highlight card body opens a details overlay (`HighlightCard.tsx` `<Modal>`
rendering `MarkdownBody` in a `ScrollView`). Text there is NOT selectable, so you can't
annotate a passage of a highlight. The document viewer already does exactly this for
documents (select → anchored annotation, marks). Bring that to the highlight overlay.

## Design decision: dedicated focused host (not a shared extraction)
The doc viewer (`app/(drawer)/document/[id].tsx`, ~830 lines) tangles the WebView-annotation
host with doc-only concerns: header animation, meta/info side panel, highlights section,
reading-progress persistence, video early-return, pipeline queueing, tag/link modals.
Extracting a shared host would mean untangling all of that — high risk, low reuse for the
overlay, which needs only: render body HTML, selection→annotate, marks, tap→edit.

So: a **new focused component `app/src/HighlightDetail.tsx`** that reuses the two genuinely
shared pieces — the compiled **document-viewer bundle** (its selection + mark + message
protocol are body-agnostic; NO bundle change needed) and **`AnnotationPanel`**. The overlay
`<Modal>` moves out of `HighlightCard.tsx` into `HighlightDetail`; the card keeps its
`modalOpen` state + tap zones (backdrop=close, header=open doc, body=content) unchanged.

Because `document-viewer.ts` is untouched, the `spec parity` pair (HighlightCard ↔
document-viewer) stays honest: the card's action set/icons/layout don't change.

## Store-first / offline
`HighlightDetail` is **store-only** (no fetch): body HTML from `item.body` markdown via
`buildDocumentHtml(body, '', item.linked_documents, activeUrl)` (empty title → no duplicate
h1; the sheet header shows the title; activeUrl absolutizes `/api/v1/media/` images).
Existing marks: select the raw `annotations` store slice, `useMemo`-filter by
`highlight_id === item.id && !deleted_at` (stable refs → no render loop). Create/edit/delete
go through `mut.createAnnotation({ documentId: item.document_id, highlightId: item.id, ... })`
/ `mut.updateAnnotation` / `mut.deleteAnnotation`. Store reactivity re-renders → the
`setAnnotations` effect re-syncs marks. Works with `samizdat_force_offline`.

## Message wiring (mirrors doc viewer, stripped down)
- `ready` → send `init` { doc:{title:''}, highlights:[], annotations, theme, hlExpanded, scrollFraction:0 }
- `selection` → open AnnotationPanel (create) with the anchor
- `tap_annotation` → open AnnotationPanel (edit) for that ann
- `link_press` → onDocumentPress (has doc_id) / onLinkAction (external)
- annotations change / theme change → `setAnnotations` / `setTheme` effects (guarded by isLoadedRef)

## Coexistence with the whole-highlight note button
The footer `NoteEditButton` (feed `onAnnotate`) still creates a whole-highlight note
(no real anchor). The new path is the anchored/selection variant inside the overlay. Both
call `mut.createAnnotation` with `highlightId`; the selection one carries exact/prefix/suffix/pos.

## Testing
- `e2e/integration.js`: seed a highlight whose body crosses inline `<b>`/`<a>`/`<code>`;
  open the feed → open the highlight overlay → select across the link (HARD case) →
  Annotate → Save → assert multi-piece `<mark>` renders + wraps the link → reopen overlay,
  mark persists (store) → tap mark reopens the note.
- Repeat the create under `samizdat_force_offline='1'` and assert the mark renders + the
  annotation lands in the store with `highlight_id` set (offline create).
- Native WebView selection can't run headless — verify on device after build.

## Steps
1. Plan → commit to main. Branch `feat/highlight-selection-annotation`.
2. `HighlightDetail.tsx` (new). Rewire `HighlightCard.tsx` overlay to use it.
3. Extend `e2e/integration.js` + add offline assertion.
4. `just lint`, `just build`, `just build-app-web`, `just e2e`, `just e2e-int`, `just e2e-offline`.
5. Leave on branch for human review (no squash-merge, no push).
