---
created: 2026-07-02
topic: Lock-screen background audio — video→audio handoff
excerpt: When the app is locked/backgrounded, the YouTube WebView suspends and playback dies. Hand off to the native expo-audio backend (local synced file or server stream) so audio keeps playing with lock-screen controls.
status: implementing
---

# Lock-screen background audio handoff

## Problem
On lock, the OS suspends the WebView hosting the YouTube IFrame player (`YtPlayer.tsx`),
so video/audio playback stops. Podcast apps (VLC, Pocket Casts) keep playing because a
**native media session** owns playback, not a webview.

## Insight — the pieces already exist
`useMediaTimeline` already merges two backends behind one `AudioControl`:
- **youtube** — WebView IFrame player (dies on lock)
- **audio** — `expo-audio` (`useAudio.ts`), plays the offline-synced local file OR the
  server stream. **Native, survives lock** when background audio is enabled.

It already has a **handoff**: when `videoActive` flips false it seeks the audio element
to the video's position and resumes. So the fallback the user wants = trigger that handoff
on background.

`expo-audio`'s config plugin (already in `app.json` `plugins`) auto-adds
`UIBackgroundModes: ["audio"]` (iOS) + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` (Android) at
prebuild. `expo-audio` also ships `setActiveForLockScreen(active, metadata, options)` —
built-in lock-screen media controls, no `react-native-track-player` needed. On Android this
is **required** for background playback beyond ~3 min (OS limit).

## Changes
1. **`app/_layout.tsx`** — once on mount (native only): `setAudioModeAsync({ playsInSilentMode:
   true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' })`. (`doNotMix` is required
   for lock-screen controls.)
2. **`src/useAudio.ts`** (native) — add `setLockScreen(active, meta)` →
   `player.setActiveForLockScreen(active, meta, { showSeekForward: true, showSeekBackward: true })`.
   **`src/useAudio.web.ts`** — no-op `setLockScreen` (web keeps its own `<audio>`).
   Add `setLockScreen` to the `AudioControl` type.
3. **`src/useMediaTimeline.ts`** — accept `meta {title, artist, artworkUrl}`; in the handoff
   effect activate the lock screen when audio is the sounding backend, deactivate when video is.
4. **`src/VideoDocument.tsx`** — build `meta` from the doc; add an `AppState` listener that on
   `'background'` calls `switchToAudio()` when the video is active + playing → hands off to
   expo-audio, which keeps playing locked.
5. **Version** — `app.json` `expo.version` 0.1.0 → **0.2.0**, `android.versionCode` 2 → **3**.

## Test (needs a real device — headless browser can't lock)
- `just build` + `just e2e` green (web build unaffected; `setLockScreen` no-op on web).
- Manual on device: build APK, open a video doc, play, **lock the phone** → audio continues,
  lock-screen shows title/artist/artwork + play/seek controls. Unlock → collapses to audio-only.

## Scope / caveats
- Experiment. YouTube ToS aside (personal self-host), the audio comes from the server
  stream/offline file, not the YT iframe — so this only works for docs that have a Sam audio
  asset (synced or `audioDocUrl`). Docs with only a YT id and no server audio can't hand off.
- Returning to foreground leaves it in audio-only; re-tap the thumbnail for video. Acceptable.
