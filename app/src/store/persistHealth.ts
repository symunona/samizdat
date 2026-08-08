import { create } from 'zustand'
import { createLogger } from '../logger'

// Health of the LOCAL DATABASE'S WRITE PATH (see plan/2026-08-07-persist-failure-visibility.md).
//
// The blob-replica era failed silently: zustand's persist fired setItem() on every
// set() and never awaited it, so a device whose storage filled up dropped every
// snapshot without a word — the replica froze for six days while the app looked fine.
// Every write in src/db/repo.ts now reports its outcome here, and this store turns that
// into the two channels we already have: an error-level log (logger → debugLog →
// tmp/device-logs/<device>.ndjson) and the degraded dot + Settings row (useServiceAlert).
//
// Deliberately NOT persisted: writing "writes are failing" through the failing writer
// is pointless, and a fresh session re-derives the state from its first write anyway.

const log = createLogger('persistHealth')

// Separates "the device is out of space" — the case worth naming to the user, and the
// one they can act on — from any other write error. It only picks the wording; every
// failure raises the alert either way.
export function isStorageFullError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e)
  return /SQLiteFull|disk is full|QuotaExceeded|quota/i.test(msg)
}

export interface PersistFailure {
  // True when the backend said it is out of space, as opposed to any other write error.
  full: boolean
  message: string
  firstAt: string // when this outage started — how stale the offline copy is
  lastAt: string
}

interface PersistHealthState {
  failure: PersistFailure | null
  // The observer the DB layer calls after every write: null = it landed.
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
      log.log(`the local database is saving again (was failing since ${prev.firstAt})`)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    // One line per outage, not per write — a full device fails on every keystroke.
    if (prev) {
      set({ failure: { ...prev, message, lastAt: at } })
      return
    }
    const full = isStorageFullError(err)
    set({ failure: { full, message, firstAt: at, lastAt: at } })
    log.error(
      full
        ? `device storage is FULL — the offline replica can no longer be saved and is frozen as of ${at}: ${message}`
        : `local database write failed — the offline replica is frozen as of ${at}: ${message}`,
    )
  },
}))

// Module-level entry point for the DB layer, which runs outside React and must not
// hold a hook reference.
export function reportPersistWrite(err: unknown | null): void {
  usePersistHealth.getState().reportWrite(err)
}
