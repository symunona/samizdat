---
create: 2026-07-07
topic: Rewire "Notes" drawer screen to show all annotations
excerpt: Notes screen only listed standalone annotations (document_id=null). Show all; doc-anchored tap-through to source at anchor.
status: done — verified via agent-browser (list shows quote+note+source; tap opens doc, mark.focused)
---

# Notes → Annotations

## Problem
Drawer "Notes" item → `notes.tsx` → `useNotes()` filters `document_id === null`.
User's document-anchored annotations live in the same table but are hidden.

## Decision (user)
- One list: standalone notes + doc-anchored annotations.
- Doc-anchored: show quoted `exact` + source doc title; tap → open document at anchor.
- Standalone: edit in place (unchanged).
- Keep drawer label "Notes".

## Anchor nav (existing, reuse)
`router.push('/document/{docId}?from=/notes&highlight={ann.id}')`
→ viewer passes `focusId` to webview → focuses `mark[data-ann-id]`. Same as tags/[id].tsx:147.

## Steps
1. hooks.ts: replace `useNotes`/`NoteWithTags` with `useAnnotations`/`AnnotationWithContext`
   (all non-deleted annotations, +tags, +docTitle).
2. notes.tsx: branch renderItem on `document_id`; anchored → router.push, standalone → edit.
3. Empty text update. Lint + e2e.
