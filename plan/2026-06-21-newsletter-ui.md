---
created: 2026-06-21
topic: Newsletter in-app UI — add + show/copy address
excerpt: Surface newsletter feeds in the Subscriptions screen with their @sam.tmpx.space address + copy button, and an "Add Newsletter" flow. Fix the localhostOnly security hole on the create endpoint.
status: in progress
---

# Newsletter In-App UI

## Problem
After [[2026-06-09-newsletter-ingest]], a user has no way to see their newsletter
address in the app — it's only in the one-time POST response. Newsletter feeds
also never appear in the Subscriptions screen (the list is driven by subscription
rows; the create handler makes only a feed).

## Security fix (must-do)
`POST /api/v1/feeds/newsletter` is guarded by `localhostOnly`, which checks
`r.RemoteAddr`. Behind nginx every app request looks like 127.0.0.1, so the guard
is (a) unusable from the app and (b) effectively open to the public internet.
→ Switch to `bearerAuth(q, ...)` (device token), same as `POST /api/v1/subscriptions`.

## Backend
1. `router.go`: `/api/v1/feeds/newsletter` → `bearerAuth(q, nlH.create)`.
2. `newsletter.go` create handler: after upserting the feed, also insert a
   **paused** Subscription (interval_h irrelevant, paused=1 so the scheduler never
   polls a non-pollable email feed). Return `{feed, subscription, email}`.

## Frontend (`app/`)
3. `src/api.ts`: add `config?: string` to `Feed`; add
   `createNewsletter(serverUrl, token, title)` → POST /api/v1/feeds/newsletter.
4. `subscriptions.tsx`:
   - Add an "Add Newsletter" affordance (title input + button) alongside the URL
     subscribe row. On success, show the returned address in a toast/copyable line.
   - In `renderItem`, branch on `item.feed?.kind === 'newsletter'`: render the
     email address (parsed from `feed.config` JSON) + a **Copy** button, instead
     of domain/url + poll/stats. Keep Remove. Hide poll controls + paused switch.
   - Copy via `expo-clipboard` (check if already a dep; else navigator.clipboard on web).

## Testing
- `just e2e` green (add Subscriptions newsletter path if smoke covers it).
- agent-browser: open app → Add Newsletter → see address → copy → verify it lists.
- Backend: curl create with bearer token → confirm subscription row + feed + email.

## Out of scope
- Deleting the feed/token on Remove (currently Remove deletes the subscription;
  feed+token persist so mail still ingests). Note for later.
- Per-newsletter pipeline picker in UI (still DB/CLI for now).
