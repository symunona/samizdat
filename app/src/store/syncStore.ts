import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { Document, Highlight, Annotation, Tag } from '../api'

export type DocumentTag = {
  id: string
  document_id: string
  tag_id: string
  created_at: string
  updated_at: string
  rev: number
  deleted_at: string | null
}

export type AnnotationTag = {
  id: string
  annotation_id: string
  tag_id: string
  created_at: string
  updated_at: string
  rev: number
  deleted_at: string | null
}

export type HighlightTag = {
  id: string
  highlight_id: string
  tag_id: string
  created_at: string
  updated_at: string
  rev: number
  deleted_at: string | null
}

export type SyncPayload = {
  server_time: string
  documents: Document[]
  highlights: Highlight[]
  annotations: Annotation[]
  tags: Tag[]
  document_tags: DocumentTag[]
  annotation_tags: AnnotationTag[]
  highlight_tags: HighlightTag[]
}

type SyncStatus = 'idle' | 'syncing' | 'error'

type SyncState = {
  documents: Record<string, Document>
  highlights: Record<string, Highlight>
  annotations: Record<string, Annotation>
  tags: Record<string, Tag>
  // docId/annId/hlId → tagId[]
  documentTags: Record<string, string[]>
  annotationTags: Record<string, string[]>
  highlightTags: Record<string, string[]>
  lastSyncedAt: string | null
  syncStatus: SyncStatus
  syncError: string | null
}

type SyncActions = {
  applySync(payload: SyncPayload): void
  setSyncStatus(status: SyncStatus, error?: string): void
  clearStore(): void
}

export type SyncStore = SyncState & SyncActions

const initialState: SyncState = {
  documents: {},
  highlights: {},
  annotations: {},
  tags: {},
  documentTags: {},
  annotationTags: {},
  highlightTags: {},
  lastSyncedAt: null,
  syncStatus: 'idle',
  syncError: null,
}

function applyEntities<T extends { id: string; deleted_at?: string | null }>(
  map: Record<string, T>,
  incoming: T[],
): Record<string, T> {
  if (!incoming.length) return map
  const next = { ...map }
  for (const item of incoming) {
    if (item.deleted_at) {
      delete next[item.id]
    } else {
      next[item.id] = item
    }
  }
  return next
}

function applyJunctionTags(
  map: Record<string, string[]>,
  incoming: Array<{ id: string; deleted_at: string | null; tag_id: string } & Record<string, unknown>>,
  parentKey: string,
): Record<string, string[]> {
  if (!incoming.length) return map
  const next = { ...map }
  for (const row of incoming) {
    const parentId = row[parentKey] as string
    if (row.deleted_at) {
      next[parentId] = (next[parentId] ?? []).filter((tid) => tid !== row.tag_id)
    } else {
      const existing = next[parentId] ?? []
      if (!existing.includes(row.tag_id)) {
        next[parentId] = [...existing, row.tag_id]
      }
    }
  }
  return next
}

export const useSyncStore = create<SyncStore>()(
  persist(
    (set) => ({
      ...initialState,

      applySync(payload: SyncPayload) {
        set((state) => ({
          documents: applyEntities(state.documents, payload.documents),
          highlights: applyEntities(state.highlights, payload.highlights),
          annotations: applyEntities(state.annotations, payload.annotations),
          tags: applyEntities(state.tags, payload.tags),
          documentTags: applyJunctionTags(
            state.documentTags,
            payload.document_tags as Array<{ id: string; deleted_at: string | null; tag_id: string } & Record<string, unknown>>,
            'document_id',
          ),
          annotationTags: applyJunctionTags(
            state.annotationTags,
            payload.annotation_tags as Array<{ id: string; deleted_at: string | null; tag_id: string } & Record<string, unknown>>,
            'annotation_id',
          ),
          highlightTags: applyJunctionTags(
            state.highlightTags,
            payload.highlight_tags as Array<{ id: string; deleted_at: string | null; tag_id: string } & Record<string, unknown>>,
            'highlight_id',
          ),
          lastSyncedAt: payload.server_time,
          syncStatus: 'idle' as SyncStatus,
          syncError: null,
        }))
      },

      setSyncStatus(status: SyncStatus, error?: string) {
        set({ syncStatus: status, syncError: error ?? null })
      },

      clearStore() {
        set({ ...initialState })
      },
    }),
    {
      name: 'samizdat_sync_store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        documents: state.documents,
        highlights: state.highlights,
        annotations: state.annotations,
        tags: state.tags,
        documentTags: state.documentTags,
        annotationTags: state.annotationTags,
        highlightTags: state.highlightTags,
        lastSyncedAt: state.lastSyncedAt,
      }),
    },
  ),
)
