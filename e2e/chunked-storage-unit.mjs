#!/usr/bin/env node
// Unit test for the chunked AsyncStorage adapter (the fix for Android's ~2MB per-row
// CursorWindow limit that broke offline app-wide). Transpiles chunkedStorage.ts with
// esbuild and asserts, against an in-memory KV backend:
//   - a multi-MB value round-trips identically, split into sub-limit chunks
//   - no single stored row exceeds the chunk size (so it can't hit CursorWindow)
//   - a legacy single-blob value (no manifest) reads back as null (starts clean)
//   - a backend that THROWS on the oversized legacy read is handled (returns null)
//   - shrinking the value drops stale chunks; removeItem clears everything
//   - a REJECTED write (the 6MB whole-DB cap, a different limit from CursorWindow) is
//     reported to the observer instead of escaping as a silent unhandled rejection
//   - isStorageFullError tells a full device from an ordinary write error

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))
const APP = join(__dir, '..', 'app')
const ESBUILD = join(APP, 'node_modules', '.bin', 'esbuild')
const out = join(mkdtempSync(join(tmpdir(), 'chunk-unit-')), 'chunked.mjs')
execSync(`"${ESBUILD}" src/store/chunkedStorage.ts --bundle --format=esm --platform=node --log-level=error --outfile="${out}"`, { cwd: APP })
const { makeChunkedStorage, isStorageFullError } = await import(out)

let failed = 0
const ok = (name, cond) => { if (cond) console.log(`  PASS ${name}`); else { console.error(`  FAIL ${name}`); failed++ } }

// In-memory backend. `throwOver` simulates Android's CursorWindow throw on a big row;
// `writeError`, when set, simulates a backend that can no longer accept ANY write (the
// SQLiteFullException a device past the 6MB whole-DB cap raises).
function backend({ throwOver = Infinity, writeError = null } = {}) {
  const m = new Map()
  return {
    _m: m,
    writeError,
    async getItem(k) { const v = m.has(k) ? m.get(k) : null; if (v != null && v.length > throwOver) throw new Error('Row too big to fit into CursorWindow'); return v },
    async setItem(k, v) { if (this.writeError) throw this.writeError; m.set(k, v) },
    async removeItem(k) { m.delete(k) },
  }
}

const CHUNK = 256 * 1024
const big = 'x'.repeat(Math.floor(CHUNK * 3.5)) + '💾unicode✓' // ~3.5 chunks + multibyte tail

// round-trip + chunk invariants
{
  const kv = backend()
  const s = makeChunkedStorage(kv)
  await s.setItem('k', big)
  ok('round-trips identically', (await s.getItem('k')) === big)
  const manifest = JSON.parse(kv._m.get('k'))
  ok('manifest records chunk count', manifest.__chunks === Math.ceil(big.length / CHUNK))
  const chunkRows = [...kv._m.entries()].filter(([key]) => /^k\.\d+$/.test(key))
  ok('payload split into multiple rows', chunkRows.length === manifest.__chunks && chunkRows.length > 1)
  ok('no single row exceeds the chunk size', chunkRows.every(([, v]) => v.length <= CHUNK))
}

// legacy single blob (no manifest) → null so the store starts clean and rewrites chunked
{
  const kv = backend()
  kv._m.set('k', JSON.stringify({ state: { documents: {} } })) // a real old value, not a manifest
  const s = makeChunkedStorage(kv)
  ok('legacy unchunked blob reads as null', (await s.getItem('k')) === null)
}

// legacy OVERSIZED blob that throws on read (the actual device failure) → null, no throw
{
  const kv = backend({ throwOver: 2 * 1024 * 1024 })
  kv._m.set('k', 'y'.repeat(3 * 1024 * 1024)) // 3MB legacy row → CursorWindow throw
  const s = makeChunkedStorage(kv)
  let threw = false
  let res
  try { res = await s.getItem('k') } catch { threw = true }
  ok('oversized legacy read is caught (no throw)', !threw)
  ok('oversized legacy read returns null', res === null)
}

// shrink drops stale chunks; removeItem clears all
{
  const kv = backend()
  const s = makeChunkedStorage(kv)
  await s.setItem('k', big)
  await s.setItem('k', 'small')
  ok('shrink returns the new value', (await s.getItem('k')) === 'small')
  ok('stale chunks dropped on shrink', [...kv._m.keys()].filter(x => /^k\.\d+$/.test(x)).length === 1)
  await s.removeItem('k')
  ok('removeItem clears manifest + chunks', kv._m.size === 0)
}

// A write that rejects must be REPORTED, never swallowed into an unhandled rejection —
// this is the bug that froze the replica for six days.
{
  const FULL = new Error('android.database.sqlite.SQLiteFullException: database or disk is full')
  const kv = backend()
  const seen = []
  const s = makeChunkedStorage(kv, (err) => seen.push(err))
  await s.setItem('k', 'small')
  ok('a healthy write reports success (null)', seen.length === 1 && seen[0] === null)

  kv.writeError = FULL
  let threw = false
  try { await s.setItem('k', 'bigger value') } catch { threw = true }
  ok('a rejected write does not escape the adapter', !threw)
  ok('a rejected write is reported to the observer', seen.length === 2 && seen[1] === FULL)
  ok('the previous value survives a failed write', (await s.getItem('k')) === 'small')

  kv.writeError = null
  await s.setItem('k', 'bigger value')
  ok('a recovered write reports success again', seen.length === 3 && seen[2] === null)
  ok('the recovered write actually landed', (await s.getItem('k')) === 'bigger value')
}

// The discriminator behind the "device storage is full" copy.
{
  ok('SQLiteFullException reads as a full device', isStorageFullError(new Error('android.database.sqlite.SQLiteFullException: database or disk is full')))
  ok('the sqlite message alone reads as a full device', isStorageFullError(new Error('database or disk is full (code 13)')))
  ok('a browser QuotaExceededError reads as a full device', isStorageFullError(new DOMException('quota', 'QuotaExceededError')))
  ok('an ordinary write error does not', !isStorageFullError(new Error('Row too big to fit into CursorWindow')))
}

if (failed) { console.error(`\n${failed} chunked-storage checks FAILED`); process.exit(1) }
console.log('\nAll chunked-storage unit tests passed')
