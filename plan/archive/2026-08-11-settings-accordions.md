---
created: 2026-08-11
topic: Settings screen — version on top, accordions, auto-archive flag
excerpt: Reorder Settings so the app version/APK leads, collapse the long status cards (Server Connection, Connected Devices, LLM Services) behind a reusable accordion, and add a server-side "auto-archive older than 1 month" preference.
status: done — squash-merged to main 2026-08-13
---

# Settings: version on top · accordions · auto-archive

Settings has grown into one long scroll where the thing checked most (which build am I
on / where's the APK) sits at the bottom and three rarely-read status blocks sit at the
top. Fix the order, collapse the blocks, and add the one missing preference.

## 1. App version + APK to the top

`App Version` card (installed version, tap-to-check, update banner, APK download) moves
from the `Device` group to the very top of the screen, above `Server Connection`. It
stays one card; only its position changes.

## 2. Auto-archive flag (server-side)

New preference: **Auto-archive older than 1 month** — a boolean, off by default.
When on, the worker archives Highlights whose `created_at` is older than one month.

- `server_settings.auto_archive_enabled` (`"true"`/`"false"`), served + patched by
  `GET/PUT /api/v1/settings` alongside `polling_enabled` (same partial-patch shape).
- `ArchiveOldHighlights` (queries.sql): sets `archived_at`/`updated_at`, `rev = rev + 1`
  for non-deleted, non-archived, **non-pinned** Highlights older than the cutoff. Pinned
  is an explicit keep — a sweep must never undo the user's triage.
- Worker: `sweepAutoArchive` on the existing 60s scheduler tick (next to
  `schedulePollFeeds`), no-op while the flag is off, logs only when it archived something.
- `rev + 1` per row means the phone pulls the change through the normal sync feed.

## 3–5. Accordions

New `app/src/Accordion.tsx` — a card whose header is a Pressable: title, optional
subtitle, a collapsed one-line summary, chevron, and an optional right accessory shown
only while open (so the Test/Refresh/Probe buttons can't be tapped blind). Default
collapsed, open state is screen-local.

Applied to:
- **Server Connection** — summary: status dot + `Connected` / `Offline` + host.
- **Connected Devices** — summary: `N devices`.
- **LLM Services** — summary: the routing chain's troubled provider if there is one
  (error label, in the error colour), else the primary. Inside, the provider list is
  **sorted troubled-first** so the same row leads when expanded.

## Test plan (e2e, agent-browser)

- `just e2e` — smoke must stay green (Settings still renders every page).
- `just e2e-int` `runSettingsServices` — reads LLM provider text, so it must expand the
  LLM accordion first; add checks that (a) it starts collapsed, (b) the collapsed
  summary names the failing provider once one is seeded.
- Interaction (agent-browser): toggle each accordion, flip the auto-archive switch and
  re-load Settings to prove it round-trips through the server.
- Server: flag off = no rows touched; flag on = an old unpinned Highlight gets
  `archived_at`, a pinned one does not.
