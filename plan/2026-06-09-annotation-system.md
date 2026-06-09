---
created: 2026-06-09
topic: Annotation System — user text selections on Documents and Highlights
excerpt: Schema, API, WebView reader approach, and anchor format for user-created Annotations
status: ready to implement
---

# Annotation System Plan

## What

User long-presses text in the document reader → selects a span → saves it as an `Annotation` with optional note. Annotations render as colored marks inline; tapping one opens the note panel.

**Domain clarity:**
- `Highlight` = LLM-extracted unit from Document (machine data, server→phone one-way) — planned for Pipeline work
- `Annotation` = user-created text selection on a `Document` or `Highlight`, with text anchor + optional note body — **this feature**

---

## Decision: WebView document reader (confirmed)

Research (`research/tech/021 RN Text Selection.md`) confirms:

- `<Text selectable>` has **no selection callbacks** — RN core issue #23147 open since 2018, unresolved
- `@rob117/react-native-selectable-text` gives selection content but no character offsets on Android, cannot wrap mixed-style markdown blocks
- **WebView + `window.getSelection()` + postMessage is the de facto standard** — used by ReadEra, Moon+ Reader, Readwise Reader
- RN Web target: same injected JS runs natively — full cross-platform parity

**Action:** Replace `react-native-markdown-display` + ScrollView in `app/app/document/[id].tsx` with a WebView renderer.

---

## Anchor format

Synthesized from `research/tech/004 Text Anchoring.md` + RN selection research. Store both selectors flat:

```json
{
  "exact":     "the selected text verbatim",
  "prefix":    "up to 64 chars before",
  "suffix":    "up to 64 chars after",
  "pos_start": 1234,
  "pos_end":   1259
}
```

- `TextQuoteSelector` (exact + prefix + suffix) = primary portable anchor — survives re-scrape, fuzzy-matchable, round-trips with Hypothesis / Omnivore / Readwise
- `TextPositionSelector` (pos_start / pos_end) = fast-path hint only — breaks after edits, used only as fuzzy search window seed
- Re-anchor order: position check → context-first fuzzy → quote-only fuzzy → ORPHANED
- `exact` always stored verbatim and immutable; `note` is the separate editable field

---

## Schema (server/internal/store/schema.sql)

```sql
CREATE TABLE IF NOT EXISTS annotations (
    id           TEXT    PRIMARY KEY,
    document_id  TEXT    NOT NULL REFERENCES documents(id),
    highlight_id TEXT    REFERENCES highlights(id),  -- NULL = annotates Document directly
    exact        TEXT    NOT NULL,
    prefix       TEXT    NOT NULL DEFAULT '',
    suffix       TEXT    NOT NULL DEFAULT '',
    pos_start    INTEGER NOT NULL DEFAULT 0,
    pos_end      INTEGER NOT NULL DEFAULT 0,
    color        TEXT    NOT NULL DEFAULT 'yellow',
    note         TEXT    NOT NULL DEFAULT '',
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS annotations_document_id  ON annotations(document_id);
CREATE INDEX IF NOT EXISTS annotations_highlight_id ON annotations(highlight_id);
```

---

## API (server/internal/api/annotations.go)

Bearer-authed. Two-way sync (user-authored rows).

```
GET    /api/v1/documents/:id/annotations
POST   /api/v1/documents/:id/annotations   ← {exact, prefix, suffix, pos_start, pos_end, color, note, highlight_id?}
PUT    /api/v1/annotations/:id             ← {note, color}
DELETE /api/v1/annotations/:id
```

Annotations flow through the `since_rev` pull cursor. Phone pushes changes via LWW push.

---

## App: WebView reader

### Render path

Server adds `GET /api/v1/documents/:id/html`:
- Go renders markdown → HTML via goldmark
- Injects `<style>` with theme CSS vars
- Embeds `window.__annotations = [...]` JSON for existing annotations

### JS bridge (app/src/reader-bridge.js)

```js
window.__annotations.forEach(a => applyMark(a))

document.addEventListener('selectionchange', () => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return
  const exact = sel.toString().trim()
  if (!exact) return
  const { start, end } = getCharOffsets(sel.getRangeAt(0))
  const { prefix, suffix } = getContext(sel.getRangeAt(0), 64)
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'selection', exact, prefix, suffix, pos_start: start, pos_end: end
  }))
})

document.addEventListener('click', e => {
  const mark = e.target.closest('mark[data-ann-id]')
  if (mark) window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'tap_annotation', id: mark.dataset.annId
  }))
})
```

### RN handler

```ts
const handleMessage = (e: WebViewMessageEvent) => {
  const msg = JSON.parse(e.nativeEvent.data)
  if (msg.type === 'selection') setPendingSelection(msg)
  if (msg.type === 'tap_annotation') setActiveAnnotationId(msg.id)
}
```

### Bottom sheet

- Pending selection: color picker + TextInput note + Save/Cancel
- Active annotation: existing note (editable) + color + Delete
- On save: POST → `injectJavaScript('applyMark(...)')` → mark appears immediately

---

## Vault persistence

Each annotation → `vault/annotations/<document-id>/<annotation-id>.md`
Frontmatter: all anchor + meta fields. Body: `note` markdown.
`sam reindex` reconstructs `annotations` table from vault.

---

## Implementation order

1. Schema — add table, `just server::gen`, `just build`
2. API — `annotations.go` + sqlc queries + wire in `router.go`
3. Server HTML endpoint — goldmark render + annotation JSON embed
4. WebView reader — swap markdown-display, verify scroll restore
5. JS bridge — selection → postMessage → bottom sheet → POST → mark
6. Annotation panel — tap mark → edit/delete
7. Vault write — POST/PUT/DELETE each write vault file

---

## Self-tests

- [ ] POST annotation → GET returns it with correct anchor fields
- [ ] PUT updates only note + color, not anchor
- [ ] DELETE soft-deletes (deleted_at set, row remains)
- [ ] `since_rev` pull includes annotations
- [ ] HTML endpoint returns valid HTML with embedded annotation JSON
- [ ] WebView renders article; scroll restore works
- [ ] Long-press → selection message fires
- [ ] Save → mark visible; tap mark → panel shows note
- [ ] Vault file written; `sam reindex` rebuilds row

---

## Out of scope

- Pipeline Highlights (separate feature)
- Annotation export / digest cite (M4)
- Clipper annotations (M5)
- Fuzzy re-anchor on re-scrape (implement when Pipeline re-scraping exists)
