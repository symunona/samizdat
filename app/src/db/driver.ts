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
  // Runs `fn` inside a transaction, rolling back if it throws. This is what makes
  // "row + outbox intent + dirty key" one atomic write.
  //
  // `fn` receives the IN-TRANSACTION handle and must issue every statement through it.
  // A backend may serialize its public methods (web does — one wasm connection), so a
  // tx body reaching for the outer driver would queue behind the transaction it is
  // itself holding. The handle is the same connection with that queue already claimed.
  tx(fn: (d: SqlDriver) => Promise<void>): Promise<void>
  close(): Promise<void>
}
