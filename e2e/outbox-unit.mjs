#!/usr/bin/env node
// Storage-module unit tests (mocked, no network): the outbox + dirty-aware merge
// reducers as PURE functions. Transpiles app/src/store/outbox.ts with the app's own
// esbuild and asserts:
//   - mutation ⇒ outbox intent enqueued + row marked dirty
//   - push-success ⇒ intent removed + dirty cleared (unless another intent owns the row)
//   - pull on a CLEAN row ⇒ applied
//   - pull on a DIRTY row ⇒ local value preserved (not clobbered)
//   - high-frequency intents coalesce (last write wins)
//
// Run via: just e2e-unit

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dir, '..')
const APP = join(ROOT, 'app')
const ESBUILD = join(APP, 'node_modules', '.bin', 'esbuild')

const out = join(mkdtempSync(join(tmpdir(), 'outbox-unit-')), 'outbox.mjs')
execSync(`"${ESBUILD}" src/store/outbox.ts --bundle --format=esm --platform=node --log-level=error --outfile="${out}"`, { cwd: APP })
const O = await import(out)

let failed = 0
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { console.log(`  PASS ${name}`) }
  else { console.error(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`); failed++ }
}
function ok(name, cond) { eq(name, !!cond, true) }

const mkIntent = (over = {}) => ({ id: 'i1', kind: 'hl_pin', args: { id: 'h1', pinned: true }, tries: 0, createdAt: 't', baseRev: 3, ...over })

// ── enqueue / coalesce / remove ──
{
  let ob = []
  ob = O.enqueueIntent(ob, mkIntent())
  eq('enqueue appends', ob.length, 1)
  ob = O.enqueueIntent(ob, mkIntent({ id: 'i2', kind: 'read_progress', args: { docId: 'd1', scrollY: 0.2 }, coalesceKey: 'read_progress:d1' }))
  ob = O.enqueueIntent(ob, mkIntent({ id: 'i3', kind: 'read_progress', args: { docId: 'd1', scrollY: 0.9 }, coalesceKey: 'read_progress:d1' }))
  eq('coalesce keeps only latest position', ob.filter(i => i.coalesceKey === 'read_progress:d1').length, 1)
  eq('coalesce keeps the newest value', ob.find(i => i.coalesceKey === 'read_progress:d1').args.scrollY, 0.9)
  eq('coalesce leaves other intents', ob.length, 2)
  ob = O.removeIntent(ob, 'i1')
  ok('removeIntent drops it', !ob.find(i => i.id === 'i1'))
}

// ── dirty keys owned by an intent ──
eq('hl intent dirty key', O.intentDirtyKeys(mkIntent()), ['hl:h1'])
eq('ann intent dirty key', O.intentDirtyKeys(mkIntent({ kind: 'ann_create', args: { id: 'a1' } })), ['ann:a1'])
eq('doc-tag intent dirty key', O.intentDirtyKeys(mkIntent({ kind: 'doc_tag_add', args: { parentId: 'd1', tagId: 't1' } })), ['jt:doc:d1:t1'])
eq('read_progress owns no row', O.intentDirtyKeys(mkIntent({ kind: 'read_progress', args: { docId: 'd1' } })), [])

// ── mutation ⇒ outbox + dirty (integrated, using the pure pieces) ──
{
  let ob = [], dirty = {}
  const intent = mkIntent()
  ob = O.enqueueIntent(ob, intent)
  for (const k of O.intentDirtyKeys(intent)) dirty = O.addDirty(dirty, k, intent.baseRev)
  eq('mutation enqueued intent', ob.length, 1)
  eq('mutation marked row dirty with base_rev', dirty, { 'hl:h1': 3 })

  // push-success ⇒ intent removed + dirty cleared (nothing else owns the row)
  const remaining = O.removeIntent(ob, intent.id)
  const dirty2 = O.clearDirtyForSucceeded(dirty, intent, remaining)
  eq('push-success removed intent', remaining.length, 0)
  eq('push-success cleared dirty', dirty2, {})
}

// ── dirty NOT cleared while another queued intent still owns the row ──
{
  const a = mkIntent({ id: 'ia', kind: 'ann_update', args: { id: 'a1', note: 'x', color: 'y' } })
  const b = mkIntent({ id: 'ib', kind: 'ann_tag_add', args: { parentId: 'a1', tagId: 't1' } })
  let dirty = O.addDirty(O.addDirty({}, 'ann:a1', 1), 'jt:ann:a1:t1', 0)
  // push 'a' (ann_update) succeeds; 'b' still queued — but b owns jt:ann:a1:t1, not ann:a1
  const remaining = [b]
  const cleared = O.clearDirtyForSucceeded(dirty, a, remaining)
  ok('ann row dirty cleared (no other intent owns ann:a1)', !('ann:a1' in cleared))
  ok('junction dirty preserved (owned by queued b)', 'jt:ann:a1:t1' in cleared)
}

// ── pull-merge: CLEAN row applied, DIRTY row preserved ──
{
  const local = { a1: { id: 'a1', note: 'LOCAL', updated_at: '2', deleted_at: null } }
  const server = [{ id: 'a1', note: 'SERVER', updated_at: '1', deleted_at: null }]
  const cleanMerged = O.mergeEntities(local, server, () => false)
  eq('pull on CLEAN annotation applies server', cleanMerged.a1.note, 'SERVER')
  const dirtyMerged = O.mergeEntities(local, server, (id) => id === 'a1')
  eq('pull on DIRTY annotation preserves local', dirtyMerged.a1.note, 'LOCAL')

  const serverNew = [{ id: 'a2', note: 'NEW', deleted_at: null }]
  const added = O.mergeEntities(local, serverNew, (id) => id === 'a1')
  ok('pull still adds unrelated server rows while a1 is dirty', added.a2 && added.a1.note === 'LOCAL')
}

// ── highlight merge preserves user fields (pinned/archived_at) on a dirty row ──
{
  const local = { h1: { id: 'h1', body: 'OLD', pinned: 1, archived_at: null, deleted_at: null } }
  const server = [{ id: 'h1', body: 'NEW-CONTENT', pinned: 0, archived_at: '2026-01-01', deleted_at: null }]
  const dirtyMerged = O.mergeHighlights(local, server, (id) => id === 'h1')
  eq('dirty highlight takes fresh server content', dirtyMerged.h1.body, 'NEW-CONTENT')
  eq('dirty highlight keeps local pinned', dirtyMerged.h1.pinned, 1)
  eq('dirty highlight keeps local archived_at', dirtyMerged.h1.archived_at, null)
  const cleanMerged = O.mergeHighlights(local, server, () => false)
  eq('clean highlight takes server pinned', cleanMerged.h1.pinned, 0)
}

// ── junction merge skips a dirty (parent,tag) pair ──
{
  // Local removed t1 from d1 (dirty); server still reports the add — must NOT re-add.
  const local = { d1: [] }
  const serverAdd = [{ id: 'j1', document_id: 'd1', tag_id: 't1', deleted_at: null }]
  const isDirtyJt = (key) => key === O.dirtyKeyJt('doc', 'd1', 't1')
  const merged = O.mergeJunctionTags(local, serverAdd, 'document_id', 'doc', isDirtyJt)
  eq('dirty junction not clobbered by server', merged.d1, [])
  const cleanMerged = O.mergeJunctionTags(local, serverAdd, 'document_id', 'doc', () => false)
  eq('clean junction applies server add', cleanMerged.d1, ['t1'])
}

// ── junction local edits ──
{
  eq('junctionAdd', O.junctionAdd({ d1: ['t1'] }, 'd1', 't2'), { d1: ['t1', 't2'] })
  eq('junctionAdd idempotent', O.junctionAdd({ d1: ['t1'] }, 'd1', 't1'), { d1: ['t1'] })
  eq('junctionRemove', O.junctionRemove({ d1: ['t1', 't2'] }, 'd1', 't1'), { d1: ['t2'] })
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1) }
console.log('\nAll outbox unit tests passed')
