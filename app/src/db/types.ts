// The DB layer's vocabulary. Row types come from `../api` unchanged — the replica
// mirrors the server's shapes, so a synced row IS the API row and nothing has to be
// re-mapped on the way in or out. This module adds only the joined/derived shapes the
// screens read.

export type {
  Document, Highlight, Annotation, Tag,
  DocumentTag, AnnotationTag, HighlightTag,
  SyncPayload, HighlightWithDoc,
} from '../api'
export type { JunctionType, OutboxIntent, OutboxKind } from '../store/outbox'

import type { Annotation, Document, Tag } from '../api'

// A Document without its bodies. The memory index holds THIS: `markdown` and
// `transcript` run to ~28KB each, and keeping 251 of them resident (plus a copy in
// every list render) is the memory blowup the replica refactor exists to avoid. Read
// a body with `getDocument(id)` / `useDocument(id)`, never from a list.
export type DocumentMeta = Omit<Document, 'markdown' | 'transcript'>

// An annotation enriched for the Notes screen: its live tags, plus the source document
// title when it is anchored (document_id set). docTitle is null for standalone notes.
export type AnnotationWithContext = Annotation & { tags: Tag[]; docTitle: string | null }

export type TagWithCounts = Tag & { doc_count: number; ann_count: number }

export type SyncStatus = 'idle' | 'syncing' | 'error'

// Which subset of highlights a feed-style screen wants. `feed` = everything not
// archived, `starred` = pinned, `archived` = archived_at set.
export type HighlightFilter = 'feed' | 'starred' | 'archived'
