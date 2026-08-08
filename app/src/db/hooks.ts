// The reactive read surface. Every screen reads the replica through these; none of them
// ever touches SQLite, the memory index, or a query string.
//
// Each hook selects RAW index slices (stable references) and derives its shape in a
// useMemo — never `arr.map(x => ({...x}))` inside a useShallow selector, which mints new
// element refs on every call, defeats shallow equality and spins an infinite render loop
// (React #185) the moment there is real data. See app/CLAUDE.md.
//
// The derivations live as pure `select*` functions so they can be unit-tested headlessly
// (e2e/db-unit.mjs) without a renderer.

import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useIndex, JUNCTION_KEY, type IndexState } from './memoryIndex'
import { getDocument } from './repo'
import type {
  Annotation, AnnotationWithContext, Document, DocumentMeta, HighlightFilter,
  HighlightWithDoc, JunctionType, Tag, TagWithCounts,
} from './types'

// ── pure selectors ────────────────────────────────────────────────────────────

export function selectDocuments(s: Pick<IndexState, 'documents'>): DocumentMeta[] {
  return Object.values(s.documents)
    .filter((d) => !d.deleted_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

const KEEP: Record<HighlightFilter, (h: { pinned: number; archived_at: string | null }) => boolean> = {
  feed: (h) => !h.archived_at,
  starred: (h) => h.pinned === 1,
  archived: (h) => !!h.archived_at,
}

// Mirrors the server's HighlightWithDoc shape from local rows only, so the feed renders
// offline: created_at DESC, document title/url + tags joined from the index. A highlight
// whose document has not synced yet joins to empty strings rather than disappearing.
export function selectHighlights(
  s: Pick<IndexState, 'highlights' | 'documents' | 'tags' | 'highlightTags'>,
  filter: HighlightFilter,
): HighlightWithDoc[] {
  return Object.values(s.highlights)
    .filter((h) => !h.deleted_at && KEEP[filter](h))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((h) => {
      const d = s.documents[h.document_id]
      return {
        ...h,
        document_title: d?.title ?? '',
        document_url: d?.canonical_url ?? '',
        tags: (s.highlightTags[h.id] ?? [])
          .map((tid) => s.tags[tid])
          .filter((t): t is Tag => !!t),
      }
    })
}

export function selectHighlightCount(s: Pick<IndexState, 'highlights'>): number {
  return Object.values(s.highlights).filter((h) => !h.deleted_at).length
}

export function selectAnnotations(
  s: Pick<IndexState, 'annotations' | 'annotationTags' | 'tags' | 'documents'>,
): AnnotationWithContext[] {
  return Object.values(s.annotations)
    .filter((a) => !a.deleted_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((a) => ({
      ...a,
      tags: (s.annotationTags[a.id] ?? [])
        .map((tid) => s.tags[tid])
        .filter((t): t is Tag => !!t && !t.deleted_at),
      docTitle: a.document_id ? (s.documents[a.document_id]?.title ?? null) : null,
    }))
}

export function selectAnnotationsFor(
  s: Pick<IndexState, 'annotations'>,
  opts: { documentId?: string; highlightId?: string },
): Annotation[] {
  return Object.values(s.annotations)
    .filter((a) => !a.deleted_at
      && (opts.documentId === undefined || a.document_id === opts.documentId)
      && (opts.highlightId === undefined || a.highlight_id === opts.highlightId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export function selectTags(s: Pick<IndexState, 'tags'>): Tag[] {
  return Object.values(s.tags)
    .filter((t) => !t.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function selectTagsWithCounts(
  s: Pick<IndexState, 'tags' | 'documentTags' | 'annotationTags' | 'documents' | 'annotations'>,
): TagWithCounts[] {
  const docTagCount: Record<string, number> = {}
  const annTagCount: Record<string, number> = {}
  for (const [docId, tagIds] of Object.entries(s.documentTags)) {
    if (s.documents[docId]?.deleted_at) continue
    for (const tid of tagIds) docTagCount[tid] = (docTagCount[tid] ?? 0) + 1
  }
  for (const [annId, tagIds] of Object.entries(s.annotationTags)) {
    if (s.annotations[annId]?.deleted_at) continue
    for (const tid of tagIds) annTagCount[tid] = (annTagCount[tid] ?? 0) + 1
  }
  return Object.values(s.tags)
    .filter((t) => !t.deleted_at)
    .map((t) => ({ ...t, doc_count: docTagCount[t.id] ?? 0, ann_count: annTagCount[t.id] ?? 0 }))
    .sort((a, b) =>
      b.doc_count + b.ann_count - (a.doc_count + a.ann_count) || a.name.localeCompare(b.name))
}

export function selectTagLinks(
  s: Pick<IndexState, 'documentTags' | 'annotationTags' | 'highlightTags'>,
  type: JunctionType,
  objectId: string,
): string[] {
  return s[JUNCTION_KEY[type]][objectId] ?? []
}

export function selectSyncStatus(s: Pick<IndexState, 'syncStatus' | 'syncError' | 'lastSyncedAt'>) {
  return { status: s.syncStatus, error: s.syncError, lastSyncedAt: s.lastSyncedAt }
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export function useHydrated(): boolean {
  return useIndex((s) => s.hydrated)
}

export function useSyncStatus() {
  return useIndex(useShallow(selectSyncStatus))
}

export function useDocuments(): DocumentMeta[] {
  const documents = useIndex((s) => s.documents)
  return useMemo(() => selectDocuments({ documents }), [documents])
}

// The FULL document, bodies included — a real query, not the index (see DocumentMeta).
// Re-runs when the row's rev changes, so a pull that re-scrapes the body is picked up.
export function useDocument(id: string | null | undefined): Document | null {
  const rev = useIndex((s) => (id ? s.documents[id]?.rev : undefined))
  const [doc, setDoc] = useState<Document | null>(null)
  useEffect(() => {
    let live = true
    if (!id) { setDoc(null); return }
    getDocument(id).then((d) => { if (live) setDoc(d) })
    return () => { live = false }
  }, [id, rev])
  return doc
}

function useHighlights(filter: HighlightFilter): HighlightWithDoc[] {
  const highlights = useIndex((s) => s.highlights)
  const documents = useIndex((s) => s.documents)
  const tags = useIndex((s) => s.tags)
  const highlightTags = useIndex((s) => s.highlightTags)
  return useMemo(
    () => selectHighlights({ highlights, documents, tags, highlightTags }, filter),
    [highlights, documents, tags, highlightTags, filter],
  )
}

export const useFeedHighlights = (): HighlightWithDoc[] => useHighlights('feed')
export const useStarredHighlights = (): HighlightWithDoc[] => useHighlights('starred')
export const useArchivedHighlights = (): HighlightWithDoc[] => useHighlights('archived')

// How many mutations are still queued for the server. The pusher hook watches this to
// drain on every new intent — it must come from the index, not a query, so a mutation
// re-renders its subscriber synchronously.
export function useOutboxCount(): number {
  return useIndex((s) => s.outbox.length)
}

export function useHighlightCount(): number {
  const highlights = useIndex((s) => s.highlights)
  return useMemo(() => selectHighlightCount({ highlights }), [highlights])
}

export function useAnnotations(): AnnotationWithContext[] {
  const annotations = useIndex((s) => s.annotations)
  const annotationTags = useIndex((s) => s.annotationTags)
  const tags = useIndex((s) => s.tags)
  const documents = useIndex((s) => s.documents)
  return useMemo(
    () => selectAnnotations({ annotations, annotationTags, tags, documents }),
    [annotations, annotationTags, tags, documents],
  )
}

export function useAnnotationsFor(opts: { documentId?: string; highlightId?: string }): Annotation[] {
  const annotations = useIndex((s) => s.annotations)
  const { documentId, highlightId } = opts
  return useMemo(
    () => selectAnnotationsFor({ annotations }, { documentId, highlightId }),
    [annotations, documentId, highlightId],
  )
}

export function useTags(): Tag[] {
  const tags = useIndex((s) => s.tags)
  return useMemo(() => selectTags({ tags }), [tags])
}

export function useTagsWithCounts(): TagWithCounts[] {
  const tags = useIndex((s) => s.tags)
  const documentTags = useIndex((s) => s.documentTags)
  const annotationTags = useIndex((s) => s.annotationTags)
  const documents = useIndex((s) => s.documents)
  const annotations = useIndex((s) => s.annotations)
  return useMemo(
    () => selectTagsWithCounts({ tags, documentTags, annotationTags, documents, annotations }),
    [tags, documentTags, annotationTags, documents, annotations],
  )
}

export function useTagLinks(type: JunctionType, objectId: string): string[] {
  const documentTags = useIndex((s) => s.documentTags)
  const annotationTags = useIndex((s) => s.annotationTags)
  const highlightTags = useIndex((s) => s.highlightTags)
  return useMemo(
    () => selectTagLinks({ documentTags, annotationTags, highlightTags }, type, objectId),
    [documentTags, annotationTags, highlightTags, type, objectId],
  )
}
