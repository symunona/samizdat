import { fetchSync } from '../api'
import * as db from '../db'

const DEBOUNCE_MS = 5_000

let syncInProgress = false
let lastSyncAt = 0

async function doSync(serverUrl: string, token: string): Promise<void> {
  if (syncInProgress) return
  syncInProgress = true
  lastSyncAt = Date.now()

  // The cursor is read from the DB, never from a cached copy: it advances in the SAME
  // transaction that writes the delta, so a failed write leaves it where it was and the
  // next pull re-requests exactly what was lost.
  const since = (await db.getCursor()) ?? '1970-01-01T00:00:00Z'
  db.setSyncStatus('syncing')

  try {
    const payload = await fetchSync(serverUrl, token, since)
    // Rethrows if the local write failed — the delta was fetched but not stored, which
    // is a sync error, not a silent success. Retry is this engine's job.
    await db.applySync(payload)
  } catch (e) {
    db.setSyncStatus('error', e instanceof Error ? e.message : 'sync failed')
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
