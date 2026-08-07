// Web-only simulators for the two device failures a browser cannot reproduce on its own:
// no network, and no room left to persist. Both are localStorage-keyed so a console or an
// e2e run can flip them on a warm, already-loaded app.
//
//   localStorage.setItem('samizdat_force_offline', '1')      // every fetch rejects
//   localStorage.setItem('samizdat_force_storage_full', '1') // every persist write rejects
//   localStorage.removeItem(…)                               // back to normal
//
// The offline half exists instead of page.setOfflineMode, which also blocks loading the
// server-hosted app bundle and so can't test a warm app going offline.
//
// No-op on native (no localStorage) — use airplane mode / a genuinely full device.

import type { KVBackend } from './store/chunkedStorage'

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

// Monkey-patch the global fetch once so EVERY caller (api.ts, the connection probe,
// the sync pull, the outbox pusher) sees the simulated outage — no per-call-site wiring.
export function installOfflineSim(): void {
  if (installed) return
  if (typeof localStorage === 'undefined' || typeof globalThis.fetch !== 'function') return
  installed = true
  const real = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (isForcedOffline()) {
      return Promise.reject(new TypeError('Failed to fetch (simulated offline)'))
    }
    return real(input, init)
  }) as typeof fetch
}

// Wrap a persist backend so writes reject the way a full Android AsyncStorage does
// (message copied from the real SQLiteFullException, which is what the app classifies on).
export function simulateFullStorage(kv: KVBackend): KVBackend {
  return {
    getItem: (k) => kv.getItem(k),
    setItem: (k, v) => flagged(FULL_KEY)
      ? Promise.reject(new Error('android.database.sqlite.SQLiteFullException: database or disk is full (code 13 SQLITE_FULL)'))
      : kv.setItem(k, v),
    removeItem: (k) => kv.removeItem(k),
  }
}
