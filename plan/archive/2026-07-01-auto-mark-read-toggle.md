---
created: 2026-07-01
topic: Auto-mark-as-read toggle on the main feed
excerpt: Sticky server-persisted toggle (header eye icon) gating the feed's scroll-past auto-archive behavior.
status: done
---

# Auto-mark-as-read toggle

## Problem
Feed (`app/(drawer)/index.tsx`) already auto-archives highlights when you scroll
300px past them (server marks them read). This is always-on with no way to
disable. User wants a **sticky toggle** (header eye/checkmark icon, top-right)
persisted in user props so the auto-clear behavior can be turned off.

## Design
- **Setting key**: `auto_mark_read` in `server_settings` (global KV, single-user).
- **Default: `true`** — preserves current always-on behavior; toggle lets you
  turn it OFF. Mirror polling's `val != "false"` default-true idiom.

## Changes
1. **server** `internal/api/settings.go` — add `AutoMarkRead bool json:"auto_mark_read"`
   to `settingsPayload`; read/write key in `get`/`put`. No schema/query change
   (GetSetting/UpsertSetting already generic).
2. **app** `src/api.ts` — add `auto_mark_read: boolean` to `AppSettings`.
3. **app** `app/(drawer)/index.tsx` —
   - fetch settings on connect → `autoMarkRead` state.
   - header-right `IconButton` via `navigation.setOptions`: `eye` (accent, on) /
     `eye-off-outline` (muted, off). Optimistic toggle → `updateSettings`, revert on error.
   - gate the scroll-past archive block (lines ~313-321) on `autoMarkRead`.

## Test
- `just build` green.
- `just e2e` green (feed still loads).
- agent-browser: toggle icon flips, persists across reload; with toggle OFF,
  scrolling past cards does NOT archive.

## Done when
Toggle sticky across reloads, gates auto-archive, lint+build+e2e green.
