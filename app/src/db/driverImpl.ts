// Native backend (Android/iOS) — expo-sqlite, the system SQLite. First-party for SDK 56,
// no size cap that matters, and a row write costs a row write instead of re-serializing
// the whole replica the way the AsyncStorage blob did.
//
// Metro resolves `driverImpl.web.ts` for web builds, so this file never reaches a browser
// and the browser's wa-sqlite never reaches a phone.

import * as SQLite from 'expo-sqlite'
import { createLogger } from '../logger'
import type { SqlDriver, SqlRow, SqlValue } from './driver'

const log = createLogger('db')

// A dead native handle. expo-sqlite shares one native connection per path across every
// JS wrapper, and releasing ANY wrapper frees the binding for all of them — its refcount
// only guards the cache, not the close. The survivor's next call dies inside JNI as a
// bare `NullPointerException` ("Call to function 'NativeDatabase.execAsync' has been
// rejected"), `isClosed` still reads false, and every write after it fails until the
// app is killed: the replica froze mid-session and Annotations silently went nowhere.
const isDeadHandle = (e: unknown) => String(e).includes('NullPointerException')

async function connect(name: string): Promise<SQLite.SQLiteDatabase> {
  // Our own connection, never the shared cached one — see isDeadHandle.
  const db = await SQLite.openDatabaseAsync(name, { useNewConnection: true })
  // WAL keeps a reader (a list render) from blocking the sync writer; busy_timeout lets
  // a connection still being released finish instead of failing the write outright.
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  return db
}

// Plain statements on one fixed connection. A transaction body gets this, so a reopen
// can never move half a transaction onto a fresh connection.
function bound(db: SQLite.SQLiteDatabase): SqlDriver {
  const d: SqlDriver = {
    async exec(sql: string) { await db.execAsync(sql) },
    async all<T = SqlRow>(sql: string, params: SqlValue[] = []) {
      return db.getAllAsync<T>(sql, params)
    },
    async run(sql: string, params: SqlValue[] = []) { await db.runAsync(sql, params) },
    // Not reentrant — repo.ts serializes writes so two transactions never overlap.
    async tx(fn: (inner: SqlDriver) => Promise<void>) { await db.withTransactionAsync(() => fn(d)) },
    async close() { await db.closeAsync() },
  }
  return d
}

export async function openDriver(name: string): Promise<SqlDriver> {
  let conn = connect(name).then(bound)
  await conn

  // Run `op` on the live connection. On a dead handle, reopen (once, however many calls
  // hit it together) and replay `op` — a transaction replays whole, and every body in
  // repo.ts is upserts, so a replay is a no-op where the first attempt got through.
  async function live<T>(op: (d: SqlDriver) => Promise<T>): Promise<T> {
    const current = conn
    try {
      return await op(await current)
    } catch (e) {
      if (!isDeadHandle(e)) throw e
      if (conn === current) {
        log.warn('native database handle died — reopening:', e)
        conn = connect(name).then(bound)
      }
      return op(await conn)
    }
  }

  return {
    exec: (sql) => live((d) => d.exec(sql)),
    all<T = SqlRow>(sql: string, params?: SqlValue[]) { return live((d) => d.all<T>(sql, params)) },
    run: (sql, params) => live((d) => d.run(sql, params)),
    tx: (fn) => live((d) => d.tx(fn)),
    close: async () => (await conn).close(),
  }
}
