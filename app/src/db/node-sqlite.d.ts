// Minimal ambient types for node 22's built-in SQLite, used by the test-only driver
// (driverImpl.node.ts). Declared here rather than pulling in @types/node: that package
// redefines timers/globals for the whole app and would change what `setTimeout` returns
// in every React Native file.
declare module 'node:sqlite' {
  export class StatementSync {
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): { changes: number; lastInsertRowid: number }
  }
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
