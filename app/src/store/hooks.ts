import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSyncStore } from './syncStore'
import type { Annotation, Document, Tag } from '../api'

export type NoteWithTags = Annotation & { tags: Tag[] }

// Standalone notes = annotations with no parent Document, newest first, each with
// its resolved (live) tags for chip display.
//
// The raw note list is selected via useShallow so it keeps stable element refs
// while the store is unchanged; the tag join is memoized. Mapping to fresh
// objects *inside* a useShallow selector would defeat shallow equality and spin
// an infinite render loop (React #185).
export function useNotes(): NoteWithTags[] {
  const notes = useSyncStore(
    useShallow((state) =>
      Object.values(state.annotations)
        .filter((a) => !a.document_id && !a.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    ),
  )
  const annotationTags = useSyncStore((s) => s.annotationTags)
  const tags = useSyncStore((s) => s.tags)
  return useMemo(
    () =>
      notes.map((a) => ({
        ...a,
        tags: (annotationTags[a.id] ?? [])
          .map((tid) => tags[tid])
          .filter((t): t is Tag => !!t && !t.deleted_at),
      })),
    [notes, annotationTags, tags],
  )
}

export function useDocuments(): Document[] {
  return useSyncStore(
    useShallow((state) =>
      Object.values(state.documents)
        .filter((d) => !d.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    ),
  )
}

export type TagWithCounts = Tag & { doc_count: number; ann_count: number }

// Select raw store slices (stable refs) and derive the counted+sorted list in a
// useMemo. Mapping to fresh objects inside a useShallow selector spins an
// infinite render loop (React #185) once there is any tag data — see useNotes.
export function useTagsWithCounts(): TagWithCounts[] {
  const tags = useSyncStore((s) => s.tags)
  const documentTags = useSyncStore((s) => s.documentTags)
  const annotationTags = useSyncStore((s) => s.annotationTags)
  const documents = useSyncStore((s) => s.documents)
  const annotations = useSyncStore((s) => s.annotations)
  return useMemo(() => {
    const docTagCount: Record<string, number> = {}
    const annTagCount: Record<string, number> = {}

    for (const [docId, tagIds] of Object.entries(documentTags)) {
      if (documents[docId]?.deleted_at) continue
      for (const tid of tagIds) {
        docTagCount[tid] = (docTagCount[tid] ?? 0) + 1
      }
    }
    for (const [annId, tagIds] of Object.entries(annotationTags)) {
      if (annotations[annId]?.deleted_at) continue
      for (const tid of tagIds) {
        annTagCount[tid] = (annTagCount[tid] ?? 0) + 1
      }
    }

    return Object.values(tags)
      .filter((t) => !t.deleted_at)
      .map((t) => ({
        ...t,
        doc_count: docTagCount[t.id] ?? 0,
        ann_count: annTagCount[t.id] ?? 0,
      }))
      .sort(
        (a, b) =>
          b.doc_count + b.ann_count - (a.doc_count + a.ann_count) ||
          a.name.localeCompare(b.name),
      )
  }, [tags, documentTags, annotationTags, documents, annotations])
}

export function useSyncStatus() {
  return useSyncStore(
    useShallow((state) => ({
      status: state.syncStatus,
      error: state.syncError,
      lastSyncedAt: state.lastSyncedAt,
    })),
  )
}
