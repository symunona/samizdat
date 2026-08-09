// Web-only simulators for the two device failures a browser cannot reproduce on its own:
// no network, and no room left to persist. Both are localStorage-keyed so a console or an
// e2e run can flip them on a warm, already-loaded app.
//
//   localStorage.setItem('samizdat_force_offline', '1')      // every fetch rejects
//   localStorage.setItem('samizdat_force_storage_full', '1') // every SQL write rejects
//   localStorage.removeItem(…)                               // back to normal
//
// The offline half exists instead of page.setOfflineMode, which also blocks loading the
// server-hosted app bundle and so can't test a warm app going offline.
//
// No-op on native (no localStorage) — use airplane mode / a genuinely full device.

import type { SqlDriver, SqlRow, SqlValue } from './db/driver'

const KEY = 'samizdat_force_offline'
const FULL_KEY = 'samizdat_force_storage_full'
let installed = false

function flagged(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function isForcedOffline(): boolean {
  return flagged(KEY)
}

// The SQLite wasm binary is part of the RUNTIME, not the server: on native it is a
// linked library and on web the browser serves it from cache, so an outage never takes
// it away. Cutting it would simulate "the app doesn't exist" rather than "the server is
// unreachable" — and the whole point of an offline test is that the local replica still
// answers. Everything else on the origin is API traffic and stays cut.
const RUNTIME_ASSET = /\/wasm\//

// Monkey-patch the global fetch once so EVERY caller (api.ts, the connection probe,
// the sync pull, the outbox pusher) sees the simulated outage — no per-call-site wiring.
export function installOfflineSim(): void {
  if (installed) return
  if (typeof localStorage === 'undefined' || typeof globalThis.fetch !== 'function') return
  installed = true
  const real = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (isForcedOffline() && !RUNTIME_ASSET.test(url)) {
      return Promise.reject(new TypeError('Failed to fetch (simulated offline)'))
    }
    return real(input, init)
  }) as typeof fetch
}

// Wrap the SQL driver so every WRITE rejects the way a device with no room left does —
// SQLITE_FULL is literally what SQLite raises then, and it is what persistHealth
// classifies on. Reads keep working, which is the real shape of the failure: the app
// goes on showing an ever-staler replica while nothing new can be saved.
//
// `run` and `tx` are gated, `exec` is not: opening and migrating the schema must still
// succeed so a reload with the flag already set lands in the broken-write state rather
// than in a no-database state.
export function simulateFailedWrites(driver: SqlDriver): SqlDriver {
  const full = () => Promise.reject(
    new Error('SQLITE_FULL: database or disk is full (simulated full device)'))
  return {
    exec: (sql: string) => driver.exec(sql),
    all<T = SqlRow>(sql: string, params?: SqlValue[]): Promise<T[]> {
      return driver.all<T>(sql, params)
    },
    run: (sql: string, params?: SqlValue[]) => (flagged(FULL_KEY) ? full() : driver.run(sql, params)),
    tx: (fn: (d: SqlDriver) => Promise<void>) => (flagged(FULL_KEY) ? full() : driver.tx(fn)),
    close: () => driver.close(),
  }
}
