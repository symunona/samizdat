import { useShallow } from 'zustand/react/shallow'
import { useSyncStore } from './syncStore'
import type { Document, Tag } from '../api'

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

export function useTagsWithCounts(): TagWithCounts[] {
  return useSyncStore(
    useShallow((state) => {
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
    }),
  )
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
