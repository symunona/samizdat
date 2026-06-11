import { useSyncStore } from './syncStore'
import type { Document, Highlight, Annotation, Tag } from '../api'

export function useDocuments(): Document[] {
  return useSyncStore((state) =>
    Object.values(state.documents)
      .filter((d) => !d.deleted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)),
  )
}

export function useDocument(id: string): Document | undefined {
  return useSyncStore((state) => state.documents[id])
}

export function useHighlights(docId?: string): Highlight[] {
  return useSyncStore((state) => {
    const all = Object.values(state.highlights).filter((h) => !h.deleted_at)
    const filtered = docId ? all.filter((h) => h.document_id === docId) : all
    return filtered.sort((a, b) => b.created_at.localeCompare(a.created_at))
  })
}

export function useAnnotations(docId: string): Annotation[] {
  return useSyncStore((state) =>
    Object.values(state.annotations)
      .filter((a) => !a.deleted_at && a.document_id === docId)
      .sort((a, b) => a.pos_start - b.pos_start),
  )
}

export function useTags(): Tag[] {
  return useSyncStore((state) =>
    Object.values(state.tags)
      .filter((t) => !t.deleted_at)
      .sort((a, b) => a.name.localeCompare(b.name)),
  )
}

export type TagWithCounts = Tag & { doc_count: number; ann_count: number }

export function useTagsWithCounts(): TagWithCounts[] {
  return useSyncStore((state) => {
    const docTagCount: Record<string, number> = {}
    const annTagCount: Record<string, number> = {}

    for (const [docId, tagIds] of Object.entries(state.documentTags)) {
      if (state.documents[docId]?.deleted_at) continue
      for (const tid of tagIds) {
        docTagCount[tid] = (docTagCount[tid] ?? 0) + 1
      }
    }
    for (const [annId, tagIds] of Object.entries(state.annotationTags)) {
      if (state.annotations[annId]?.deleted_at) continue
      for (const tid of tagIds) {
        annTagCount[tid] = (annTagCount[tid] ?? 0) + 1
      }
    }

    return Object.values(state.tags)
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
  })
}

export function useDocumentTags(docId: string): Tag[] {
  return useSyncStore((state) => {
    const tagIds = state.documentTags[docId] ?? []
    return tagIds
      .map((id) => state.tags[id])
      .filter((t): t is Tag => !!t && !t.deleted_at)
  })
}

export function useAnnotationTags(annId: string): Tag[] {
  return useSyncStore((state) => {
    const tagIds = state.annotationTags[annId] ?? []
    return tagIds
      .map((id) => state.tags[id])
      .filter((t): t is Tag => !!t && !t.deleted_at)
  })
}

export function useHighlightTags(hlId: string): Tag[] {
  return useSyncStore((state) => {
    const tagIds = state.highlightTags[hlId] ?? []
    return tagIds
      .map((id) => state.tags[id])
      .filter((t): t is Tag => !!t && !t.deleted_at)
  })
}

export function useSyncStatus() {
  return useSyncStore((state) => ({
    status: state.syncStatus,
    error: state.syncError,
    lastSyncedAt: state.lastSyncedAt,
  }))
}
