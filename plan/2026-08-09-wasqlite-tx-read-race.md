---
created: 2026-08-09
topic: Web replica crashes — wa-sqlite wasm "memory access out of bounds"
excerpt: Reads bypass the web driver's serialization queue while a transaction is open, so a SELECT interleaves with the transaction's own statements on one Asyncify stack and corrupts the wasm heap.
status: done
---

# wa-sqlite crash: a read interleaving a transaction

## Symptom (web only)

```
Aborted(RuntimeError: unreachable)
wa-sqlite-async.wasm: Uncaught (in promise) RuntimeError: memory access out of bounds
  ... _e.setSetting  <- prefs.saveUrlLastUsed  (ConnectionContext 30s probe)
  ... _e.listOutbox  <- pushEngine.requestPush (useOutboxPush interval)
```

Two *different* call chains are unwinding through `doRewind` at the same time. That is
the tell: Asyncify has ONE unwind buffer per module, so two overlapping `sqlite3.step()`
chains scribble over each other's saved stack.

## Cause

`app/src/db/driverImpl.web.ts` serializes driver calls on a promise chain, but exempts
everything while a transaction is open:

```ts
function serialize<T>(fn) {
  if (inTransaction) return fn()   // <- runs IMMEDIATELY, concurrent with the tx
  ...
}
```

The exemption exists so the tx *body*'s own `d.run(...)` calls don't deadlock on the
queue they are holding. But `inTransaction` is a module-global boolean — it cannot tell
an inner call from an unrelated one. So while any write transaction is in flight, EVERY
other caller (notably `read()` → `driver.all` — `listOutbox`, `getSetting`, `getDocument`)
skips the queue and runs concurrently.

`repo.ts` serializes *writes*, so this never showed up as "transaction within a
transaction"; only reads hit it, and only on web (native expo-sqlite and node:sqlite have
no Asyncify stack to corrupt). Two intervals — the 30s connection probe writing
`url_last_used` and the outbox pusher reading the outbox — make the collision routine.

## Fix

Make the in-transaction handle a *different object* instead of a global flag: `tx` hands
the body an unqueued driver, and the public driver's methods always queue.

- `db/driver.ts` — `tx(fn: (d: SqlDriver) => Promise<void>)`.
- `db/driverImpl.web.ts` — `raw` (unqueued, given to the tx body) + the returned facade
  (every method through `serialize`). No `inTransaction` flag left.
- `db/driverImpl.ts`, `db/driverImpl.node.ts`, `src/offlineSim.ts` — signature only.
- `db/repo.ts` — `d.tx(() => body(d))` → `d.tx(body)`.

## Test

- `just e2e-db` — the whole layer on node:sqlite.
- New `runWebTxReadRace` in `e2e/integration.js`: in the browser, fire a burst of
  interleaved `db.setSetting` writes and `db.listOutbox`/`getSetting` reads, assert no
  wasm abort and correct values. This reproduces on the old code and passes on the new.
- `just e2e`, `just lint`, `just build`.
