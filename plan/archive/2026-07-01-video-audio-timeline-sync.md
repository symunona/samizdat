---
create: 2026-07-01
topic: Unify the video + bottom-audio player onto ONE playback timeline
excerpt: Replace the "video pauses audio, never simultaneous" rule with a single active-media-backend abstraction so the YouTube video is just an alternate VIEW of the same timeline — bottom bar, seeker, rate and transcript auto-scroll all track whichever backend is playing.
status: implementing
---

# Video ⇄ audio shared timeline

## Problem
Today the bottom seeker + transcript are driven by `useAudio`. The YouTube video is a
plain `src` iframe that can't be observed/controlled. Design rule forced them to be
mutually exclusive: opening the video paused the audio → `positionMs` froze → seeker
stopped, transcript stopped auto-scrolling. That is the reported bug.

## Desired
Video = alternate view of the same playback. Bottom bar keeps counting while the video
plays; scrub/rate sync both ways; transcript keeps scrolling; a button collapses back to
audio-only continuing from the same position. No double audio.

## Abstraction — one "active media backend"
New hook `src/useMediaTimeline.ts` (platform-agnostic) merges TWO backends behind the
existing `AudioControl` shape (`{playing, positionMs, durationMs, rate, play, pause, seek, setRate}`):
- **audio backend** = the existing `useAudio(url)` (platform-split, unchanged) — used for
  audio-only mode and offline local files.
- **youtube backend** = a new platform-split component `YtPlayer` driven imperatively
  (ref handle) + reporting progress via `onStatus`. The hook owns the ref + status state.

`videoActive = showVideo && !!ytId`. The hook returns the active backend's fields, so the
seeker/transcript/rate code is **written once** and never branches on which is playing.

Handoff effect (in the hook, keyed on `videoActive`):
- entering video → pause the `<audio>` element (YT provides the sound → no double audio).
- leaving video → seek audio to YT's last position + resume if it was playing.

Rate is lifted into the timeline hook; `setRate` fans out to BOTH backends so speed stays
synced. Lever/± buttons are untouched — they just call `tl.setRate`.

## YouTube IFrame API wiring
Plain iframe → YT IFrame Player API so we can read `getCurrentTime`/`getDuration` and call
`playVideo`/`pauseVideo`/`seekTo`/`setPlaybackRate`.
- **web** (`YtPlayer.web.tsx`): inject `https://www.youtube.com/iframe_api`, `new YT.Player`
  into a host div, `onStateChange` + a 250ms poll → `onStatus`.
- **native** (`YtPlayer.tsx`): a `WebView` loading an HTML page that embeds the same IFrame
  API; posts `status` via `ReactNativeWebView.postMessage`, receives commands via
  `injectJavaScript(window.__cmd(...))`.
- Shared types in `YtPlayer.types.ts` (`YtPlayerHandle`, `YtStatus`).

Transcript plumbing is UNCHANGED — it already follows the `mediaTime` message driven by
`positionMs`; because `positionMs` now advances from YT while the video plays, the
transcript auto-scrolls for free.

## Audio-only toggle
Explicit "Audio only" button below the video box (plus the existing collapse chevron) →
`setShowVideo(false)` → hook hands off position to `useAudio`.

## Files
- NEW `src/useMediaTimeline.ts`, `src/YtPlayer.web.tsx`, `src/YtPlayer.tsx`, `src/YtPlayer.types.ts`
- EDIT `src/VideoDocument.tsx` — use the timeline hook; render `<YtPlayer>` instead of the
  raw iframe/WebView; simplify `togglePlay` to route to the active backend; add audio-only button.
- EDIT `app/CLAUDE.md` — replace the "never simultaneous" note with the shared-timeline model.

## Verify
`just lint-app` + `tsc --noEmit`; `just build-app-web`; agent-browser on a youtube video
doc → press play on video → bottom time advances + transcript scrolls; screenshot.
Web fully wired; native via WebView bridge (can't test on-device here — report the split).
