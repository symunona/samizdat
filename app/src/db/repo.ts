// Every imperative operation on the replica: open/wipe, the sync apply path, the twelve
// user mutations, the outbox drain callbacks, settings and offline media files.
//
// The contract, in one line: **SQLite first, then the memory index.** A write that fails
// leaves the index untouched, so the UI can never show a change that did not persist —
// and the failure is reported to persistHealth (drawer dot + Settings card + device log)
// instead of vanishing into an un-awaited promise the way the old blob store's did.
//
// Rows are merged with the SAME pure reducers the blob store used (src/store/outbox.ts):
// machine data is server-authoritative, a locally-dirty row is not clobbered by an older
// pull, and the SQL write is derived from the merged value, so the two can't diverge.

import { createLogger } from '../logger'
import { reportPersistWrite } from '../store/persistHealth'
import { uuidv4 } from '../store/uuid'
import {
  addDirty, bumpIntentTries, clearDirtyForSucceeded, dirtyKeyAnn, dirtyKeyHl, dirtyKeyTag,
  enqueueIntent, intentDirtyKeys, junctionAdd, junctionRemove, mergeEntities,
  mergeHighlights, mergeJunctionTags, newAnnotationRow, newTagRow, removeIntent,
} from '../store/outbox'
import type { SqlDriver, SqlRow, SqlValue } from './driver'
import { EMPTY_INDEX, JUNCTION_KEY, useIndex, type IndexState } from './memoryIndex'
import * as Q from './queries'
import { META_LAST_SYNCED_AT, META_SCHEMA_VERSION, MIGRATIONS, SCHEMA_VERSION } from './schema'
import type {
  Annotation, Document, DocumentMeta, Highlight, JunctionType, OutboxIntent, OutboxKind,
  SyncPayload, SyncStatus, Tag,
} from './types'

const log = createLogger('db')

let driver: SqlDriver | null = null
let ready = false

const nowISO = () => new Date().toISOString()

// ── row ↔ object mapping ──────────────────────────────────────────────────────
const str = (v: SqlValue): string => (v == null ? '' : String(v))
const nullable = (v: SqlValue): string | null => (v == null ? null : String(v))
const optional = (v: SqlValue): string | undefined => (v == null ? undefined : String(v))
const optionalNum = (v: SqlValue): number | undefined => (v == null ? undefined : Number(v))

function parseJson<T>(v: SqlValue): T | undefined {
  if (v == null) return undefined
  try { return JSON.parse(String(v)) as T } catch { return undefined }
}

function docParams(d: Document): SqlValue[] {
  return [
    d.id, d.canonical_url ?? '', d.title ?? '', d.markdown ?? '', d.fetched_at ?? '',
    d.excerpt ?? '', d.hero_image_url ?? '', d.author ?? '', d.published_at ?? null,
    d.source_feed_id ?? null,
    d.media_type ?? null, d.media_metadata ?? null, d.transcript ?? null,
    d.error_reason ?? null, d.annotation_count ?? null, d.highlight_count ?? null,
    d.capture_ms ?? null, d.added_via ? JSON.stringify(d.added_via) : null,
    d.created_at ?? '', d.updated_at ?? '', d.rev ?? 0, d.deleted_at ?? null,
  ]
}

function rowToDocMeta(r: SqlRow): DocumentMeta {
  return {
    id: str(r.id), canonical_url: str(r.canonical_url), title: str(r.title),
    fetched_at: str(r.fetched_at), excerpt: str(r.excerpt),
    hero_image_url: str(r.hero_image_url), author: str(r.author),
    published_at: nullable(r.published_at),
    source_feed_id: nullable(r.source_feed_id),
    media_type: optional(r.media_type) as Document['media_type'],
    media_metadata: optional(r.media_metadata), error_reason: optional(r.error_reason),
    annotation_count: optionalNum(r.annotation_count),
    highlight_count: optionalNum(r.highlight_count),
    capture_ms: optionalNum(r.capture_ms),
    added_via: parseJson<Document['added_via']>(r.added_via),
    created_at: str(r.created_at), updated_at: str(r.updated_at),
    rev: Number(r.rev ?? 0), deleted_at: nullable(r.deleted_at),
  }
}

const rowToDocument = (r: SqlRow): Document => ({
  ...rowToDocMeta(r), markdown: str(r.markdown), transcript: optional(r.transcript),
})

// The index never holds a body — see DocumentMeta.
function toMeta(d: Document): DocumentMeta {
  const meta: Partial<Document> = { ...d }
  delete meta.markdown
  delete meta.transcript
  return meta as DocumentMeta
}

function hlParams(h: Highlight): SqlValue[] {
  return [
    h.id, h.document_id ?? '', h.pipeline_run_id ?? '', h.kind ?? '', h.title ?? '',
    h.body ?? '', h.body_html ?? null, h.metadata ?? '', h.pinned ? 1 : 0,
    h.archived_at ?? null, h.created_at ?? '', h.updated_at ?? '', h.rev ?? 0,
    h.deleted_at ?? null,
  ]
}

const rowToHighlight = (r: SqlRow): Highlight => ({
  id: str(r.id), document_id: str(r.document_id), pipeline_run_id: str(r.pipeline_run_id),
  kind: str(r.kind), title: str(r.title), body: str(r.body),
  body_html: optional(r.body_html), metadata: str(r.metadata), pinned: Number(r.pinned ?? 0),
  archived_at: nullable(r.archived_at), created_at: str(r.created_at),
  updated_at: str(r.updated_at), rev: Number(r.rev ?? 0), deleted_at: nullable(r.deleted_at),
})

function annParams(a: Annotation): SqlValue[] {
  return [
    a.id, a.document_id ?? null, a.highlight_id ?? null, a.exact ?? '', a.prefix ?? '',
    a.suffix ?? '', a.pos_start ?? 0, a.pos_end ?? 0, a.media_ts_ms ?? 0, a.color ?? '',
    a.note ?? '', a.created_at ?? '', a.updated_at ?? '', a.rev ?? 0, a.deleted_at ?? null,
  ]
}

const rowToAnnotation = (r: SqlRow): Annotation => ({
  id: str(r.id), document_id: nullable(r.document_id), highlight_id: nullable(r.highlight_id),
  exact: str(r.exact), prefix: str(r.prefix), suffix: str(r.suffix),
  pos_start: Number(r.pos_start ?? 0), pos_end: Number(r.pos_end ?? 0),
  media_ts_ms: Number(r.media_ts_ms ?? 0), color: str(r.color), note: str(r.note),
  created_at: str(r.created_at), updated_at: str(r.updated_at), rev: Number(r.rev ?? 0),
  deleted_at: nullable(r.deleted_at),
})

const tagParams = (t: Tag): SqlValue[] => [
  t.id, t.name ?? '', t.color ?? '', t.created_at ?? '', t.updated_at ?? '', t.rev ?? 0,
  t.deleted_at ?? null,
]

const rowToTag = (r: SqlRow): Tag => ({
  id: str(r.id), name: str(r.name), color: str(r.color), created_at: str(r.created_at),
  updated_at: str(r.updated_at), rev: Number(r.rev ?? 0), deleted_at: nullable(r.deleted_at),
})

const rowToIntent = (r: SqlRow): OutboxIntent => ({
  id: str(r.id), kind: str(r.kind) as OutboxKind,
  args: parseJson<Record<string, unknown>>(r.args) ?? {},
  tries: Number(r.tries ?? 0), createdAt: str(r.created_at), baseRev: Number(r.base_rev ?? 0),
  coalesceKey: optional(r.coalesce_key),
})

function junctionMap(rows: SqlRow[]): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const r of rows) {
    const parent = str(r.parent_id)
    ;(map[parent] ??= []).push(str(r.tag_id))
  }
  return map
}

// ── the write gate ────────────────────────────────────────────────────────────
// Every write goes through here, and the outcome is reported to persistHealth exactly
// once. Returns false when the write failed — callers MUST then leave the index alone.
//
// Writes are SERIALIZED. A replica has one connection, so two overlapping transactions
// are not two transactions: the second `BEGIN` lands inside the first and the engine
// rejects it ("cannot start a transaction within a transaction"), losing whichever
// write got there second. Nothing upstream awaits — a screen fires a mutation while a
// sync is mid-apply as a matter of course — so the ordering has to be enforced here,
// the one place every write passes through.
let queue: Promise<void> = Promise.resolve()

// Opens one transaction per call. Handed to `writeMany` so a caller can split a huge
// delta across several of them while still holding the queue slot for all of them.
type TxRunner = (body: (d: SqlDriver) => Promise<void>) => Promise<void>

async function writeMany(fn: (tx: TxRunner) => Promise<void>): Promise<boolean> {
  const run = queue.then(() => attempt(fn))
  queue = run.then(() => {}, () => {}) // a failed write must not wedge the queue
  return run
}

// The common case: everything in a single transaction.
const write = (fn: (d: SqlDriver) => Promise<void>): Promise<boolean> =>
  writeMany((tx) => tx(fn))

async function attempt(fn: (tx: TxRunner) => Promise<void>): Promise<boolean> {
  if (!driver) {
    reportPersistWrite(new Error('local database is not open'))
    return false
  }
  const d = driver
  try {
    await fn((body) => d.tx(body))
    reportPersistWrite(null)
    return true
  } catch (e) {
    log.error('local write failed:', e)
    reportPersistWrite(e)
    return false
  }
}

async function read<T = SqlRow>(sql: string, params: SqlValue[] = []): Promise<T[]> {
  if (!driver) return []
  return driver.all<T>(sql, params)
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

// Attach a driver: migrate the schema, then warm the memory index from it. Idempotent —
// calling it again with the same driver is a no-op, so a re-render can't re-read the
// whole replica. `index.ts` wraps this with the platform driver; the tests pass their own.
export async function openWith(d: SqlDriver): Promise<void> {
  if (ready && driver === d) return
  driver = d
  try {
    await migrate(d)
    await warm(d)
  } catch (e) {
    // A replica that cannot even open is the loudest possible version of the failure
    // this layer exists to make visible — report it, and mark the index hydrated anyway
    // so the screens show their empty state instead of sitting on a skeleton forever
    // with nothing saying why. The Settings card and the drawer dot say why.
    log.error('could not open the local replica:', e)
    reportPersistWrite(e)
    useIndex.setState({ hydrated: true })
    throw e
  }
  ready = true
}

export function isReady(): boolean {
  return ready
}

export async function close(): Promise<void> {
  const d = driver
  driver = null
  ready = false
  useIndex.setState({ ...EMPTY_INDEX })
  if (d) await d.close()
}

async function migrate(d: SqlDriver): Promise<void> {
  // MIGRATIONS[0] is the whole schema in CREATE ... IF NOT EXISTS form, so running it
  // first is both the fresh-install path and a no-op on an existing DB.
  await d.exec(MIGRATIONS[0])
  const rows = await d.all(Q.SELECT_META, [META_SCHEMA_VERSION])
  const current = Number(rows[0]?.value ?? 0)
  for (let v = Math.max(current, 1); v < SCHEMA_VERSION; v++) await d.exec(MIGRATIONS[v])
  if (current !== SCHEMA_VERSION) {
    await d.run(Q.UPSERT_META, [META_SCHEMA_VERSION, String(SCHEMA_VERSION)])
  }
}

async function warm(d: SqlDriver): Promise<void> {
  const [docs, hls, anns, tags, jDoc, jAnn, jHl, outbox, dirtyRows, cursor] = await Promise.all([
    d.all(Q.SELECT_DOCUMENTS_META), d.all(Q.SELECT_HIGHLIGHTS), d.all(Q.SELECT_ANNOTATIONS),
    d.all(Q.SELECT_TAGS), d.all(Q.SELECT_JUNCTION.doc), d.all(Q.SELECT_JUNCTION.ann),
    d.all(Q.SELECT_JUNCTION.hl), d.all(Q.SELECT_OUTBOX), d.all(Q.SELECT_DIRTY),
    d.all(Q.SELECT_META, [META_LAST_SYNCED_AT]),
  ])
  const byId = <T extends { id: string }>(rows: SqlRow[], map: (r: SqlRow) => T): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const r of rows) { const v = map(r); out[v.id] = v }
    return out
  }
  const dirty: Record<string, number> = {}
  for (const r of dirtyRows) dirty[str(r.key)] = Number(r.base_rev ?? 0)
  useIndex.setState({
    documents: byId(docs, rowToDocMeta),
    highlights: byId(hls, rowToHighlight),
    annotations: byId(anns, rowToAnnotation),
    tags: byId(tags, rowToTag),
    documentTags: junctionMap(jDoc),
    annotationTags: junctionMap(jAnn),
    highlightTags: junctionMap(jHl),
    outbox: outbox.map(rowToIntent),
    dirty,
    lastSyncedAt: cursor[0] ? str(cursor[0].value) : null,
    hydrated: true,
  })
  log.log(`index warmed: ${docs.length} documents, ${hls.length} highlights, ${outbox.length} queued intents`)
}

// Drop every row but keep the schema — Settings' "clear local data" and the recovery
// path for a replica that went bad. The next pull starts from since=null.
export async function wipe(): Promise<void> {
  const ok = await write(async (d) => { for (const sql of Q.WIPE_SQL) await d.exec(sql) })
  if (!ok) return
  useIndex.setState({ ...EMPTY_INDEX, hydrated: true })
}

// ── sync ──────────────────────────────────────────────────────────────────────

// The row maps one applied delta touches. Carried out of the write callback rather than
// returned, because the callback's contract is "do the SQL", not "produce a value".
type SyncMerge = Pick<IndexState,
  'documents' | 'highlights' | 'annotations' | 'tags'
  | 'documentTags' | 'annotationTags' | 'highlightTags'>

// How many documents go into one transaction. Documents carry the bodies (~30KB each,
// and a first pull is the WHOLE library), and a transaction's dirty pages are held in
// memory until it commits — on web that memory is the wasm heap, which aborts outright
// when a multi-megabyte delta lands as a single transaction. Batching bounds it. The
// cursor is written last, so a batch that fails leaves `since` where it was and the next
// pull re-applies the same delta; every row write is an upsert, so replaying is a no-op.
const DOCUMENT_BATCH = 10

function batches<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// Apply one server delta. The merge (with the same dirty-aware reducers the blob store
// used) happens INSIDE the write, so it sees every mutation that landed while the pull
// was in flight — a delta computed against a pre-fetch snapshot would silently drop the
// star the user tapped meanwhile. Then SQLite, then the index, so the two can't differ.
export async function applySync(payload: SyncPayload): Promise<void> {
  const out: { merged?: SyncMerge } = {}

  const ok = await writeMany(async (runTx) => {
    const s = useIndex.getState()
    const isDirty = (key: string) => key in s.dirty

    const documents = mergeEntities(s.documents, payload.documents.map(toMeta), () => false)
    const highlights = mergeHighlights(s.highlights, payload.highlights, (id) => isDirty(dirtyKeyHl(id)))
    const annotations = mergeEntities(s.annotations, payload.annotations, (id) => isDirty(dirtyKeyAnn(id)))
    const tags = mergeEntities(s.tags, payload.tags, (id) => isDirty(dirtyKeyTag(id)))
    const documentTags = mergeJunctionTags(s.documentTags, payload.document_tags, 'document_id', 'doc', isDirty)
    const annotationTags = mergeJunctionTags(s.annotationTags, payload.annotation_tags, 'annotation_id', 'ann', isDirty)
    const highlightTags = mergeJunctionTags(s.highlightTags, payload.highlight_tags, 'highlight_id', 'hl', isDirty)
    out.merged = { documents, highlights, annotations, tags, documentTags, annotationTags, highlightTags }

    const junctions: [JunctionType, Record<string, string[]>, string, { tag_id: string }[]][] = [
      ['doc', documentTags, 'document_id', payload.document_tags],
      ['ann', annotationTags, 'annotation_id', payload.annotation_tags],
      ['hl', highlightTags, 'highlight_id', payload.highlight_tags],
    ]
    for (const batch of batches(payload.documents, DOCUMENT_BATCH)) {
      await runTx(async (d) => {
        for (const incoming of batch) {
          if (documents[incoming.id]) await d.run(Q.UPSERT_DOCUMENT, docParams(incoming))
          else await d.run(Q.DELETE_DOCUMENT, [incoming.id])
        }
      })
    }
    // Bodiless rows — small enough that one transaction is never the problem.
    await runTx(async (d) => {
      for (const incoming of payload.highlights) {
        const merged = highlights[incoming.id]
        if (merged) await d.run(Q.UPSERT_HIGHLIGHT, hlParams(merged))
        else await d.run(Q.DELETE_HIGHLIGHT, [incoming.id])
      }
      for (const incoming of payload.annotations) {
        const merged = annotations[incoming.id]
        if (merged) await d.run(Q.UPSERT_ANNOTATION, annParams(merged))
        else await d.run(Q.DELETE_ANNOTATION, [incoming.id])
      }
      for (const incoming of payload.tags) {
        const merged = tags[incoming.id]
        if (merged) await d.run(Q.UPSERT_TAG, tagParams(merged))
        else await d.run(Q.DELETE_TAG, [incoming.id])
      }
      for (const [type, merged, parentKey, rows] of junctions) {
        for (const row of rows) {
          const parentId = (row as unknown as Record<string, string>)[parentKey]
          const linked = (merged[parentId] ?? []).includes(row.tag_id)
          await d.run(linked ? Q.UPSERT_JUNCTION[type] : Q.DELETE_JUNCTION[type], [parentId, row.tag_id])
        }
      }
      // Last, and only here: an unadvanced cursor is safe (the delta replays), an
      // advanced one over a half-written delta is data loss.
      await d.run(Q.UPSERT_META, [META_LAST_SYNCED_AT, payload.server_time])
    })
  })
  if (!ok || !out.merged) throw new Error('could not write the sync delta to the local database')

  useIndex.setState({
    ...out.merged, lastSyncedAt: payload.server_time, syncStatus: 'idle', syncError: null,
  })
}

// The pull cursor. Read from SQLite, not the index: it is the one value a stale index
// must never fake — an unadvanced cursor is what made the phone re-pull forever.
export async function getCursor(): Promise<string | null> {
  const rows = await read(Q.SELECT_META, [META_LAST_SYNCED_AT])
  return rows[0] ? str(rows[0].value) : null
}

export function setSyncStatus(status: SyncStatus, error?: string): void {
  useIndex.setState({ syncStatus: status, syncError: error ?? null })
}

// ── outbox ────────────────────────────────────────────────────────────────────

export async function listOutbox(): Promise<OutboxIntent[]> {
  return (await read(Q.SELECT_OUTBOX)).map(rowToIntent)
}

async function insertIntent(d: SqlDriver, intent: OutboxIntent): Promise<void> {
  if (intent.coalesceKey) await d.run(Q.DELETE_OUTBOX_COALESCED, [intent.coalesceKey])
  await d.run(Q.INSERT_OUTBOX, [
    intent.id, intent.kind, JSON.stringify(intent.args), intent.tries, intent.createdAt,
    intent.baseRev, intent.coalesceKey ?? null,
  ])
  for (const k of intentDirtyKeys(intent)) await d.run(Q.UPSERT_DIRTY, [k, intent.baseRev])
}

// One user mutation: write the row(s) AND the intent in a single transaction, then patch
// the index. `patch` is only ever applied once the write committed.
async function mutate(
  kind: OutboxKind,
  args: Record<string, unknown>,
  opts: { baseRev?: number; coalesceKey?: string },
  rows: (d: SqlDriver) => Promise<void>,
  patch: (s: IndexState) => Partial<IndexState>,
): Promise<boolean> {
  const intent: OutboxIntent = {
    id: uuidv4(), kind, args, tries: 0, createdAt: nowISO(),
    baseRev: opts.baseRev ?? 0, coalesceKey: opts.coalesceKey,
  }
  const ok = await write(async (d) => { await rows(d); await insertIntent(d, intent) })
  if (!ok) return false
  useIndex.setState((s) => {
    let dirty = s.dirty
    for (const k of intentDirtyKeys(intent)) dirty = addDirty(dirty, k, intent.baseRev)
    return { ...patch(s), outbox: enqueueIntent(s.outbox, intent), dirty }
  })
  return true
}

// A pushed intent landed: drop it, and release the dirty keys no queued intent still
// owns (recording the server rev on any that stay dirty — the Phase 2 conflict seam).
//
// The queue is re-read inside the write, because a drain runs alongside the user: an
// intent enqueued while this one was in flight must not be dropped along with it.
export async function onIntentSuccess(intentId: string, serverRev?: number): Promise<void> {
  const out: { next?: Pick<IndexState, 'outbox' | 'dirty'> } = {}
  const ok = await write(async (d) => {
    const s = useIndex.getState()
    const done = s.outbox.find((i) => i.id === intentId)
    if (!done) return
    const outbox = removeIntent(s.outbox, intentId)
    let dirty = clearDirtyForSucceeded(s.dirty, done, outbox)
    if (serverRev != null) {
      for (const k of intentDirtyKeys(done)) if (k in dirty) dirty = { ...dirty, [k]: serverRev }
    }
    out.next = { outbox, dirty }
    await d.run(Q.DELETE_OUTBOX, [intentId])
    for (const k of Object.keys(s.dirty)) if (!(k in dirty)) await d.run(Q.DELETE_DIRTY, [k])
    if (serverRev != null) {
      for (const k of intentDirtyKeys(done)) {
        if (k in dirty) await d.run(Q.UPDATE_DIRTY_BASE_REV, [serverRev, k])
      }
    }
  })
  if (ok && out.next) useIndex.setState(out.next)
}

export async function onIntentRetry(intentId: string): Promise<void> {
  const ok = await write(async (d) => { await d.run(Q.BUMP_OUTBOX_TRIES, [intentId]) })
  if (!ok) return
  useIndex.setState((s) => ({ outbox: bumpIntentTries(s.outbox, intentId) }))
}

// A permanently-rejected intent (4xx): drop it so it can't wedge the queue, releasing
// its dirty keys exactly like a success would.
export async function dropIntent(intentId: string): Promise<void> {
  const out: { next?: Pick<IndexState, 'outbox' | 'dirty'> } = {}
  const ok = await write(async (d) => {
    const s = useIndex.getState()
    const done = s.outbox.find((i) => i.id === intentId)
    if (!done) return
    const outbox = removeIntent(s.outbox, intentId)
    const dirty = clearDirtyForSucceeded(s.dirty, done, outbox)
    out.next = { outbox, dirty }
    await d.run(Q.DELETE_OUTBOX, [intentId])
    for (const k of Object.keys(s.dirty)) if (!(k in dirty)) await d.run(Q.DELETE_DIRTY, [k])
  })
  if (ok && out.next) useIndex.setState(out.next)
}

// ── imperative reads ──────────────────────────────────────────────────────────

// The FULL document, bodies included — the one place markdown/transcript are loaded.
export async function getDocument(id: string): Promise<Document | null> {
  const rows = await read(Q.SELECT_DOCUMENT, [id])
  return rows[0] ? rowToDocument(rows[0]) : null
}

export async function getSetting(key: string): Promise<string | null> {
  const rows = await read(Q.SELECT_SETTING, [key])
  return rows[0] ? str(rows[0].value) : null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await write(async (d) => { await d.run(Q.UPSERT_SETTING, [key, value]) })
}

// Offline-synced audio: the local file URI for a document, if it was downloaded.
export async function getMediaFile(documentId: string): Promise<string | null> {
  const rows = await read(Q.SELECT_MEDIA_FILE, [documentId])
  return rows[0] ? str(rows[0].uri) : null
}

export async function listMediaFiles(): Promise<{ documentId: string; uri: string }[]> {
  return (await read(Q.SELECT_MEDIA_FILES)).map((r) => ({
    documentId: str(r.document_id), uri: str(r.uri),
  }))
}

// `null` forgets the file (the caller unlinks it) — the offline-cache screen's delete.
export async function setMediaFile(documentId: string, uri: string | null): Promise<void> {
  await write(async (d) => {
    if (uri) await d.run(Q.UPSERT_MEDIA_FILE, [documentId, uri])
    else await d.run(Q.DELETE_MEDIA_FILE, [documentId])
  })
}

// ── mutations ─────────────────────────────────────────────────────────────────
// Same names, same arguments as the old src/store/mutations.ts facade; they now return
// a promise (the write is real I/O), which a fire-and-forget caller may ignore.

export async function pinHighlight(hlId: string, pinned: boolean): Promise<void> {
  const hl = useIndex.getState().highlights[hlId]
  const next = hl ? { ...hl, pinned: pinned ? 1 : 0 } : null
  await mutate('hl_pin', { id: hlId, pinned }, { baseRev: hl?.rev },
    async (d) => { if (next) await d.run(Q.UPSERT_HIGHLIGHT, hlParams(next)) },
    (s) => (next ? { highlights: { ...s.highlights, [hlId]: next } } : {}))
}

export async function archiveHighlight(hlId: string, archivedAt: string | null): Promise<void> {
  const hl = useIndex.getState().highlights[hlId]
  const next = hl ? { ...hl, archived_at: archivedAt } : null
  await mutate('hl_archive', { id: hlId, archivedAt }, { baseRev: hl?.rev },
    async (d) => { if (next) await d.run(Q.UPSERT_HIGHLIGHT, hlParams(next)) },
    (s) => (next ? { highlights: { ...s.highlights, [hlId]: next } } : {}))
}

export async function deleteHighlight(hlId: string): Promise<void> {
  const hl = useIndex.getState().highlights[hlId]
  await mutate('hl_delete', { id: hlId }, { baseRev: hl?.rev },
    async (d) => { await d.run(Q.DELETE_HIGHLIGHT, [hlId]) },
    (s) => {
      const highlights = { ...s.highlights }
      delete highlights[hlId]
      return { highlights }
    })
}

const JT_ADD_KIND: Record<JunctionType, OutboxKind> = {
  doc: 'doc_tag_add', ann: 'ann_tag_add', hl: 'hl_tag_add',
}
const JT_REMOVE_KIND: Record<JunctionType, OutboxKind> = {
  doc: 'doc_tag_remove', ann: 'ann_tag_remove', hl: 'hl_tag_remove',
}

export async function addTag(type: JunctionType, parentId: string, tagId: string): Promise<void> {
  const key = JUNCTION_KEY[type]
  await mutate(JT_ADD_KIND[type], { parentId, tagId }, {},
    async (d) => { await d.run(Q.UPSERT_JUNCTION[type], [parentId, tagId]) },
    (s) => ({ [key]: junctionAdd(s[key], parentId, tagId) }))
}

export async function removeTag(type: JunctionType, parentId: string, tagId: string): Promise<void> {
  const key = JUNCTION_KEY[type]
  await mutate(JT_REMOVE_KIND[type], { parentId, tagId }, {},
    async (d) => { await d.run(Q.DELETE_JUNCTION[type], [parentId, tagId]) },
    (s) => ({ [key]: junctionRemove(s[key], parentId, tagId) }))
}

// Creates are client-minted UUIDs so an offline create can be replayed without
// colliding server-side; a caller may supply its own id for the same reason.
export async function createTag(input: { id?: string; name: string; color: string }): Promise<Tag> {
  const tag = newTagRow({ id: input.id ?? uuidv4(), name: input.name, color: input.color, now: nowISO() })
  await mutate('tag_create', { id: tag.id, name: tag.name, color: tag.color }, {},
    async (d) => { await d.run(Q.UPSERT_TAG, tagParams(tag)) },
    (s) => ({ tags: { ...s.tags, [tag.id]: tag } }))
  return tag
}

export async function createAnnotation(input: {
  id?: string
  documentId: string | null
  highlightId?: string | null
  exact?: string; prefix?: string; suffix?: string
  posStart?: number; posEnd?: number; mediaTsMs?: number
  color: string; note: string
}): Promise<Annotation> {
  const ann = newAnnotationRow({
    id: input.id ?? uuidv4(), documentId: input.documentId, highlightId: input.highlightId,
    exact: input.exact, prefix: input.prefix, suffix: input.suffix,
    posStart: input.posStart, posEnd: input.posEnd, mediaTsMs: input.mediaTsMs,
    color: input.color, note: input.note, now: nowISO(),
  })
  await mutate('ann_create', {
    id: ann.id, documentId: ann.document_id, highlightId: ann.highlight_id,
    exact: ann.exact, prefix: ann.prefix, suffix: ann.suffix,
    posStart: ann.pos_start, posEnd: ann.pos_end, mediaTsMs: ann.media_ts_ms,
    color: ann.color, note: ann.note,
  }, {},
    async (d) => { await d.run(Q.UPSERT_ANNOTATION, annParams(ann)) },
    (s) => ({ annotations: { ...s.annotations, [ann.id]: ann } }))
  return ann
}

export async function updateAnnotation(annId: string, note: string, color: string): Promise<void> {
  const ann = useIndex.getState().annotations[annId]
  const next = ann ? { ...ann, note, color, updated_at: nowISO() } : null
  await mutate('ann_update', { id: annId, note, color }, { baseRev: ann?.rev },
    async (d) => { if (next) await d.run(Q.UPSERT_ANNOTATION, annParams(next)) },
    (s) => (next ? { annotations: { ...s.annotations, [annId]: next } } : {}))
}

export async function deleteAnnotation(annId: string): Promise<void> {
  const ann = useIndex.getState().annotations[annId]
  await mutate('ann_delete', { id: annId }, { baseRev: ann?.rev },
    async (d) => { await d.run(Q.DELETE_ANNOTATION, [annId]) },
    (s) => {
      const annotations = { ...s.annotations }
      delete annotations[annId]
      return { annotations }
    })
}

// Position saves are high-frequency and last-writer-only: the coalesceKey drops any
// superseded save so the queue can never fill with scroll positions.
export async function saveProgress(docId: string, scrollY: number): Promise<void> {
  await mutate('read_progress', { docId, scrollY }, { coalesceKey: `read_progress:${docId}` },
    async () => {}, () => ({}))
}

export async function saveMediaPos(docId: string, mediaPosMs: number): Promise<void> {
  await mutate('media_pos', { docId, mediaPosMs }, { coalesceKey: `media_pos:${docId}` },
    async () => {}, () => ({}))
}
