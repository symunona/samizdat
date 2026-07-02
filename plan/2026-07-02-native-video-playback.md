---
created: 2026-07-02
topic: Native video playback (NewPipe-style) — replace YouTube IFrame embed
excerpt: Play video Documents from a server-served stream via a native player instead of the YouTube IFrame embed, eliminating error 152 / ads / embed fragility. Mirror the existing yt-dlp audio pipeline.
status: planned
---

# Native video playback — kill the YouTube embed (and error 152)

## Why
The in-app video player uses the YouTube **IFrame embed** (WebView). On ad-blocked
networks YouTube hard-fails the embed with **error 152** (can't load its ad-status
script) → black box. NewPipe's lesson: **never embed — extract streams and play them
natively.** We already do exactly this for AUDIO (yt-dlp downloads it, server serves
`/documents/{id}/audio` with range support, `useAudio` plays it). Do the same for
VIDEO. Result: no embed, no ads, no doubleclick, no 152, works offline.

The heavy extraction hacks (client spoofing, sig/nsig descramble, poToken) are already
handled by **yt-dlp** (through the fiona residential proxy). We only need to fetch a
video stream and play it natively.

## Non-negotiable constraints
- **Serve THROUGH the server — never hand raw googlevideo URLs to the phone.**
  googlevideo URLs are egress-IP-bound + expire (~6h); a server-extracted URL played
  from the phone's IP is rejected. Download to the server (like audio), serve locally.
- **Keep yt-dlp + the fiona proxy** in the extraction path (VPS IP is bot-blocked).
- **Storage-aware (4GB VPS):** cap resolution (≤480p default) and fetch **on-demand**,
  not at ingest — most video Docs are never watched.
- Reuse the audio pattern; do not invent new abstractions where the `AudioControl` /
  `YtPlayerHandle` / `YtStatus` contracts already fit.

## Design

### Server (Go)
1. **`fetch_video` job kind** (`server/internal/worker/`). Refactor the yt-dlp download
   in `youtube.go` so the video fetch can run for an already-ingested Document by
   canonical URL. Format (tunable): prefer muxed mp4 ≤720p, fall back to merge ≤480p:
   `-f "best[ext=mp4][vcodec!=none][acodec!=none][height<=720]/bv*[height<=480]+ba/best[height<=480]"`
   `--merge-output-format mp4`. Store as a `media_assets` row with **`kind="video"`**
   (kind is free-text; no schema change — verify). Route through the configured proxy.
   Set `ParentJobID` per the job-enqueueing rules.
2. **Trigger endpoint:** `POST /api/v1/documents/{id}/queue-video` (bearer) — enqueues
   `fetch_video` if no video asset exists yet (idempotent; mirror `queue-pipelines`).
3. **Serve endpoint:** `GET /api/v1/documents/{id}/video` — mirror
   `mediaHandler.serveDocAudio` exactly (`GetMediaAssetByDocumentAndKind` kind="video",
   `http.ServeFile` for range/seek). 404 when not fetched yet. Content-type `video/mp4`.
4. Register both routes in `router.go`.

### App (Expo / RN + Web)
1. **`ServerVideoPlayer`** component implementing the **existing `YtPlayerHandle` +
   `YtStatus` contract** (so `useMediaTimeline` is unchanged — it already abstracts the
   video backend behind a ref + status callback). Use **`expo-video`** (`useVideoPlayer`
   + `VideoView`); expo-video supports web too — if its web path is flaky, add a
   `.web.tsx` HTML5 `<video>` split like `useAudio`. Source = `${activeUrl}/api/v1/documents/{id}/video`
   with the bearer token (header or query as the media endpoints already expect).
   Must add `expo-video` dep + any config-plugin entry in `app.json`; `expo prebuild`
   picks it up on the next `just build-android`.
2. **`VideoDocument.tsx` selection logic:**
   - On open, probe `GET /video`. If a video asset exists → render `ServerVideoPlayer`
     into the timeline's video slot (native stream, no embed).
   - If 404 → auto-`POST queue-video` once, show "Preparing video…", poll `/video`
     until ready, then play. (Cheap: HEAD/GET; reuse React Query.)
   - **Fallback:** if fetch fails or yt-dlp unavailable → fall back to the existing
     `YtPlayer` embed. Fold in graceful embed-error handling: add **152 & 153** to
     `embedDisabled` (currently only 101/150 at `VideoDocument.tsx:541`) and soften the
     copy ("can't play embedded here — Open in YouTube / Audio only").
3. `useMediaTimeline` stays as-is structurally: `videoActive` now = `showVideo &&
   (hasServerVideo || ytId)`; the ref it drives is whichever component is mounted. Both
   `ServerVideoPlayer` and `YtPlayer` satisfy `YtPlayerHandle`/`YtStatus`, so the
   seeker/transcript/rate/handoff code is untouched.

## E2E / self-test (author BEFORE building)
- **Server (smoke):** extend `e2e/smoke.js` `seedVideoDoc` to also drop a placeholder
  `video`-kind media asset + file; assert `GET /api/v1/documents/<id>/video` → 200 and
  honors a `Range` request (206). `POST queue-video` when asset exists → no-op 2xx.
- **App (smoke):** video document page renders the native `<video>` (web path) with no
  JS errors; add to `PAGES` coverage already there.
- **Gates:** `just build` (go+cli) green · `just lint` (eslint/knip/vet/parity) green ·
  `just e2e` green. Restart `just dev` after backend changes (`just status` → FRESH).
- **Real device (deferred to user):** via the debug-log channel — open the Johnny
  Harris doc (id 4S25FfbFw4M), let video fetch, confirm **native playback + no 152**.
  `just device-logs` should show status frames, no `yt iframe error`.

## Validation boundary (be honest)
Web path is fully `just e2e`-tested. The **native (expo-video device) path** is
implemented + typechecked + build-green, but device-verified by the user afterward via
the debug channel — same boundary as the debug-channel feature. Note this in the final
report; do NOT claim device playback works without a device run.

## Out of scope (follow-ups)
- Ingest-time pre-fetch / resolution picker / storage GC of fetched videos.
- Adaptive/DASH multi-resolution streaming (start with a single capped mp4).

## Steps
1. [server] refactor youtube.go video-fetch fn + `fetch_video` job + worker handler.
2. [server] `queue-video` + `/video` endpoints + router wiring; `sqlc generate` if queries change.
3. [server] `just build-server`, restart `just dev`, curl the endpoints; `just status` FRESH.
4. [app] add expo-video; `ServerVideoPlayer` (+ .web if needed); wire into VideoDocument; 152/153 fallback.
5. [test] extend smoke; `just build` + `just lint` + `just e2e` green.
6. [commit] small commits on the branch; final report + ask user to device-verify.
</content>
