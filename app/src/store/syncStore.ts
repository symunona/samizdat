import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { uuidv4 } from './uuid'
import type { Document, Highlight, Annotation, Tag } from '../api'
import {
  type OutboxIntent, type OutboxKind, type JunctionType,
  enqueueIntent, removeIntent, bumpIntentTries, addDirty, clearDirtyForSucceeded,
  intentDirtyKeys, dirtyKeyAnn, dirtyKeyHl, dirtyKeyTag,
  mergeEntities, mergeHighlights, mergeJunctionTags,
  junctionAdd, junctionRemove, newAnnotationRow, newTagRow,
} from './outbox'

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

const JT_MAP_KEY: Record<JunctionType, 'documentTags' | 'annotationTags' | 'highlightTags'> = {
  doc: 'documentTags', ann: 'annotationTags', hl: 'highlightTags',
}

const JT_ADD_KIND: Record<JunctionType, OutboxKind> = {
  doc: 'doc_tag_add', ann: 'ann_tag_add', hl: 'hl_tag_add',
}
const JT_REMOVE_KIND: Record<JunctionType, OutboxKind> = {
  doc: 'doc_tag_remove', ann: 'ann_tag_remove', hl: 'hl_tag_remove',
}

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
  // Local-first write path (persisted):
  outbox: OutboxIntent[]
  dirty: Record<string, number> // dirtyKey → base_rev
}

type SyncActions = {
  applySync(payload: SyncPayload): void
  setSyncStatus(status: SyncStatus, error?: string): void
  clearStore(): void

  // ── local-first mutations (optimistic store patch + outbox enqueue + mark dirty) ──
  mutSetHighlightPinned(hlId: string, pinned: boolean): void
  mutSetHighlightArchived(hlId: string, archivedAt: string | null): void
  mutDeleteHighlight(hlId: string): void
  mutAddTag(type: JunctionType, parentId: string, tagId: string): void
  mutRemoveTag(type: JunctionType, parentId: string, tagId: string): void
  mutCreateTag(input: { name: string; color: string }): Tag
  mutCreateAnnotation(input: {
    documentId: string | null
    highlightId?: string | null
    exact?: string; prefix?: string; suffix?: string
    posStart?: number; posEnd?: number; mediaTsMs?: number
    color: string; note: string
  }): Annotation
  mutUpdateAnnotation(annId: string, note: string, color: string): void
  mutDeleteAnnotation(annId: string): void
  mutSaveProgress(docId: string, scrollY: number): void
  mutSaveMediaPos(docId: string, mediaPosMs: number): void

  // ── pusher hooks (called by pushEngine) ──
  onIntentSuccess(intentId: string, serverRev?: number): void
  onIntentRetry(intentId: string): void
  dropIntent(intentId: string): void
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
  outbox: [],
  dirty: {},
}

const nowISO = () => new Date().toISOString()

export const useSyncStore = create<SyncStore>()(
  persist(
    (set, get) => {
      // Enqueue an intent, optimistically patched into the store already, and mark the
      // rows it owns dirty. `baseRev` is the row's currently-known server rev.
      function enqueue(
        kind: OutboxKind, args: Record<string, unknown>,
        opts: { baseRev?: number; coalesceKey?: string } = {},
      ) {
        const intent: OutboxIntent = {
          id: uuidv4(), kind, args, tries: 0, createdAt: nowISO(),
          baseRev: opts.baseRev ?? 0, coalesceKey: opts.coalesceKey,
        }
        set((s) => {
          let dirty = s.dirty
          for (const k of intentDirtyKeys(intent)) dirty = addDirty(dirty, k, intent.baseRev)
          return { outbox: enqueueIntent(s.outbox, intent), dirty }
        })
      }

      return {
        ...initialState,

        applySync(payload: SyncPayload) {
          set((state) => {
            const isDirty = (key: string) => key in state.dirty
            return {
              documents: mergeEntities(state.documents, payload.documents, () => false),
              highlights: mergeHighlights(state.highlights, payload.highlights, (id) => isDirty(dirtyKeyHl(id))),
              annotations: mergeEntities(state.annotations, payload.annotations, (id) => isDirty(dirtyKeyAnn(id))),
              tags: mergeEntities(state.tags, payload.tags, (id) => isDirty(dirtyKeyTag(id))),
              documentTags: mergeJunctionTags(state.documentTags, payload.document_tags, 'document_id', 'doc', isDirty),
              annotationTags: mergeJunctionTags(state.annotationTags, payload.annotation_tags, 'annotation_id', 'ann', isDirty),
              highlightTags: mergeJunctionTags(state.highlightTags, payload.highlight_tags, 'highlight_id', 'hl', isDirty),
              lastSyncedAt: payload.server_time,
              syncStatus: 'idle' as SyncStatus,
              syncError: null,
            }
          })
        },

        setSyncStatus(status: SyncStatus, error?: string) {
          set({ syncStatus: status, syncError: error ?? null })
        },

        clearStore() {
          set({ ...initialState })
        },

        // ── mutations ──
        mutSetHighlightPinned(hlId, pinned) {
          const hl = get().highlights[hlId]
          set((s) => hl
            ? { highlights: { ...s.highlights, [hlId]: { ...hl, pinned: pinned ? 1 : 0 } } }
            : {})
          enqueue('hl_pin', { id: hlId, pinned }, { baseRev: hl?.rev })
        },

        mutSetHighlightArchived(hlId, archivedAt) {
          const hl = get().highlights[hlId]
          set((s) => hl
            ? { highlights: { ...s.highlights, [hlId]: { ...hl, archived_at: archivedAt } } }
            : {})
          enqueue('hl_archive', { id: hlId, archivedAt }, { baseRev: hl?.rev })
        },

        mutDeleteHighlight(hlId) {
          const hl = get().highlights[hlId]
          set((s) => {
            const highlights = { ...s.highlights }
            delete highlights[hlId]
            return { highlights }
          })
          enqueue('hl_delete', { id: hlId }, { baseRev: hl?.rev })
        },

        mutAddTag(type, parentId, tagId) {
          const key = JT_MAP_KEY[type]
          set((s) => ({ [key]: junctionAdd(s[key], parentId, tagId) } as Partial<SyncState>))
          enqueue(JT_ADD_KIND[type], { parentId, tagId })
        },

        mutRemoveTag(type, parentId, tagId) {
          const key = JT_MAP_KEY[type]
          set((s) => ({ [key]: junctionRemove(s[key], parentId, tagId) } as Partial<SyncState>))
          enqueue(JT_REMOVE_KIND[type], { parentId, tagId })
        },

        mutCreateTag(input) {
          const tag = newTagRow({ id: uuidv4(), name: input.name, color: input.color, now: nowISO() })
          set((s) => ({ tags: { ...s.tags, [tag.id]: tag } }))
          enqueue('tag_create', { id: tag.id, name: tag.name, color: tag.color })
          return tag
        },

        mutCreateAnnotation(input) {
          const ann = newAnnotationRow({
            id: uuidv4(), documentId: input.documentId, highlightId: input.highlightId,
            exact: input.exact, prefix: input.prefix, suffix: input.suffix,
            posStart: input.posStart, posEnd: input.posEnd, mediaTsMs: input.mediaTsMs,
            color: input.color, note: input.note, now: nowISO(),
          })
          set((s) => ({ annotations: { ...s.annotations, [ann.id]: ann } }))
          enqueue('ann_create', {
            id: ann.id, documentId: ann.document_id, highlightId: ann.highlight_id,
            exact: ann.exact, prefix: ann.prefix, suffix: ann.suffix,
            posStart: ann.pos_start, posEnd: ann.pos_end, mediaTsMs: ann.media_ts_ms,
            color: ann.color, note: ann.note,
          })
          return ann
        },

        mutUpdateAnnotation(annId, note, color) {
          const ann = get().annotations[annId]
          set((s) => ann
            ? { annotations: { ...s.annotations, [annId]: { ...ann, note, color, updated_at: nowISO() } } }
            : {})
          enqueue('ann_update', { id: annId, note, color }, { baseRev: ann?.rev })
        },

        mutDeleteAnnotation(annId) {
          const ann = get().annotations[annId]
          set((s) => {
            const annotations = { ...s.annotations }
            delete annotations[annId]
            return { annotations }
          })
          enqueue('ann_delete', { id: annId }, { baseRev: ann?.rev })
        },

        mutSaveProgress(docId, scrollY) {
          enqueue('read_progress', { docId, scrollY }, { coalesceKey: `read_progress:${docId}` })
        },

        mutSaveMediaPos(docId, mediaPosMs) {
          enqueue('media_pos', { docId, mediaPosMs }, { coalesceKey: `media_pos:${docId}` })
        },

        // ── pusher callbacks ──
        onIntentSuccess(intentId, serverRev) {
          set((s) => {
            const done = s.outbox.find((i) => i.id === intentId)
            if (!done) return {}
            const outbox = removeIntent(s.outbox, intentId)
            let dirty = clearDirtyForSucceeded(s.dirty, done, outbox)
            // Record the server rev → base_rev on the still-dirty row (Phase 2 seam).
            if (serverRev != null) {
              for (const k of intentDirtyKeys(done)) if (k in dirty) dirty = { ...dirty, [k]: serverRev }
            }
            return { outbox, dirty }
          })
        },

        onIntentRetry(intentId) {
          set((s) => ({ outbox: bumpIntentTries(s.outbox, intentId) }))
        },

        dropIntent(intentId) {
          set((s) => {
            const done = s.outbox.find((i) => i.id === intentId)
            if (!done) return {}
            const outbox = removeIntent(s.outbox, intentId)
            return { outbox, dirty: clearDirtyForSucceeded(s.dirty, done, outbox) }
          })
        },
      }
    },
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
        outbox: state.outbox,
        dirty: state.dirty,
      }),
    },
  ),
)
