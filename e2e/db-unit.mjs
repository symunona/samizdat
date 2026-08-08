#!/usr/bin/env node
// DB-layer unit tests (no network, no browser): the SQLite replica in app/src/db/**
// driven headlessly through node:sqlite. Transpiles the module with the app's own
// esbuild (one --splitting bundle so repo/hooks/index share ONE module instance) and
// asserts the contract the screens will rely on:
//   - open() is idempotent and stamps the schema version
//   - applySync inserts / updates / tombstones, never clobbers a dirty row, moves cursor
//   - a mutation writes SQLite FIRST, then patches the memory index, and enqueues
//     exactly one outbox intent carrying the row's base_rev
//   - position saves coalesce; the outbox keeps FIFO order ACROSS A REOPEN (the
//     durability the old blob store lost)
//   - the list projection never carries the document bodies
//   - a failed write leaves the index unpatched and is reported to persistHealth
//
// Run via: just e2e-db

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')
const APP = join(ROOT, 'app')
const ESBUILD = join(APP, 'node_modules', '.bin', 'esbuild')

const TMP = mkdtempSync(join(tmpdir(), 'db-unit-'))
const OUT = join(TMP, 'bundle')
const ENTRIES = [
  'src/db/repo.ts', 'src/db/hooks.ts', 'src/db/memoryIndex.ts',
  'src/db/queries.ts', 'src/db/schema.ts', 'src/db/driverImpl.node.ts',
  'src/store/persistHealth.ts',
].join(' ')
execSync(
  `"${ESBUILD}" ${ENTRIES} --bundle --splitting --format=esm --platform=node --log-level=error --outdir="${OUT}"`,
  { cwd: APP },
)
const repo = await import(join(OUT, 'db', 'repo.js'))
const hooks = await import(join(OUT, 'db', 'hooks.js'))
const Q = await import(join(OUT, 'db', 'queries.js'))
const S = await import(join(OUT, 'db', 'schema.js'))
const { useIndex } = await import(join(OUT, 'db', 'memoryIndex.js'))
const { openNodeDriver } = await import(join(OUT, 'db', 'driverImpl.node.js'))
const { usePersistHealth } = await import(join(OUT, 'store', 'persistHealth.js'))

let failed = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { console.log(`  PASS ${name}`) }
  else { console.error(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`); failed++ }
}
function ok(name, cond) { eq(name, !!cond, true) }

// ── fixtures ──────────────────────────────────────────────────────────────────
const T0 = '2026-01-01T00:00:00Z'
const doc = (over = {}) => ({
  id: 'd1', canonical_url: 'https://example.com/1', title: 'Doc One',
  markdown: '# body one', fetched_at: T0, excerpt: 'ex one', hero_image_url: '',
  author: 'Ann Author', source_feed_id: null, media_type: 'article',
  media_metadata: '', transcript: '', error_reason: '',
  created_at: T0, updated_at: T0, rev: 1, deleted_at: null, ...over,
})
const hl = (over = {}) => ({
  id: 'h1', document_id: 'd1', pipeline_run_id: 'p1', kind: 'item',
  title: 'HL One', body: 'hl body', body_html: '<p>hl body</p>', metadata: '{}',
  pinned: 0, archived_at: null, created_at: T0, updated_at: T0, rev: 1, deleted_at: null, ...over,
})
const ann = (over = {}) => ({
  id: 'a1', document_id: 'd1', highlight_id: null, exact: 'ex', prefix: 'pre',
  suffix: 'suf', pos_start: 1, pos_end: 5, media_ts_ms: 0, color: 'yellow',
  note: 'SERVER note', created_at: T0, updated_at: T0, rev: 1, deleted_at: null, ...over,
})
const tag = (over = {}) => ({
  id: 't1', name: 'tag-one', color: '#f00', created_at: T0, updated_at: T0,
  rev: 1, deleted_at: null, ...over,
})
const jt = (parentKey, over = {}) => ({
  id: 'j1', [parentKey]: 'd1', tag_id: 't1', created_at: T0, updated_at: T0,
  rev: 1, deleted_at: null, ...over,
})
const payload = (over = {}) => ({
  server_time: '2026-01-01T00:00:09Z',
  documents: [], highlights: [], annotations: [], tags: [],
  document_tags: [], annotation_tags: [], highlight_tags: [], ...over,
})

let driver = null
async function fresh(path = ':memory:') {
  if (repo.isReady()) await repo.close()
  driver = await openNodeDriver(path)
  await repo.openWith(driver)
  return driver
}

// ── schema / lifecycle ────────────────────────────────────────────────────────
{
  await fresh()
  ok('isReady after open', repo.isReady())
  await repo.openWith(driver) // second open must be a no-op, not a re-create
  ok('open() twice is idempotent', repo.isReady())
  const meta = await driver.all(Q.SELECT_META, ['schema_version'])
  eq('schema_version recorded in meta', meta[0]?.value, String(S.SCHEMA_VERSION))
  eq('getCursor null on fresh DB', await repo.getCursor(), null)
  eq('hydrated flag set by open', useIndex.getState().hydrated, true)
}

// ── applySync ─────────────────────────────────────────────────────────────────
{
  await fresh()
  await repo.applySync(payload({ documents: [doc()], highlights: [hl()], tags: [tag()] }))
  eq('applySync inserts document', useIndex.getState().documents.d1?.title, 'Doc One')
  eq('applySync inserts highlight', useIndex.getState().highlights.h1?.title, 'HL One')
  eq('applySync inserts tag', useIndex.getState().tags.t1?.name, 'tag-one')
  eq('cursor advances to server_time', await repo.getCursor(), '2026-01-01T00:00:09Z')
  eq('applySync persists the body', (await repo.getDocument('d1'))?.markdown, '# body one')

  // machine data: a newer server rev overwrites
  await repo.applySync(payload({
    server_time: '2026-01-01T00:00:19Z',
    documents: [doc({ title: 'Doc One v2', rev: 2 })],
  }))
  eq('applySync updates by rev', useIndex.getState().documents.d1?.title, 'Doc One v2')
  eq('update survives to SQLite', (await repo.getDocument('d1'))?.title, 'Doc One v2')
  eq('cursor advanced again', await repo.getCursor(), '2026-01-01T00:00:19Z')

  // empty payload: rows untouched
  await repo.applySync(payload({ server_time: '2026-01-01T00:00:29Z' }))
  eq('empty payload keeps rows', Object.keys(useIndex.getState().documents).length, 1)
  eq('empty payload still advances cursor', await repo.getCursor(), '2026-01-01T00:00:29Z')

  // tombstone
  await repo.applySync(payload({ highlights: [hl({ deleted_at: '2026-01-02T00:00:00Z' })] }))
  ok('tombstone hides highlight from index', !useIndex.getState().highlights.h1)
  eq('tombstoned document row is gone', await repo.getDocument('nope'), null)
}

// dirty row is NOT clobbered by a server pull
{
  await fresh()
  await repo.applySync(payload({ annotations: [ann()] }))
  await repo.updateAnnotation('a1', 'LOCAL note', 'green')
  await repo.applySync(payload({ annotations: [ann({ note: 'SERVER note again', rev: 7 })] }))
  eq('dirty annotation keeps local note', useIndex.getState().annotations.a1?.note, 'LOCAL note')
  eq('dirty annotation kept local in SQLite too',
    (await driver.all(Q.SELECT_ANNOTATIONS))[0]?.note, 'LOCAL note')

  await repo.applySync(payload({ annotations: [ann({ id: 'a2', note: 'OTHER' })] }))
  eq('unrelated server rows still applied while a1 dirty',
    useIndex.getState().annotations.a2?.note, 'OTHER')

  // dirty highlight: fresh server content, local pinned/archived preserved
  await repo.applySync(payload({ highlights: [hl()] }))
  await repo.pinHighlight('h1', true)
  await repo.applySync(payload({ highlights: [hl({ body: 'NEW-CONTENT', pinned: 0, rev: 9 })] }))
  eq('dirty highlight takes fresh server body', useIndex.getState().highlights.h1?.body, 'NEW-CONTENT')
  eq('dirty highlight keeps local pinned', useIndex.getState().highlights.h1?.pinned, 1)
}

// ── the list projection must never carry the bodies ───────────────────────────
{
  await fresh()
  await repo.applySync(payload({ documents: [doc({ markdown: 'x'.repeat(28_000), transcript: '{"en":[]}' })] }))
  const rows = await driver.all(Q.SELECT_DOCUMENTS_META)
  const cols = Object.keys(rows[0] ?? {})
  ok('list projection returns the row', rows.length === 1)
  ok('list projection has NO markdown column', !cols.includes('markdown'))
  ok('list projection has NO transcript column', !cols.includes('transcript'))
  ok('index holds no markdown', !('markdown' in (useIndex.getState().documents.d1 ?? {})))
  eq('getDocument still returns the body', (await repo.getDocument('d1'))?.markdown.length, 28_000)
}

// ── mutations: SQLite row + exactly one intent with the right base_rev ────────
{
  await fresh()
  await repo.applySync(payload({ documents: [doc()], highlights: [hl({ rev: 4 })], annotations: [ann({ rev: 5 })] }))

  await repo.pinHighlight('h1', true)
  let ob = await repo.listOutbox()
  eq('pinHighlight enqueues exactly one intent', ob.length, 1)
  eq('pinHighlight intent kind', ob[0].kind, 'hl_pin')
  eq('pinHighlight carries base_rev', ob[0].baseRev, 4)
  eq('pinHighlight patched the index', useIndex.getState().highlights.h1.pinned, 1)
  eq('pinHighlight wrote SQLite', (await driver.all(Q.SELECT_HIGHLIGHTS))[0].pinned, 1)
  eq('pinHighlight marked the row dirty', useIndex.getState().dirty['hl:h1'], 4)

  await repo.archiveHighlight('h1', '2026-02-02T00:00:00Z')
  ob = await repo.listOutbox()
  eq('archiveHighlight enqueues one more', ob.length, 2)
  eq('archiveHighlight patched the index', useIndex.getState().highlights.h1.archived_at, '2026-02-02T00:00:00Z')

  await repo.updateAnnotation('a1', 'edited', 'blue')
  eq('updateAnnotation patched the index', useIndex.getState().annotations.a1.note, 'edited')
  eq('updateAnnotation base_rev', (await repo.listOutbox())[2].baseRev, 5)

  await repo.deleteAnnotation('a1')
  ok('deleteAnnotation drops it from the index', !useIndex.getState().annotations.a1)
  eq('deleteAnnotation drops it from SQLite', (await driver.all(Q.SELECT_ANNOTATIONS)).length, 0)
  eq('deleteAnnotation intent kind', (await repo.listOutbox())[3].kind, 'ann_delete')

  await repo.deleteHighlight('h1')
  ok('deleteHighlight drops it from the index', !useIndex.getState().highlights.h1)
  eq('deleteHighlight drops it from SQLite', (await driver.all(Q.SELECT_HIGHLIGHTS)).length, 0)
  eq('five mutations ⇒ five intents', (await repo.listOutbox()).length, 5)
}

// ── addTag / removeTag across all three junction types ────────────────────────
{
  const CASES = [
    ['doc', 'documentTags', 'doc_tag_add', 'doc_tag_remove', Q.SELECT_JUNCTION.doc],
    ['ann', 'annotationTags', 'ann_tag_add', 'ann_tag_remove', Q.SELECT_JUNCTION.ann],
    ['hl', 'highlightTags', 'hl_tag_add', 'hl_tag_remove', Q.SELECT_JUNCTION.hl],
  ]
  for (const [type, mapKey, addKind, removeKind, sel] of CASES) {
    await fresh()
    await repo.addTag(type, 'p1', 't1')
    eq(`addTag(${type}) patches index`, useIndex.getState()[mapKey].p1, ['t1'])
    eq(`addTag(${type}) writes SQLite`, (await driver.all(sel)).length, 1)
    eq(`addTag(${type}) enqueues ${addKind}`, (await repo.listOutbox())[0].kind, addKind)
    eq(`addTag(${type}) marks the pair dirty`, `jt:${type}:p1:t1` in useIndex.getState().dirty, true)
    await repo.addTag(type, 'p1', 't1')
    eq(`addTag(${type}) is idempotent in the index`, useIndex.getState()[mapKey].p1, ['t1'])
    await repo.removeTag(type, 'p1', 't1')
    eq(`removeTag(${type}) patches index`, useIndex.getState()[mapKey].p1, [])
    eq(`removeTag(${type}) deletes the SQLite row`, (await driver.all(sel)).length, 0)
    eq(`removeTag(${type}) enqueues ${removeKind}`, (await repo.listOutbox()).at(-1).kind, removeKind)
  }
}

// ── creates: mint a UUID, honor a client-supplied id ─────────────────────────
{
  await fresh()
  const t = await repo.createTag({ name: 'fresh', color: '#0f0' })
  ok('createTag mints a uuid', /^[0-9a-f-]{36}$/.test(t.id))
  eq('createTag patches the index', useIndex.getState().tags[t.id].name, 'fresh')
  eq('createTag writes SQLite', (await driver.all(Q.SELECT_TAGS)).length, 1)
  eq('createTag enqueues tag_create', (await repo.listOutbox())[0].kind, 'tag_create')
  const t2 = await repo.createTag({ id: 'client-tag-id', name: 'given', color: '#00f' })
  eq('createTag honors a client id', t2.id, 'client-tag-id')

  const a = await repo.createAnnotation({ documentId: 'd1', color: 'yellow', note: 'hi' })
  ok('createAnnotation mints a uuid', /^[0-9a-f-]{36}$/.test(a.id))
  eq('createAnnotation patches the index', useIndex.getState().annotations[a.id].note, 'hi')
  eq('createAnnotation defaults the anchor', [a.pos_start, a.pos_end, a.exact], [0, 0, ''])
  eq('createAnnotation enqueues ann_create', (await repo.listOutbox()).at(-1).kind, 'ann_create')
  const a2 = await repo.createAnnotation({ id: 'client-ann-id', documentId: null, color: 'y', note: 'note' })
  eq('createAnnotation honors a client id', a2.id, 'client-ann-id')
  eq('standalone note keeps a null document_id', a2.document_id, null)
}

// ── position saves coalesce ───────────────────────────────────────────────────
{
  await fresh()
  for (let i = 0; i < 10; i++) await repo.saveProgress('d1', i / 10)
  for (let i = 0; i < 10; i++) await repo.saveMediaPos('d1', i * 1000)
  const ob = await repo.listOutbox()
  eq('10 progress saves coalesce to 1 intent', ob.filter(i => i.kind === 'read_progress').length, 1)
  eq('coalesced progress keeps the newest value', ob.find(i => i.kind === 'read_progress').args.scrollY, 0.9)
  eq('10 media saves coalesce to 1 intent', ob.filter(i => i.kind === 'media_pos').length, 1)
  eq('coalesced media keeps the newest value', ob.find(i => i.kind === 'media_pos').args.mediaPosMs, 9000)
  await repo.saveProgress('d2', 0.5)
  eq('a different document gets its own intent',
    (await repo.listOutbox()).filter(i => i.kind === 'read_progress').length, 2)
}

// ── pusher callbacks ──────────────────────────────────────────────────────────
{
  await fresh()
  await repo.applySync(payload({ highlights: [hl({ rev: 2 })] }))
  await repo.pinHighlight('h1', true)
  await repo.addTag('hl', 'h1', 't1')
  let ob = await repo.listOutbox()
  eq('two intents queued', ob.length, 2)

  await repo.onIntentRetry(ob[0].id)
  eq('onIntentRetry bumps tries', (await repo.listOutbox())[0].tries, 1)
  eq('onIntentRetry keeps the intent queued', (await repo.listOutbox()).length, 2)

  await repo.onIntentSuccess(ob[0].id, 11)
  ob = await repo.listOutbox()
  eq('onIntentSuccess removes the intent', ob.length, 1)
  ok('onIntentSuccess cleared the row dirty flag', !('hl:h1' in useIndex.getState().dirty))
  ok('other dirty keys survive', 'jt:hl:h1:t1' in useIndex.getState().dirty)

  await repo.dropIntent(ob[0].id)
  eq('dropIntent removes it', (await repo.listOutbox()).length, 0)
  ok('dropIntent cleared its dirty key', !('jt:hl:h1:t1' in useIndex.getState().dirty))

  // dropIntent must not disturb intents it does not own
  await repo.pinHighlight('h1', false)
  await repo.addTag('hl', 'h1', 't2')
  const [first, second] = await repo.listOutbox()
  await repo.dropIntent(second.id)
  const left = await repo.listOutbox()
  eq('dropIntent leaves the other intent', left.length, 1)
  eq('dropIntent left the right one', left[0].id, first.id)
  ok('dropIntent kept the other dirty key', 'hl:h1' in useIndex.getState().dirty)
}

// ── durability: FIFO order preserved across a reopen ──────────────────────────
{
  const file = join(TMP, 'durable.db')
  await fresh(file)
  await repo.createTag({ id: 'k1', name: 'one', color: '#1' })
  await repo.createTag({ id: 'k2', name: 'two', color: '#2' })
  await repo.createTag({ id: 'k3', name: 'three', color: '#3' })
  await repo.pinHighlight('h9', true)
  const before = (await repo.listOutbox()).map(i => i.args.id ?? i.args.name)
  await repo.close()

  driver = await openNodeDriver(file)
  await repo.openWith(driver)
  const after = await repo.listOutbox()
  eq('outbox survives a reopen', after.length, 4)
  eq('outbox FIFO order preserved across reopen', after.map(i => i.args.id ?? i.args.name), before)
  eq('rows survive a reopen', Object.keys(useIndex.getState().tags).length, 3)
  eq('dirty set survives a reopen', useIndex.getState().dirty['tag:k1'], 0)
  eq('cursor survives a reopen', await repo.getCursor(), null)
}

// ── settings / media files ────────────────────────────────────────────────────
{
  await fresh()
  eq('getSetting on a missing key is null', await repo.getSetting('nope'), null)
  await repo.setSetting('theme', 'dark')
  eq('setSetting round-trips', await repo.getSetting('theme'), 'dark')
  await repo.setSetting('theme', 'light')
  eq('setSetting overwrites', await repo.getSetting('theme'), 'light')
  await repo.setSetting('doc_hl_exp_d1', '1')
  eq('a second key is independent', await repo.getSetting('doc_hl_exp_d1'), '1')

  eq('getMediaFile on a missing doc is null', await repo.getMediaFile('d1'), null)
  await repo.setMediaFile('d1', 'file:///audio/d1.m4a')
  eq('setMediaFile round-trips', await repo.getMediaFile('d1'), 'file:///audio/d1.m4a')
  await repo.setMediaFile('d2', 'file:///audio/d2.m4a')
  eq('listMediaFiles lists both', (await repo.listMediaFiles()).length, 2)
  await repo.setMediaFile('d1', null)
  eq('setMediaFile(null) removes it', await repo.getMediaFile('d1'), null)
  eq('listMediaFiles reflects the removal', (await repo.listMediaFiles()).length, 1)
}

// ── wipe ──────────────────────────────────────────────────────────────────────
{
  await fresh()
  await repo.applySync(payload({ documents: [doc()], highlights: [hl()], tags: [tag()] }))
  await repo.pinHighlight('h1', true)
  await repo.setSetting('theme', 'dark')
  await repo.wipe()
  eq('wipe empties the index', Object.keys(useIndex.getState().documents).length, 0)
  eq('wipe empties the outbox', (await repo.listOutbox()).length, 0)
  eq('wipe resets the cursor', await repo.getCursor(), null)
  eq('wipe drops the document rows', (await driver.all(Q.SELECT_DOCUMENTS_META)).length, 0)
  eq('wipe drops settings', await repo.getSetting('theme'), null)
  // schema still there: a write right after a wipe must work, not throw
  await repo.applySync(payload({ documents: [doc()] }))
  eq('wipe keeps the schema', (await repo.getDocument('d1'))?.title, 'Doc One')
  const meta = await driver.all(Q.SELECT_META, ['schema_version'])
  eq('wipe keeps the schema version', meta[0]?.value, String(S.SCHEMA_VERSION))
}

// ── a failed write is LOUD and leaves the index untouched ─────────────────────
{
  await fresh()
  await repo.applySync(payload({ highlights: [hl()] }))
  usePersistHealth.setState({ failure: null })
  const good = driver.run.bind(driver)
  driver.run = () => Promise.reject(new Error('SQLITE_FULL: database or disk is full'))
  await repo.pinHighlight('h1', true)
  ok('write failure reported to persistHealth', !!usePersistHealth.getState().failure)
  eq('write failure recognized as a full device', usePersistHealth.getState().failure.full, true)
  eq('failed write did NOT patch the index', useIndex.getState().highlights.h1.pinned, 0)
  eq('failed write enqueued nothing', (await repo.listOutbox()).length, 0)

  driver.run = good
  await repo.pinHighlight('h1', true)
  eq('a later success clears the failure', usePersistHealth.getState().failure, null)
  eq('recovered write patches the index', useIndex.getState().highlights.h1.pinned, 1)
}

// ── highlight joins: parity with the old highlightsFromStore output ───────────
{
  await fresh()
  await repo.applySync(payload({
    documents: [doc()],
    tags: [tag()],
    highlights: [
      hl({ id: 'h1', created_at: '2026-01-01T00:00:00Z' }),
      hl({ id: 'h2', created_at: '2026-01-03T00:00:00Z', pinned: 1 }),
      hl({ id: 'h3', created_at: '2026-01-02T00:00:00Z', archived_at: '2026-01-04T00:00:00Z' }),
    ],
    highlight_tags: [jt('highlight_id', { id: 'j1', highlight_id: 'h1' })],
  }))
  const st = useIndex.getState()
  const feed = hooks.selectHighlights(st, 'feed')
  eq('feed excludes archived', feed.map(h => h.id), ['h2', 'h1'])
  eq('feed is created_at DESC', feed[0].created_at > feed[1].created_at, true)
  // The exact shape the old highlightsFromStore produced, verbatim:
  eq('joined document title', feed[1].document_title, 'Doc One')
  eq('joined document url', feed[1].document_url, 'https://example.com/1')
  eq('joined tags', feed[1].tags, [tag()])
  eq('untagged highlight gets an empty tag list', feed[0].tags, [])
  eq('starred = pinned only', hooks.selectHighlights(st, 'starred').map(h => h.id), ['h2'])
  eq('archived = archived_at set', hooks.selectHighlights(st, 'archived').map(h => h.id), ['h3'])
  eq('highlight count counts every live highlight', hooks.selectHighlightCount(st), 3)

  // missing document ⇒ empty strings, never a crash (old behaviour)
  await repo.applySync(payload({ highlights: [hl({ id: 'h4', document_id: 'gone' })] }))
  const orphan = hooks.selectHighlights(useIndex.getState(), 'feed').find(h => h.id === 'h4')
  eq('orphan highlight joins to empty strings', [orphan.document_title, orphan.document_url], ['', ''])
}

// ── annotation / tag / document projections ───────────────────────────────────
{
  await fresh()
  await repo.applySync(payload({
    documents: [doc(), doc({ id: 'd2', title: 'Doc Two', created_at: '2026-01-05T00:00:00Z' })],
    annotations: [ann(), ann({ id: 'a2', document_id: null, created_at: '2026-01-06T00:00:00Z' })],
    tags: [tag(), tag({ id: 't2', name: 'a-tag' })],
    document_tags: [jt('document_id')],
    annotation_tags: [jt('annotation_id', { id: 'j2', annotation_id: 'a1' })],
  }))
  const st = useIndex.getState()
  eq('documents newest first', hooks.selectDocuments(st).map(d => d.id), ['d2', 'd1'])
  const anns = hooks.selectAnnotations(st)
  eq('annotations newest first', anns.map(a => a.id), ['a2', 'a1'])
  eq('annotation joins its document title', anns[1].docTitle, 'Doc One')
  eq('standalone note has no docTitle', anns[0].docTitle, null)
  eq('annotation joins its tags', anns[1].tags.map(t => t.id), ['t1'])
  const counted = hooks.selectTagsWithCounts(st)
  eq('tag counts', counted.map(t => [t.id, t.doc_count, t.ann_count]), [['t1', 1, 1], ['t2', 0, 0]])
  eq('annotationsFor a document', hooks.selectAnnotationsFor(st, { documentId: 'd1' }).map(a => a.id), ['a1'])
  eq('tag links for an object', hooks.selectTagLinks(st, 'doc', 'd1'), ['t1'])
  eq('tag links for an unknown object', hooks.selectTagLinks(st, 'doc', 'zzz'), [])
}

// ── sync status ───────────────────────────────────────────────────────────────
{
  await fresh()
  repo.setSyncStatus('syncing')
  eq('setSyncStatus syncing', hooks.selectSyncStatus(useIndex.getState()).status, 'syncing')
  repo.setSyncStatus('error', 'boom')
  eq('setSyncStatus error text', hooks.selectSyncStatus(useIndex.getState()).error, 'boom')
  await repo.applySync(payload())
  eq('applySync clears the error', hooks.selectSyncStatus(useIndex.getState()).error, null)
  eq('applySync returns to idle', hooks.selectSyncStatus(useIndex.getState()).status, 'idle')
}

await repo.close()
if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1) }
console.log('\nAll db-layer unit tests passed')
