// The memory index: a body-less mirror of the replica that React can subscribe to.
//
// SQLite is the truth; this is a read cache so a list render is a map lookup instead of
// a query. It is a PLAIN zustand store — deliberately NOT `persist()`. Persisting it
// would re-create the exact bug this layer replaces: one JSON blob rewritten on every
// mutation, past Android's whole-DB cap, silently failing, freezing the replica.
// It is rebuilt from SQLite by `repo.open()` on every launch.
//
// Nothing outside src/db/ imports this. Screens read it through the hooks.

import { create } from 'zustand'
import type {
  Annotation, DocumentMeta, Highlight, JunctionType, OutboxIntent, SyncStatus, Tag,
} from './types'

export type IndexState = {
  documents: Record<string, DocumentMeta>
  highlights: Record<string, Highlight>
  annotations: Record<string, Annotation>
  tags: Record<string, Tag>
  // parentId → tagId[]
  documentTags: Record<string, string[]>
  annotationTags: Record<string, string[]>
  highlightTags: Record<string, string[]>
  outbox: OutboxIntent[]
  dirty: Record<string, number> // dirtyKey → base_rev
  syncStatus: SyncStatus
  syncError: string | null
  lastSyncedAt: string | null
  // True once open() has warmed the index from SQLite. Screens gate their empty state
  // on it so a cold start shows a skeleton, not a false "nothing here".
  hydrated: boolean
}

export const EMPTY_INDEX: IndexState = {
  documents: {},
  highlights: {},
  annotations: {},
  tags: {},
  documentTags: {},
  annotationTags: {},
  highlightTags: {},
  outbox: [],
  dirty: {},
  syncStatus: 'idle',
  syncError: null,
  lastSyncedAt: null,
  hydrated: false,
}

// Which index slice holds a junction type's parentId → tagId[] map.
export const JUNCTION_KEY: Record<JunctionType, 'documentTags' | 'annotationTags' | 'highlightTags'> = {
  doc: 'documentTags', ann: 'annotationTags', hl: 'highlightTags',
}

export const useIndex = create<IndexState>(() => ({ ...EMPTY_INDEX }))
