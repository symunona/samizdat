import { fetchSync } from '../api'
import { useSyncStore } from './syncStore'

const DEBOUNCE_MS = 5_000

let syncInProgress = false
let lastSyncAt = 0

async function doSync(serverUrl: string, token: string): Promise<void> {
  if (syncInProgress) return
  syncInProgress = true
  lastSyncAt = Date.now()

  const store = useSyncStore.getState()
  const since = store.lastSyncedAt ?? '1970-01-01T00:00:00Z'
  store.setSyncStatus('syncing')

  try {
    const payload = await fetchSync(serverUrl, token, since)
    useSyncStore.getState().applySync(payload)
  } catch (e) {
    useSyncStore.getState().setSyncStatus('error', e instanceof Error ? e.message : 'sync failed')
    throw e
  } finally {
    syncInProgress = false
  }
}

/** Debounced — skips if a sync ran within the last 5s. Use for auto-triggers. */
export function requestSync(serverUrl: string, token: string): void {
  if (syncInProgress) return
  if (Date.now() - lastSyncAt < DEBOUNCE_MS) return
  doSync(serverUrl, token).catch(() => {})
}

/** Bypasses debounce — use for pull-to-refresh. */
export async function forceSync(serverUrl: string, token: string): Promise<void> {
  if (syncInProgress) return
  return doSync(serverUrl, token)
}
