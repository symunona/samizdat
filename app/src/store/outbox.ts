// Offline-first write path — the outbox + dirty-tracking + dirty-aware pull-merge,
// as PURE functions (no zustand, no network, no clock) so they unit-test in a plain
// node harness (see e2e/outbox-unit.mjs). syncStore wires these into the persisted
// store; pushEngine drains the outbox by replaying the REST client.
//
// Principle: every user mutation (1) patches the local store immediately, (2) enqueues
// an ordered outbox intent, (3) marks the affected row(s) `dirty` so a concurrent pull
// can't clobber the un-pushed local value. A background pusher replays intents when
// online; on success it removes the intent and (once nothing else references the row)
// clears dirty and records the server `rev` → `base_rev`.

import type { Annotation, Highlight, Tag } from '../api'

export type JunctionType = 'doc' | 'ann' | 'hl'

export type OutboxKind =
  | 'doc_tag_add' | 'doc_tag_remove'
  | 'ann_tag_add' | 'ann_tag_remove'
  | 'hl_tag_add' | 'hl_tag_remove'
  | 'hl_pin' | 'hl_archive' | 'hl_delete'
  | 'ann_create' | 'ann_update' | 'ann_delete'
  | 'tag_create'
  | 'read_progress' | 'media_pos'

// A queued mutation. `args` carries everything replay() needs to re-issue the REST
// call; client-minted UUID PKs live in args so a replay never collides server-side.
export type OutboxIntent = {
  id: string
  kind: OutboxKind
  args: Record<string, unknown>
  tries: number
  createdAt: string
  // Server rev observed for the row when the intent was queued (0 = unknown). Carried
  // for Phase 2 note-conflict detection; recorded as base_rev on push success.
  baseRev: number
  // High-frequency, last-writer-only intents (read/scroll/media position) share a
  // coalesceKey; enqueue drops any prior intent with the same key so the outbox never
  // fills with superseded position saves.
  coalesceKey?: string
}

// ── dirty keys ────────────────────────────────────────────────────────────────
// A dirty key names the row (or field-group) an intent owns. Pull-merge protects any
// row whose key is dirty; push-success clears it once no queued intent still owns it.
export const dirtyKeyAnn = (id: string) => `ann:${id}`
export const dirtyKeyHl = (id: string) => `hl:${id}`
export const dirtyKeyTag = (id: string) => `tag:${id}`
export const dirtyKeyJt = (type: JunctionType, parentId: string, tagId: string) =>
  `jt:${type}:${parentId}:${tagId}`

const JT_KIND: Record<string, { type: JunctionType }> = {
  doc_tag_add: { type: 'doc' }, doc_tag_remove: { type: 'doc' },
  ann_tag_add: { type: 'ann' }, ann_tag_remove: { type: 'ann' },
  hl_tag_add: { type: 'hl' }, hl_tag_remove: { type: 'hl' },
}

// The dirty keys an intent owns — the rows pull-merge must not clobber while it's queued.
export function intentDirtyKeys(intent: OutboxIntent): string[] {
  const a = intent.args
  switch (intent.kind) {
    case 'hl_pin': case 'hl_archive': case 'hl_delete':
      return [dirtyKeyHl(a.id as string)]
    case 'ann_create': case 'ann_update': case 'ann_delete':
      return [dirtyKeyAnn(a.id as string)]
    case 'tag_create':
      return [dirtyKeyTag(a.id as string)]
    case 'doc_tag_add': case 'doc_tag_remove':
    case 'ann_tag_add': case 'ann_tag_remove':
    case 'hl_tag_add': case 'hl_tag_remove':
      return [dirtyKeyJt(JT_KIND[intent.kind].type, a.parentId as string, a.tagId as string)]
    default:
      return [] // read_progress / media_pos are pure server-upserts — no local row to guard
  }
}

// ── outbox reducers (pure) ──────────────────────────────────────────────────────

// Append an intent, dropping any prior intent sharing its coalesceKey (last write wins).
export function enqueueIntent(outbox: OutboxIntent[], intent: OutboxIntent): OutboxIntent[] {
  const base = intent.coalesceKey
    ? outbox.filter((i) => i.coalesceKey !== intent.coalesceKey)
    : outbox
  return [...base, intent]
}

export function removeIntent(outbox: OutboxIntent[], intentId: string): OutboxIntent[] {
  return outbox.filter((i) => i.id !== intentId)
}

export function bumpIntentTries(outbox: OutboxIntent[], intentId: string): OutboxIntent[] {
  return outbox.map((i) => (i.id === intentId ? { ...i, tries: i.tries + 1 } : i))
}

// Add `key` with baseRev; existing baseRev is preserved (the first-observed base wins,
// which is what Phase 2 conflict detection needs).
export function addDirty(
  dirty: Record<string, number>, key: string, baseRev: number,
): Record<string, number> {
  if (key in dirty) return dirty
  return { ...dirty, [key]: baseRev }
}

export function removeDirty(dirty: Record<string, number>, key: string): Record<string, number> {
  if (!(key in dirty)) return dirty
  const next = { ...dirty }
  delete next[key]
  return next
}

// After an intent succeeds, clear each dirty key it owned UNLESS another queued intent
// still owns it (e.g. a pin + a later tag on the same highlight). `remaining` is the
// outbox with the succeeded intent already removed.
export function clearDirtyForSucceeded(
  dirty: Record<string, number>,
  succeeded: OutboxIntent,
  remaining: OutboxIntent[],
): Record<string, number> {
  const stillOwned = new Set<string>()
  for (const i of remaining) for (const k of intentDirtyKeys(i)) stillOwned.add(k)
  let next = dirty
  for (const k of intentDirtyKeys(succeeded)) {
    if (!stillOwned.has(k)) next = removeDirty(next, k)
  }
  return next
}

// ── dirty-aware pull-merge (pure) ───────────────────────────────────────────────

// Generic entity merge: apply server rows, but a row whose id is currently dirty keeps
// its local value (the un-pushed local edit wins until the pusher confirms it).
export function mergeEntities<T extends { id: string; deleted_at?: string | null }>(
  map: Record<string, T>,
  incoming: T[],
  isDirty: (id: string) => boolean,
): Record<string, T> {
  if (!incoming.length) return map
  const next = { ...map }
  for (const item of incoming) {
    if (isDirty(item.id)) continue
    if (item.deleted_at) delete next[item.id]
    else next[item.id] = item
  }
  return next
}

// Highlights are machine content EXCEPT the user-owned pinned/archived_at fields. On a
// dirty highlight take the fresh server content but preserve those two local fields.
export function mergeHighlights(
  map: Record<string, Highlight>,
  incoming: Highlight[],
  isDirty: (id: string) => boolean,
): Record<string, Highlight> {
  if (!incoming.length) return map
  const next = { ...map }
  for (const item of incoming) {
    if (item.deleted_at && !isDirty(item.id)) { delete next[item.id]; continue }
    if (isDirty(item.id)) {
      const local = next[item.id]
      if (local) { next[item.id] = { ...item, pinned: local.pinned, archived_at: local.archived_at }; continue }
    }
    if (!item.deleted_at) next[item.id] = item
  }
  return next
}

type JunctionRow = { id: string; deleted_at: string | null; tag_id: string } & Record<string, unknown>

// Junction (tag-application) merge: apply server add/remove rows, but skip any row whose
// (parent, tag) pair is dirty — the local add/remove wins until it's pushed.
export function mergeJunctionTags(
  map: Record<string, string[]>,
  incoming: JunctionRow[],
  parentKey: string,
  type: JunctionType,
  isDirtyJt: (key: string) => boolean,
): Record<string, string[]> {
  if (!incoming.length) return map
  const next = { ...map }
  for (const row of incoming) {
    const parentId = row[parentKey] as string
    if (isDirtyJt(dirtyKeyJt(type, parentId, row.tag_id))) continue
    if (row.deleted_at) {
      next[parentId] = (next[parentId] ?? []).filter((tid) => tid !== row.tag_id)
    } else {
      const existing = next[parentId] ?? []
      if (!existing.includes(row.tag_id)) next[parentId] = [...existing, row.tag_id]
    }
  }
  return next
}

// ── junction-map local edits (pure) ─────────────────────────────────────────────
export function junctionAdd(
  map: Record<string, string[]>, parentId: string, tagId: string,
): Record<string, string[]> {
  const existing = map[parentId] ?? []
  if (existing.includes(tagId)) return map
  return { ...map, [parentId]: [...existing, tagId] }
}

export function junctionRemove(
  map: Record<string, string[]>, parentId: string, tagId: string,
): Record<string, string[]> {
  const existing = map[parentId]
  if (!existing || !existing.includes(tagId)) return map
  return { ...map, [parentId]: existing.filter((t) => t !== tagId) }
}

// Optimistic-annotation factory: a store-shaped Annotation for a client-minted create,
// so store readers (Notes list, offline document view) render it before it's pushed.
export function newAnnotationRow(args: {
  id: string
  documentId: string | null
  highlightId?: string | null
  exact?: string
  prefix?: string
  suffix?: string
  posStart?: number
  posEnd?: number
  mediaTsMs?: number
  color: string
  note: string
  now: string
}): Annotation {
  return {
    id: args.id,
    document_id: args.documentId,
    highlight_id: args.highlightId ?? null,
    exact: args.exact ?? '',
    prefix: args.prefix ?? '',
    suffix: args.suffix ?? '',
    pos_start: args.posStart ?? 0,
    pos_end: args.posEnd ?? 0,
    media_ts_ms: args.mediaTsMs ?? 0,
    color: args.color,
    note: args.note,
    created_at: args.now,
    updated_at: args.now,
    rev: 0,
    deleted_at: null,
  }
}

export function newTagRow(args: { id: string; name: string; color: string; now: string }): Tag {
  return {
    id: args.id,
    name: args.name,
    color: args.color,
    created_at: args.now,
    updated_at: args.now,
    rev: 0,
    deleted_at: null,
  }
}
