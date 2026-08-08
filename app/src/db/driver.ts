// The one shape every SQLite backend must present. Types only — this module is erased
// at compile time, so importing it can never drag a native module into a bundle that
// has no business with one.
//
// Three implementations exist, one per runtime; `driverImpl.ts` (native, expo-sqlite),
// `driverImpl.web.ts` (wa-sqlite) and `driverImpl.node.ts` (node:sqlite, tests only).
// Metro resolves the `.web` variant automatically, so nothing outside this folder ever
// names a backend.

export type SqlValue = string | number | null
export type SqlRow = Record<string, SqlValue>

export interface SqlDriver {
  // DDL / multi-statement script. No parameters, no result.
  exec(sql: string): Promise<void>
  // One SELECT.
  all<T = SqlRow>(sql: string, params?: SqlValue[]): Promise<T[]>
  // One INSERT/UPDATE/DELETE.
  run(sql: string, params?: SqlValue[]): Promise<void>
  // Runs `fn` inside a transaction, rolling back if it throws. Calls made from `fn`
  // land on the same connection — this is what makes "row + outbox intent + dirty key"
  // one atomic write.
  tx(fn: () => Promise<void>): Promise<void>
  close(): Promise<void>
}
