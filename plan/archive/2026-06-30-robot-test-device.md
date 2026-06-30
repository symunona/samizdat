---
created: 2026-06-30
topic: Single reusable robot test device
excerpt: Stop dev DB device spam — one idempotent robot-automated-ui-tester row, reused by all UI tests.
status: done
---

# Robot test device — stop dev DB device spam

## Problem
`/api/v1/pair` mints a fresh UUID `devices` row on every call; zero dedup.
Dev DB (`~/.samizdat/app.db`) accumulated **38 live devices**:
- 13× `Chrome on Linux` — agent-browser web runs vs dev server with no persisted
  localStorage state → `app/app/connect.tsx` re-pairs each run.
- `Chrome @ <host>` ×9 — same leak, host-suffixed names.
- ad-hoc curl tests (`test-curl`, `verify-pubdate`, `integ`, `fork`, …) — one row each.

`just e2e` is NOT a culprit: it uses throwaway `/tmp/samizdat-test/app.db`.

## Fix (enforce single row server-side)
1. **Endpoint** `POST /api/v1/admin/test-device` (localhostOnly): look up live device
   named `robot-automated-ui-tester`; if found, **rotate token on the same row** (UPDATE
   token_hash + bump rev/updated_at) and return it; else create once. Idempotent →
   exactly one row no matter how many times called.
2. **Queries** (sqlc): `GetDeviceByName`, `UpdateDeviceToken`.
3. **Recipe** `just test-device`: curl the endpoint, cache token JSON to
   `tmp/sessions/robot-ui-tester.json` for agent-browser/e2e reuse.
4. **Cleanup**: soft-delete the 35 stale test rows (keep `pandora`, `Pandora 65`,
   `main chrome profile pandora`).

## Test
- `just build` green.
- Call endpoint 3× → assert still exactly one live row named `robot-automated-ui-tester`,
  token changes each call, old token invalid.
- `just e2e` green.

## Done when
Endpoint + recipe shipped, stale rows purged, single robot row reused.
