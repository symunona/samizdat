// Web-only offline simulator. Set localStorage['samizdat_force_offline']='1' and every
// network fetch rejects as if the device were offline — so we can exercise the offline
// UX (cached feed/doc reads, outbox queueing, sync-on-reconnect) in a browser and in
// e2e WITHOUT page.setOfflineMode, which also blocks loading the server-hosted app
// bundle and so can't test a warm, already-loaded app going offline.
//
// Toggle from the console (or e2e):
//   localStorage.setItem('samizdat_force_offline', '1')  // go offline
//   localStorage.removeItem('samizdat_force_offline')     // back online
//
// No-op on native (no localStorage) — use airplane mode on a device.

const KEY = 'samizdat_force_offline'
let installed = false

export function isForcedOffline(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
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
