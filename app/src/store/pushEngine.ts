// The pusher: drains the persisted outbox by REPLAYING the existing REST client when
// online. Server stays authoritative (assigns rev). Intents are processed strictly in
// order so dependencies hold (a tag/annotation create lands before edits that reference
// it). A failing intent stops the drain for this cycle (retry with backoff) so a later
// intent can't overtake the row it depends on; a permanently-rejected intent (4xx) is
// dropped so it can't wedge the queue forever.

import {
  addDocumentTag, removeDocumentTag,
  addAnnotationTag, removeAnnotationTag,
  addHighlightTag, removeHighlightTag,
  pinHighlight, archiveHighlight, deleteHighlight,
  createAnnotation, createNote, updateAnnotation, deleteAnnotation,
  createTag, saveReadingProgress, saveMediaPosition,
  ApiError,
} from '../api'
import { useSyncStore } from './syncStore'
import type { OutboxIntent } from './outbox'
import { createLogger } from '../logger'

const log = createLogger('pushEngine')

const MAX_BACKOFF_MS = 30_000
const BASE_BACKOFF_MS = 1_000

let draining = false
let retryTimer: ReturnType<typeof setTimeout> | null = null

// Replay one intent against the server. Returns the server rev when the endpoint echoes
// a row (annotation/tag creates + annotation update), else undefined.
async function replay(intent: OutboxIntent, url: string, token: string): Promise<number | undefined> {
  const a = intent.args
  switch (intent.kind) {
    case 'doc_tag_add': await addDocumentTag(url, token, a.parentId as string, a.tagId as string); return
    case 'doc_tag_remove': await removeDocumentTag(url, token, a.parentId as string, a.tagId as string); return
    case 'ann_tag_add': await addAnnotationTag(url, token, a.parentId as string, a.tagId as string); return
    case 'ann_tag_remove': await removeAnnotationTag(url, token, a.parentId as string, a.tagId as string); return
    case 'hl_tag_add': await addHighlightTag(url, token, a.parentId as string, a.tagId as string); return
    case 'hl_tag_remove': await removeHighlightTag(url, token, a.parentId as string, a.tagId as string); return
    case 'hl_pin': await pinHighlight(url, token, a.id as string, a.pinned as boolean); return
    case 'hl_archive': await archiveHighlight(url, token, a.id as string, a.archivedAt as string | null); return
    case 'hl_delete': await deleteHighlight(url, token, a.id as string); return
    case 'ann_create': {
      const ann = a.documentId == null
        ? await createNote(url, token, { id: a.id as string, note: a.note as string, color: a.color as string })
        : await createAnnotation(url, token, a.documentId as string, {
            id: a.id as string,
            exact: a.exact as string, prefix: a.prefix as string, suffix: a.suffix as string,
            pos_start: a.posStart as number, pos_end: a.posEnd as number,
            color: a.color as string, note: a.note as string,
            highlight_id: (a.highlightId as string | null) ?? undefined,
            media_ts_ms: a.mediaTsMs as number,
          })
      return ann.rev
    }
    case 'ann_update': {
      const ann = await updateAnnotation(url, token, a.id as string, { note: a.note as string, color: a.color as string })
      return ann.rev
    }
    case 'ann_delete': await deleteAnnotation(url, token, a.id as string); return
    case 'tag_create': {
      const tag = await createTag(url, token, { id: a.id as string, name: a.name as string, color: a.color as string })
      return tag.rev
    }
    case 'read_progress': await saveReadingProgress(url, token, a.docId as string, a.scrollY as number); return
    case 'media_pos': await saveMediaPosition(url, token, a.docId as string, a.mediaPosMs as number); return
  }
}

// A 4xx (except 408/429) means the server rejected the request on its merits — replaying
// won't help, so the intent is dropped rather than wedging the queue. 401 is transient
// (token refresh in flight) → keep + retry.
function isPermanentFailure(e: unknown): boolean {
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 408 || e.status === 429) return false
    return e.status >= 400 && e.status < 500
  }
  return false
}

function scheduleRetry(url: string, token: string, tries: number) {
  if (retryTimer) return
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(tries, 5))
  retryTimer = setTimeout(() => { retryTimer = null; drainOutbox(url, token).catch(() => {}) }, delay)
}

// Drain the outbox in order. Safe to call repeatedly / concurrently (guarded).
export async function drainOutbox(url: string, token: string): Promise<void> {
  if (draining) return
  draining = true
  try {
    // Re-read the store each iteration — a mutation may append while we drain.
    for (;;) {
      const intent = useSyncStore.getState().outbox[0]
      if (!intent) break
      try {
        const rev = await replay(intent, url, token)
        useSyncStore.getState().onIntentSuccess(intent.id, rev)
      } catch (e) {
        if (isPermanentFailure(e)) {
          log.error(`dropping intent ${intent.kind} (${intent.id}) — permanent failure`, e)
          useSyncStore.getState().dropIntent(intent.id)
          continue // a rejected intent shouldn't block the ones behind it
        }
        // Transient (offline / 5xx / 401): bump tries, stop draining, retry with backoff.
        useSyncStore.getState().onIntentRetry(intent.id)
        scheduleRetry(url, token, intent.tries + 1)
        break
      }
    }
  } finally {
    draining = false
  }
}

// Fire-and-forget trigger used by the outbox-push hook and mutation sites.
export function requestPush(url: string, token: string): void {
  drainOutbox(url, token).catch(() => {})
}
