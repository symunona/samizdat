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
  Annotation, AnnotationWithContext, Digest, DigestIssue, Document, DocumentMeta,
  HighlightFilter, HighlightWithDoc, JunctionType, Tag, TagWithCounts,
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
        document_published_at: d?.published_at ?? null,
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

// Which highlights carry at least one note. `Annotation.highlight_id` is already synced,
// so the feed can mark an annotated card with no API change. A Set (not a per-card query)
// because the feed asks this once per render for every row it draws.
export function selectAnnotatedHighlightIds(s: Pick<IndexState, 'annotations'>): Set<string> {
  const ids = new Set<string>()
  for (const a of Object.values(s.annotations)) {
    if (!a.deleted_at && a.highlight_id) ids.add(a.highlight_id)
  }
  return ids
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

export function selectDigests(s: Pick<IndexState, 'digests'>): Digest[] {
  return Object.values(s.digests)
    .filter((g) => !g.deleted_at)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Newest first — the server's order (window_end DESC, created_at DESC).
export function selectDigestIssues(s: Pick<IndexState, 'digestIssues'>, digestId: string): DigestIssue[] {
  return Object.values(s.digestIssues)
    .filter((i) => !i.deleted_at && i.digest_id === digestId)
    .sort((a, b) => b.window_end.localeCompare(a.window_end) || b.created_at.localeCompare(a.created_at))
}

// A Digest that cites a Highlight, and the issue a press on its chip opens.
export type HighlightDigest = { digestId: string; issueId: string; name: string; color: string }

// Every Highlight a DigestIssue topic cites → the Digests citing it, by name. One pass
// over the issues, built once per screen: a card looks its id up, it never queries.
// The issue kept per Digest is the newest that cites the Highlight; a deleted Digest
// or issue contributes nothing.
export function selectHighlightDigests(
  s: Pick<IndexState, 'digests' | 'digestIssues'>,
): Map<string, HighlightDigest[]> {
  const cited = new Map<string, HighlightDigest[]>()
  const newestFirst = Object.values(s.digestIssues)
    .filter((i) => !i.deleted_at)
    .sort((a, b) => b.window_end.localeCompare(a.window_end) || b.created_at.localeCompare(a.created_at))
  for (const issue of newestFirst) {
    const digest = s.digests[issue.digest_id]
    if (!digest || digest.deleted_at) continue
    for (const topic of issue.topics) {
      for (const ref of topic.refs) {
        const list = cited.get(ref.highlight_id) ?? []
        if (list.some((d) => d.digestId === digest.id)) continue
        list.push({ digestId: digest.id, issueId: issue.id, name: digest.name, color: digest.color })
        cited.set(ref.highlight_id, list)
      }
    }
  }
  for (const list of cited.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return cited
}

// Mirrors the server's digest.BulletText: body line `bullet` without its list marker,
// or the whole body for -1 (and for an index the body no longer has).
const BULLET_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/

export function bulletText(body: string, bullet: number): string {
  const lines = body.split('\n')
  if (bullet < 0 || bullet >= lines.length) return body.trim()
  return lines[bullet].replace(BULLET_MARKER, '').trim()
}

// One issue with its refs resolved from local rows only — what GET /digest-issues/{id}
// serves, minus `feed_title`: Feeds are not in the replica, so offline a bullet is
// labelled by its Document. A Highlight that never synced (or was deleted) is `missing`.
export function selectDigestIssue(
  s: Pick<IndexState, 'digestIssues' | 'highlights' | 'documents'>,
  issueId: string,
): DigestIssue | null {
  const issue = s.digestIssues[issueId]
  if (!issue || issue.deleted_at) return null
  return {
    ...issue,
    topics: issue.topics.map((t) => ({
      ...t,
      refs: t.refs.map((ref) => {
        const h = s.highlights[ref.highlight_id]
        if (!h) return { ...ref, missing: true }
        return {
          ...ref,
          text: bulletText(h.body, ref.bullet),
          highlight_title: h.title,
          document_id: h.document_id,
          document_title: s.documents[h.document_id]?.title ?? '',
          date: h.created_at.slice(0, 10),
        }
      }),
    })),
  }
}

// The Feeds that have produced at least one Highlight. A Digest reads Highlights, never
// Documents, so a Feed outside this set contributes nothing to it.
export function selectFeedIdsWithHighlights(s: Pick<IndexState, 'highlights' | 'documents'>): Set<string> {
  const ids = new Set<string>()
  for (const h of Object.values(s.highlights)) {
    const feedId = h.deleted_at ? null : s.documents[h.document_id]?.source_feed_id
    if (feedId) ids.add(feedId)
  }
  return ids
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

export function useAnnotatedHighlightIds(): Set<string> {
  const annotations = useIndex((s) => s.annotations)
  return useMemo(() => selectAnnotatedHighlightIds({ annotations }), [annotations])
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

export function useDigests(): Digest[] {
  const digests = useIndex((s) => s.digests)
  return useMemo(() => selectDigests({ digests }), [digests])
}

export function useDigestIssues(digestId: string): DigestIssue[] {
  const digestIssues = useIndex((s) => s.digestIssues)
  return useMemo(() => selectDigestIssues({ digestIssues }, digestId), [digestIssues, digestId])
}

export function useDigestIssue(issueId: string | null): DigestIssue | null {
  const digestIssues = useIndex((s) => s.digestIssues)
  const highlights = useIndex((s) => s.highlights)
  const documents = useIndex((s) => s.documents)
  return useMemo(
    () => (issueId ? selectDigestIssue({ digestIssues, highlights, documents }, issueId) : null),
    [digestIssues, highlights, documents, issueId],
  )
}

export function useHighlightDigests(): Map<string, HighlightDigest[]> {
  const digests = useIndex((s) => s.digests)
  const digestIssues = useIndex((s) => s.digestIssues)
  return useMemo(() => selectHighlightDigests({ digests, digestIssues }), [digests, digestIssues])
}

export function useFeedIdsWithHighlights(): Set<string> {
  const highlights = useIndex((s) => s.highlights)
  const documents = useIndex((s) => s.documents)
  return useMemo(() => selectFeedIdsWithHighlights({ highlights, documents }), [highlights, documents])
}
