// The DB layer's front door. Everything outside src/db/ — screens, the sync engine, the
// pusher — imports from HERE and nothing else: no driver, no query, no memory index.
// That wall is what keeps storage in one place after the blob-replica refactor.
//
//   import * as db from '../../src/db'
//   const docs = db.useDocuments()
//   await db.pinHighlight(id, true)

import { simulateFailedWrites } from '../offlineSim'
import { openDriver } from './driverImpl'
import { migrateFromAsyncStorage } from './legacy'
import { openWith } from './repo'

const DB_NAME = 'samizdat.db'

// Open the local replica: pick the platform's SQLite, migrate, warm the index, then
// retire whatever the pre-SQLite AsyncStorage era left behind. Call it once at startup
// and await it before rendering anything that reads. Idempotent.
export async function open(): Promise<void> {
  await openWith(simulateFailedWrites(await openDriver(DB_NAME)))
  await migrateFromAsyncStorage()
}

export {
  isReady, close, wipe,
  applySync, getCursor, setSyncStatus,
  listOutbox, onIntentSuccess, onIntentRetry, dropIntent,
  getDocument, getSetting, setSetting, getMediaFile, listMediaFiles, setMediaFile,
  pinHighlight, archiveHighlight, deleteHighlight, addTag, removeTag, createTag,
  createAnnotation, updateAnnotation, deleteAnnotation, saveProgress, saveMediaPos,
} from './repo'

export {
  useHydrated, useSyncStatus, useDocuments, useDocument,
  useFeedHighlights, useStarredHighlights, useArchivedHighlights, useHighlightCount,
  useOutboxCount,
  useAnnotations, useAnnotationsFor, useAnnotatedHighlightIds,
  useTags, useTagsWithCounts, useTagLinks,
} from './hooks'

export type {
  Annotation, AnnotationWithContext, Document, DocumentMeta, Highlight, HighlightWithDoc,
  JunctionType, OutboxIntent, SyncPayload, SyncStatus, Tag, TagWithCounts,
} from './types'
