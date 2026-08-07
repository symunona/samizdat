---
created: 2026-08-07
topic: Make a failed offline-replica persist write loud (log + drawer dot + Settings row)
excerpt: The persisted zustand replica outgrew Android AsyncStorage's 6MB whole-DB cap. Every setItem threw SQLiteFullException, zustand never awaits the promise, so the offline snapshot silently froze for 6 days. This makes the failure impossible to miss — it never changes the storage layout.
status: done — branch feat/persist-failure-visibility, awaiting review
---

# Persist failure visibility

## The bug (already diagnosed — not re-litigated here)

`app/src/store/syncStore.ts` persists the whole replica through
`makeChunkedStorage(AsyncStorage)`. Chunking solves Android's **~2MB per-row
CursorWindow** limit. It does nothing for AsyncStorage's **6MB whole-DB** cap
(`@react-native-async-storage/async-storage/android/config.gradle` →
`getDatabaseSize()`, overridable via `AsyncStorage_db_size_in_MB`).

Past 6MB every `setItem` rejects with `SQLiteFullException: database or disk is
full`. zustand's `persist` calls `setItem()` on **every** `set()` and drops the
returned promise on the floor (`zustand/esm/middleware.mjs`: `set(...args);
return setItem()` — nobody awaits it), so the rejection is an unhandled promise
rejection: completely silent. The snapshot froze at 2026-08-01, hydration kept
handing back that stale snapshot, `lastSyncedAt` never advanced, and the phone
re-pulled an ever-growing delta (1.3MB) on every launch. Unnoticed for 6 days.
Replica is currently 7.76 MB.

## Scope

**Visibility only.** Explicitly NOT in this change:
- no storage-architecture change, no moving document bodies out of AsyncStorage
- no raising `AsyncStorage_db_size_in_MB`
- no eviction / cache trimming

Those are follow-ups the user decides on. This change only guarantees that the
next time it happens, it is loud within seconds.

## Design

### 1. Seam: the chunked adapter's `setItem`

`makeChunkedStorage(kv, onWrite?)` gains one optional observer:
`(err: unknown | null) => void`, invoked exactly once per persist attempt —
`null` on success, the error on failure. Reasons this beats the alternatives:

- **Not `onFinishHydration`** — that fires once, on read. The failure is on the
  *write* path and repeats on every `set()`; hydration is the symptom, not the
  event.
- **Not a wrapper `KVBackend` around AsyncStorage** — one logical persist is
  N+1 raw rows (chunks + manifest), so a wrapper would report N+1 mixed
  outcomes per `set()` and a mid-loop failure would look like "ok, ok, fail".
  The chunked adapter's `setItem` *is* the unit of "the snapshot was saved".
- The observer stays optional so `chunkedStorage.ts` remains pure and
  unit-testable with no zustand/RN imports (the reason `KVBackend` is injected
  at all).

The adapter **swallows** the error after reporting it. zustand is the only
caller and it already ignores the promise; re-throwing would just restore the
silent unhandled rejection we are removing.

`isStorageFullError(e)` lives next to it — a pure discriminator matching
Android's `SQLiteFullException` / `database or disk is full` and the browser's
`QuotaExceededError`. A non-matching error still raises the alert, just with
generic copy.

### 2. Report: `app/src/store/persistHealth.ts`

A tiny non-persisted zustand store (persisting the "persist is broken" flag
would be absurd) holding `failure: { full, message, firstAt, lastAt } | null`,
plus `reportPersistWrite(err | null)` — the function wired into the adapter.

- On the transition healthy → failed it emits `createLogger('persistHealth')
  .error(...)`, which the existing `logger.ts` sink forwards to `debugLog.ts`,
  which flushes **immediately** on `error` to `POST /api/v1/debug/logs` →
  `tmp/device-logs/<device>.ndjson`. Nothing new is built for the log channel.
- Repeat failures only update `lastAt` — one line per outage, not per `set()`.
- A successful write clears `failure` (recoverable), logging the recovery once.

### 3. Show: existing degraded affordance

- `useServiceAlert()` (`src/useServices.ts`) ORs in the persist failure → the
  red dot on the drawer hamburger **and** the drawer's Settings row, unchanged
  mechanism.
- Settings grows a **Device Storage** card in the existing **Services** group,
  rendered only while broken (same conditional-render precedent as Export
  Vault). Copy is plain: storage full, the offline copy is stale since <when>,
  local changes still sync, clear the local cache or free space.

### 4. Simulate: `src/offlineSim.ts`

The module already exists as the web-only failure simulator for e2e
(`samizdat_force_offline` → every fetch rejects). It gains a sibling:
`samizdat_force_storage_full` → `simulateFullStorage(kv)` makes every `setItem`
reject with Android's real message. Same shipped-in-prod, localStorage-keyed
pattern; nothing test-only leaks into a component.

## Tests

- `e2e/chunked-storage-unit.mjs` (`just e2e-offline`) — adapter-level: the
  observer reports success then failure, the rejection never escapes, and
  `isStorageFullError` tells a full disk from an ordinary write error.
- `e2e/integration.js` → `runPersistFailure` (`just e2e-int`) — the real
  interaction: boot the app with the sim key set, assert the **visible**
  Settings card + drawer dot, then clear the key, click *Clear local cache*
  (a real state write) and assert both go away. Also asserts the error landed
  in the server's device-log NDJSON, i.e. the whole logger → debugLog → server
  chain really fired.
  Runs **before** `runSettingsServices`, which permanently seeds a broken LLM
  provider and would otherwise keep the drawer dot lit for everyone after it.
