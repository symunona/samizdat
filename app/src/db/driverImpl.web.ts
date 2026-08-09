// Web backend — @journeyapps/wa-sqlite (the maintained PowerSync fork; npm's upstream
// `wa-sqlite` is a stale 2024 stub). Metro resolves this file for web builds only.
//
// **This file must never require COOP/COEP headers.** expo-sqlite's web target needs
// SharedArrayBuffer, hence cross-origin isolation, and COEP is recursive: it would break
// the YouTube embed in src/YtPlayer.web.tsx. Every wa-sqlite VFS works without those
// headers — that is the whole reason web and native use different engines.
//
// VFS choice, logged at open:
//   - OPFSCoopSyncVFS — fastest, but its synchronous access handles only exist in a
//     dedicated Worker (createSyncAccessHandle is not exposed on the main thread), so it
//     is used only when this bundle is actually running in one.
//   - IDBBatchAtomicVFS — works in every context including the main thread and Safari's
//     private mode, where OPFS is missing entirely. This is what the app gets today.
// Both run on the SAME Asyncify build, so the choice costs no extra wasm download.

import * as SQLite from '@journeyapps/wa-sqlite'
import SQLiteAsyncFactory from '@journeyapps/wa-sqlite/dist/wa-sqlite-async.mjs'
import { IDBBatchAtomicVFS } from '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js'
import { OPFSCoopSyncVFS } from '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js'
import { createLogger } from '../logger'
import type { SqlDriver, SqlRow, SqlValue } from './driver'

const log = createLogger('db.web')

// The wasm binary is served as a static asset from the app's public/ directory: Metro
// does not bundle .wasm, and asking it to would buy nothing — the file is fetched by URL
// either way, same-origin, no headers involved.
const WASM_DIR = '/wasm/'

// The package's bundled .d.ts predates the `static create()` factories; the runtime has
// them on every example VFS. One cast, named, rather than `any` at each call site.
type VfsFactory = { create(name: string, module: object): Promise<SQLiteVFS> }

// OPFS sync access handles are exposed only in a dedicated worker. Feature-detect rather
// than assume: this lights up on its own the day the DB moves off the main thread.
function canUseOpfsSyncHandles(): boolean {
  return typeof FileSystemFileHandle !== 'undefined'
    && 'createSyncAccessHandle' in FileSystemFileHandle.prototype
    && typeof navigator !== 'undefined'
    && typeof navigator.storage?.getDirectory === 'function'
}

export async function openDriver(name: string): Promise<SqlDriver> {
  const wasm = await SQLiteAsyncFactory({ locateFile: (file: string) => `${WASM_DIR}${file}` })
  const sqlite3 = SQLite.Factory(wasm)

  const opfs = canUseOpfsSyncHandles()
  let vfs: SQLiteVFS
  try {
    vfs = opfs
      ? await (OPFSCoopSyncVFS as unknown as VfsFactory).create(name, wasm)
      : await (IDBBatchAtomicVFS as unknown as VfsFactory).create(name, wasm)
    log.log(`opened ${name} on ${opfs ? 'OPFSCoopSyncVFS' : 'IDBBatchAtomicVFS'}`)
  } catch (e) {
    // Safari private mode has no OPFS at all; a storage backend that refuses to open is
    // not a reason to lose the app. Fall back rather than crash.
    log.warn('preferred VFS failed, falling back to IDBBatchAtomicVFS:', e)
    vfs = await (IDBBatchAtomicVFS as unknown as VfsFactory).create(name, wasm)
  }
  sqlite3.vfs_register(vfs, true)
  const db = await sqlite3.open_v2(name)

  // wa-sqlite is one connection on one thread, and the Asyncify build has ONE unwind
  // buffer: two overlapping `step()` chains do not merely interleave statements, they
  // scribble over each other's saved stack — `memory access out of bounds` / `unreachable`,
  // with the whole replica dead until reload. So EVERY public call runs one at a time.
  //
  // The exemption for statements issued from inside a transaction is the `raw` handle
  // below, not a flag: a boolean cannot tell an inner call from an unrelated one, so it
  // let every concurrent read (an outbox drain, a settings lookup) run straight into an
  // open transaction. Reentrancy is an object identity here, which cannot be confused.
  let chain: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  async function query<T>(sql: string, params: SqlValue[]): Promise<T[]> {
    const out: T[] = []
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params)
      const columns = sqlite3.column_names(stmt)
      while (await sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
        const values = sqlite3.row(stmt)
        const row: SqlRow = {}
        columns.forEach((c, i) => { row[c] = values[i] as SqlValue })
        out.push(row as T)
      }
    }
    return out
  }

  // The unqueued handle. Only a transaction body ever holds it — it already owns the
  // queue slot, so going through `serialize` again would deadlock on itself.
  const raw: SqlDriver = {
    exec: async (sql) => { await query(sql, []) },
    all: <T = SqlRow>(sql: string, params: SqlValue[] = []) => query<T>(sql, params),
    run: async (sql, params = []) => { await query(sql, params) },
    tx: async (fn) => {
      // A nested BEGIN is an engine error; repo.ts runs its transactions one after
      // another, never inside one another.
      try {
        await query('BEGIN', [])
        await fn(raw)
        await query('COMMIT', [])
      } catch (e) {
        await query('ROLLBACK', []).catch(() => {})
        throw e
      }
    },
    close: async () => { await sqlite3.close(db) },
  }

  return {
    exec: (sql) => serialize(() => raw.exec(sql)),
    all: <T = SqlRow>(sql: string, params: SqlValue[] = []) => serialize(() => raw.all<T>(sql, params)),
    run: (sql, params = []) => serialize(() => raw.run(sql, params)),
    tx: (fn) => serialize(() => raw.tx(fn)),
    close: () => serialize(() => raw.close()),
  }
}
