import { create } from 'zustand'
import { createLogger } from '../logger'
import { isStorageFullError } from './chunkedStorage'

// Health of the OFFLINE REPLICA'S WRITE PATH (see plan/2026-08-07-persist-failure-visibility.md).
//
// zustand's persist fires setItem() on every set() and never awaits it, so a device
// whose storage filled up dropped every snapshot in total silence — the replica froze
// for six days while the app looked fine. chunkedStorage reports each write attempt
// here; this store turns that into the two channels we already have: an error-level log
// (logger → debugLog → tmp/device-logs/<device>.ndjson) and the degraded dot +
// Settings row (useServiceAlert).
//
// Deliberately NOT persisted: writing "writes are failing" through the failing writer
// is pointless, and a fresh session re-derives the state from its first write anyway.

const log = createLogger('persistHealth')

export interface PersistFailure {
  // True when the backend said it is out of space, as opposed to any other write error.
  full: boolean
  message: string
  firstAt: string // when this outage started — how stale the offline copy is
  lastAt: string
}

interface PersistHealthState {
  failure: PersistFailure | null
  // The observer handed to makeChunkedStorage: null = the snapshot was saved.
  reportWrite: (err: unknown | null) => void
}

export const usePersistHealth = create<PersistHealthState>((set, get) => ({
  failure: null,
  reportWrite: (err: unknown | null) => {
    const prev = get().failure
    const at = new Date().toISOString()
    if (!err) {
      if (!prev) return
      set({ failure: null })
      log.log(`offline replica is saving again (was failing since ${prev.firstAt})`)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    // One line per outage, not per set() — a full device fails on every keystroke.
    if (prev) {
      set({ failure: { ...prev, message, lastAt: at } })
      return
    }
    const full = isStorageFullError(err)
    set({ failure: { full, message, firstAt: at, lastAt: at } })
    log.error(
      full
        ? `device storage is FULL — the offline replica can no longer be saved and is frozen as of ${at}: ${message}`
        : `offline replica write failed — the persisted snapshot is frozen as of ${at}: ${message}`,
    )
  },
}))

// Module-level entry point for the storage adapter, which is built once at import time
// (outside React) and must not hold a hook reference.
export function reportPersistWrite(err: unknown | null): void {
  usePersistHealth.getState().reportWrite(err)
}
