---
created: 2026-07-08
topic: Offline-first sync for user-authored mutations (local-first + background push)
excerpt: Make tag/star/annotate/read-state work with no network; write to local store, push lazily when online. Per-object sync direction, note-conflict git-diff merge, mocked storage unit tests, and a full offline e2e harness.
status: PHASE 1 DONE — local-first writes shipped (outbox + pusher + dirty-aware merge; all tag/star/archive/annotate/read-state mutations offline-capable). Tests green: e2e/outbox-unit.mjs (27) + e2e/offline.js (11, offline→reconnect→server-synced) + smoke + integration. Phases 2 (note conflict-merge) and 3 (full scraper/LLM e2e harness) not started; seams left — base_rev tracked per dirty row, server creates honor client id. DESIGN NOTE: server create endpoints now accept an optional client-minted `id` (idempotent) — within the locked "client-minted UUID PK" rule, not a new route.
---

# Offline-first sync

## Problem
Today tag / star (pin) / annotate / archive call the REST API inline, so they fail offline
and the UI blocks on the network. Pull-sync already brings server rows down and persists
them (`syncStore` → AsyncStorage), but there is no local-first WRITE path and no push.

## Principle
Every user mutation: (1) update the local store immediately (UI reacts), (2) enqueue an
outbox intent, (3) a background pusher drains it to the server when online. Server stays
authoritative (assigns `rev`); the client tracks per-row `base_rev` to detect conflicts.

## Per-object sync direction (the core decision)
| Object | Content | User attrs |
|---|---|---|
| **Document** (machine) | server→phone ONE-WAY | tags, read-state, archive/star → TWO-WAY (LWW) |
| **Highlight** (machine) | server→phone ONE-WAY | `pinned`, `archived_at`, tags → TWO-WAY (LWW) |
| **Annotation** (user) | — | TWO-WAY (LWW); note body = conflict-merge (below) |
| **Tag** + `document_tags`/`annotation_tags`/`highlight_tags` | — | TWO-WAY (LWW) |
| **read_states** (read/scroll) | — | TWO-WAY (LWW) |

Machine CONTENT (document markdown, highlight body) is never pushed. Only user-authored
rows/fields are two-way. This makes "who modified it" obvious: dirty flag set locally ⇒
phone edited it; higher server `rev` on a clean row ⇒ server edited it.

## Write path (Phase 1 — the user's core ask)
- Add an **outbox** to the store: ordered list of intents `{id, kind, args, base_rev, tries}`,
  persisted. UUID PKs (client-minted) ⇒ no insert collisions on replay.
- Each action reducer: optimistic store update + enqueue intent + mark row `dirty`.
- **Pusher**: drain outbox by REPLAYING the existing REST endpoints (addDocumentTag,
  pinHighlight, archiveHighlight, createAnnotation, …) — they already exist; the outbox just
  moves them off the UI thread and makes them survive offline. On success: clear dirty, store
  server `rev`→`base_rev`. Retry w/ backoff; trigger on mutation (debounced), reconnect, interval.
- **Pull-merge** must not clobber dirty rows: dirty local wins until pushed; note bodies use
  the conflict-merge below.

## Conflict handling
Best-effort, mostly single-writer ⇒ LWW by `updated_at`/`rev` for all fields EXCEPT the
**Annotation note body**, the one place data loss matters. When pushing a note whose server
`rev` > the client's `base_rev` (both sides edited since last sync), do NOT drop either —
write a git-style conflict marker into the note text, labeled by device + time, and let the
user resolve by editing (stays in the vault = source of truth):
```
<<<<<<< this-device (2026-07-08T09:00Z)
local edit
=======
other-device (2026-07-08T08:55Z)
server edit
>>>>>>>
```

## Server touch-ups
Reuse existing REST endpoints for push. For note LWW/conflict, endpoints that mutate
annotations must accept a client `updated_at` + `base_rev` and return the new `rev` instead of
always stamping server time. Audit which endpoints need this (likely just annotations).

## Tests
- **Storage unit tests (mocked, no network):** outbox reducer — mutation ⇒ store+outbox;
  push-success ⇒ outbox cleared + rev set; pull on clean row ⇒ applied; pull on dirty row ⇒
  dirty preserved; note double-edit ⇒ conflict marker produced. Pure functions, mocked transport.
- **E2E harness (extend e2e/harness.js):**
  - Seed sample DB (docs + highlights + annotations + tags).
  - **Stubbed scraper:** dummy article served from localhost; scraper ingests it (no real net).
  - **Mock LLM:** key→canned-result store injected via the LLM adapter, deterministic.
  - **Emulate time on scraping** (controlled timestamps; respect the no-Date constraint).
  - **Seed + email ingest mocking:** POST /api/v1/inbound/email path exercised offline.
  - **UI-state tests:** manual add-document → scrape-queue states visible.
  - **Offline walkthrough:** load online → `page.setOfflineMode(true)` → star/delete/annotate →
    assert local UI + persistence → reconnect → assert the server DB actually synced (read the
    row back via API and diff).

## Phasing (each phase its own tested subagent, sequential)
1. **Local-first writes** — outbox + pusher + dirty-aware pull-merge for tag/star/annotate/
   read-state/archive. Delivers "no network required, syncs when online." + storage unit tests.
2. **Note conflict merge** — base_rev tracking + git-diff markers + server endpoint tweak.
3. **E2E harness** — stubbed scraper, mock LLM, ingest mocks, offline walkthrough tests.

## Open questions for the human
- Highlight `pinned`/`archived_at`: keep as two-way fields on the highlight row (simplest) vs.
  move to read_states? Proposing: keep on the row, treat those two columns as user-authored LWW.
- Do we ever expect true multi-device concurrent editing today (single-user)? If effectively
  single-writer, Phase 2 conflict merge is low-urgency and Phase 1 covers 95% of the value.
