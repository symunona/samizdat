---
created: 2026-10-03
topic: Video/podcast player — survive the lock screen, a server blip and the gesture bar
excerpt: One audio player per Document that never dies with the connection probe; no React work while locked; an honest offline-media button with three states; a seek bar the system gesture zone cannot steal.
status: shipped 2026-10-11 (native path unverified on device)
---

# Player: lock screen, connection blips, offline button, seek bar

## Symptom
A 2h46m podcast (`da351399…`, 1753 transcript segments) went silent after hours of
locked playback. No JS error, nothing in the device log, server journal clean.

## Mechanism (read from the code, not reproduced on a device)
`ConnectionContext` probes every 30s. One failed probe sets `activeUrl` to `null`; a
probe that falls through to another stored URL sets a different one. `VideoDocument`
derived the audio source from `activeUrl`, and `expo-audio`'s `useAudioPlayer` keys
its player on the source — so either event **released the playing player** and made a
fresh, paused one. The same blip released the OS media session (`setLockScreen(false)`)
and reloaded the transcript WebView (`baseUrl`).

## A — no work while locked
- `useAudio` (native) subscribes to `playbackStatusUpdate` itself. Status lands in a
  ref; React state is only set while `AppState` is `active`, and resynced once on return.
- `useMediaTimeline.onYtStatus` drops identical frames and everything while backgrounded.
- `getPositionMs()` on the timeline reads the backend directly. JS timers are stopped
  behind the lock (found in review), so the locked resume save and the error retry hang
  off the audio status event instead of `setInterval`/`setTimeout`.
- Transcript follow: the host binary-searches the segment and posts `mediaTime` only
  when the segment changes; the viewer caches its `.seg` list and toggles two nodes.
- `ConnectionProvider` skips its interval probe while backgrounded, probes on return.

## B — one player per Document
- `useAudioPlayer(null)` once; sources go in through `player.replace`. An empty source
  is ignored. A remote→remote host change is deferred while the current stream is
  healthy; remote→local (download finished) swaps at once. Every swap restores
  position and the play intent. A player error retries the wanted source (bounded).
- `VideoDocument` keeps the last known server URL for media + the WebView `baseUrl`.
- Handoff: (1) "was sounding" = playing now or within the last second, so expo-video
  pausing itself before `AppState` fires still hands off; (2) opening the video view
  always starts from the live position; (3) a lock-screen claim made from the
  background is logged.

## C — offline media button
Tapping the button on a downloaded Document re-downloaded the whole file (no check
for an existing copy). It also trusted any HTTP status, so an error body could be
saved as "the audio". Now: download to `.part`, require 200, move into place.
Three states, one meaning each — server only · audio on phone · audio + video on
phone — and the last two say "plays with no internet". Placement stays in the footer
until the owner picks (recommendation: header).

## D — seek bar vs. the gesture bar
The track sat on the bottom edge, inside Android's 32dp system-gesture zone, and only
seeked on release. Seek row moves above the buttons; it becomes a real drag that
refuses termination.

## Self-test (decided up front)
`just e2e-int` → `runTranscriptPlayback`, on a real (silent WAV) audio fixture:
- drag the seek bar → the time label lands where the finger left;
- force offline + probe (blip) → reconnect → `+1s` continues from the old position,
  not from 0;
- stepping inside one segment posts no further `mediaTime`; crossing posts one.

Native-only, cannot be verified headless: the expo-audio player itself, lock-screen
session, FGS start, expo-video background pause, downloads, the gesture zone.
