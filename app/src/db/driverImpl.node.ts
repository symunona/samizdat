// node:sqlite backend — TESTS ONLY (e2e/db-unit.mjs). Node 22 ships SQLite in core, so
// the whole DB layer runs headlessly with zero dependencies and no browser: the repo,
// the schema, the queries and the outbox durability are all exercised on the real
// engine. Never imported by the app; Metro would not resolve `node:sqlite` anyway.

import { DatabaseSync } from 'node:sqlite'
import type { SqlDriver, SqlRow, SqlValue } from './driver'

export async function openNodeDriver(path = ':memory:'): Promise<SqlDriver> {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  const d: SqlDriver = {
    async exec(sql: string) { db.exec(sql) },
    async all<T = SqlRow>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[]
    },
    async run(sql: string, params: SqlValue[] = []) {
      db.prepare(sql).run(...params)
    },
    async tx(fn: (inner: SqlDriver) => Promise<void>) {
      db.exec('BEGIN')
      try {
        await fn(d)
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async close() { db.close() },
  }
  return d
}
