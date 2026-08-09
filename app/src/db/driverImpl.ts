// Native backend (Android/iOS) — expo-sqlite, the system SQLite. First-party for SDK 56,
// no size cap that matters, and a row write costs a row write instead of re-serializing
// the whole replica the way the AsyncStorage blob did.
//
// Metro resolves `driverImpl.web.ts` for web builds, so this file never reaches a browser
// and the browser's wa-sqlite never reaches a phone.

import * as SQLite from 'expo-sqlite'
import type { SqlDriver, SqlRow, SqlValue } from './driver'

export async function openDriver(name: string): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(name)
  // WAL keeps a reader (a list render) from blocking the sync writer.
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  const d: SqlDriver = {
    async exec(sql: string) { await db.execAsync(sql) },
    async all<T = SqlRow>(sql: string, params: SqlValue[] = []) {
      return db.getAllAsync<T>(sql, params)
    },
    async run(sql: string, params: SqlValue[] = []) { await db.runAsync(sql, params) },
    // Not reentrant — repo.ts serializes writes so two transactions never overlap.
    // Nothing is queued here, so the handle the body gets is simply this driver.
    async tx(fn: (inner: SqlDriver) => Promise<void>) { await db.withTransactionAsync(() => fn(d)) },
    async close() { await db.closeAsync() },
  }
  return d
}
