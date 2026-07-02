---
created: 2026-07-02
topic: Server-synced video resume position + seek-anchor UX + instant transcript scroll
excerpt: Move video playback resume from local AsyncStorage to the server read_states mechanism (cross-device, like the doc viewer). Keep the seek-anchor behavior and document its UX rationale. Make transcript auto-follow scroll instant.
status: planning — not started
---

# Video resume sync + instant transcript scroll

## Motivation
User opens a video document on mobile and does not resume where they left off on
another device. Root cause: article scroll position is **server-synced** via
`read_states.scroll_y` + `/api/v1/documents/:id/progress`, but video playback
position is saved **only to device-local AsyncStorage** (`video_pos_<docId>`),
never to the server. So it never crosses devices.

Decision: reuse the document viewer's server-synced "where were we" mechanism for
video too. Keep the existing seek-anchor resume behavior and document *why* it
exists.

> OPEN QUESTION (asked, user away): server-sync vs keep-local. Plan assumes
> **server-sync** because the whole complaint was cross-device. If user wants
> local-only, drop Part A and keep only the comment + Part C.

---

## Part A — Server-synced video position (reuse read_states)

Add a playback-position column alongside `scroll_y`; one row per
`(device_id, document_id)` already exists. Note: read_states is per-device on the
server too, but it *is* fetched from the server on load — so a position written by
mobile is readable by mobile after a reinstall, and we can later relax the
per-device keying if we want true cross-device. (For genuine cross-device resume
we may want to read the most-recent row across devices for the doc — flag below.)

1. **Schema** `server/internal/store/schema.sql` (read_states, ~line 86):
   add `media_pos_ms INTEGER NOT NULL DEFAULT 0`.
2. **Migration** `server/internal/store/open.go` `migrate()` additive block:
   add `ALTER TABLE read_states ADD COLUMN media_pos_ms INTEGER NOT NULL DEFAULT 0`.
   (Follows existing additive-column pattern; no-op on fresh DBs.)
3. **Queries** `server/internal/store/queries.sql`:
   `UpsertReadState` + `GetReadState` include `media_pos_ms`. Regenerate sqlc
   (`just server::sqlc` or whatever the recipe is — verify).
4. **Handler** `server/internal/api/read_states.go`:
   - `get` returns `{"scroll_y": ..., "media_pos_ms": ...}`
   - `put` accepts optional `media_pos_ms`. IMPORTANT: `scroll_y` and
     `media_pos_ms` come from different callers (article vs video). Upsert must
     not clobber the other field with 0. Either COALESCE-preserve the untouched
     field, or make put patch-style (only overwrite provided fields).
5. **Client API** `app/src/api.ts`:
   - `fetchReadingProgress` returns `{ scroll_y, media_pos_ms }`.
   - add `media_pos_ms` to `saveReadingProgress` (or a sibling
     `saveMediaPosition`). Keep the debounced PUT.
6. **VideoDocument** `app/src/VideoDocument.tsx` (~lines 160-292):
   - Replace AsyncStorage `video_pos_<docId>` read (mount) and write
     (`savePosition`, throttle+pause+unmount) with the server fetch/save.
   - Keep `savedPosMs` state + one-shot `resumedRef` resume-seek (lines 276-281).
   - Keep the resume gate (`savedPosMs > 10000 && mediaDurMs > 0`) but verify the
     YouTube backend actually reports `mediaDurMs > 0` before the effect settles;
     if not, resume silently no-ops (existing latent bug). Consider retrying the
     resume once duration becomes known instead of a single mount effect.
   - `video_audio_<docId>` (offline audio URI) stays local AsyncStorage — it is a
     device-local file path, correctly not synced.

## Part B — Seek-anchor behavior + UX comment (KEEP the logic)

Rationale to persist as a comment above the save logic in `VideoDocument.tsx`:

```
// Resume anchor is deliberately "sticky" while the user is scrubbing.
// If the user keeps seeking around to find a specific part, we do NOT
// overwrite the saved resume point on every seek — we keep the ORIGINAL
// spot until they commit to a new one (i.e. play steadily past it). That
// way "hunting" for a moment never loses the place they were actually at.
```

Behavior to guarantee (audit current code, adjust if needed so it matches the
comment):
- A raw seek/scrub does NOT immediately persist a new resume position.
- The saved position only advances once playback has *settled* — e.g. played
  continuously for ~5s past a point without another seek (existing 5s throttle
  while playing may already approximate this; confirm a lone seek+pause doesn't
  commit the scrubbed spot).
- Final save on pause/unmount should persist the *settled* position, not a
  mid-scrub value.

## Part C — Instant transcript auto-follow scroll

Auto-follow uses DOM `scrollIntoView({ behavior: 'smooth' })` — the `'smooth'` is
what makes it animated. Make it instant.

- Edit `app/src/webview/document-viewer.ts`:
  - `~line 458` (auto-follow during playback): `behavior: 'smooth'` → `'auto'`.
  - `~line 845` (`scrollToActive` resume button): decide — instant too, or keep
    smooth for the explicit button? Default: make auto-follow instant; the manual
    button can stay smooth (it's a deliberate one-shot jump). Confirm with user.
- Regenerate the injected bundle via the esbuild recipe (`justfile:107-111`,
  `just <build-webview recipe>`). NEVER hand-edit `document-viewer-bundle.ts`.
- Leave the 2.5s `_lastUserScroll` suppression window as-is (unrelated; it stops
  playback yanking the view while the user reads elsewhere).

---

## Verification / E2E
- `just build` (server + go) green.
- Restart `just dev` (backend changed).
- `just e2e` green (document/video screens).
- Manual via `just robot-browser`: open a video doc, seek to ~2min, reload →
  resumes ~10s before. Then (server-sync) confirm the PUT hit the server (DB row
  `media_pos_ms` set) and a fresh device/session reads it back.
- Transcript: during playback the active line jumps instantly (no glide).
- Scrub around without settling → reload → still resumes at the *original*
  settled point, not the last scrub position.
- `just lint`.

## Rollout
- Commit plan to main first, then branch off (per CLAUDE.md), small commits,
  squash-merge back when user confirms.
- Run `diff_review` before merge to see if any CLAUDE.md needs the new
  read_states/media_pos_ms note.

## Open questions for user
1. Server-sync (assumed) vs keep local-only? (Part A gates on this.)
2. `scrollToActive` button: instant too, or keep smooth?
3. Cross-device: read_states is keyed per `(device_id, doc)`. True cross-device
   resume needs reading the latest row across devices for the doc — in scope now,
   or leave per-device (still fixes reinstall/same-device server-backed resume)?
