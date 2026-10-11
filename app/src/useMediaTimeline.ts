// useMediaTimeline — one playback timeline shared by the bottom seeker/transcript
// and the (optional) video view. It merges TWO backends behind the existing
// `AudioControl` shape so the seeker + transcript code never branch on which one is
// playing:
//   • audio backend  — the platform-split `useAudio` (offline local file OR stream)
//   • video  backend — a `YtPlayerHandle`-shaped component (the native server-video
//                       `ServerVideoPlayer` OR the YouTube embed `YtPlayer`), driven
//                       by ref + reporting progress via `onStatus` (state lives here)
//
// `videoActive` picks the backend. Rate is owned here and fanned out to both so speed
// stays synced. A handoff effect prevents double audio: entering the video pauses the
// <audio> element (the video carries the sound); leaving it resumes audio from the
// video's position. The caller composes `hasVideo` — the timeline doesn't care whether
// the mounted backend is the server stream or the embed; both satisfy the same handle.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { AppState } from 'react-native'
import { useAudio } from './useAudio'
import type { AudioControl, AudioMeta } from './useAudio'
import type { YtPlayerHandle, YtStatus } from './YtPlayer.types'

export type MediaTimeline = AudioControl & {
  videoActive: boolean
  // Rendering handles for the caller's <YtPlayer> (only mounted when the video shows).
  ytRef: RefObject<YtPlayerHandle | null>
  onYtStatus: (s: YtStatus) => void
  // The video backend is sounding, or was a moment ago. Asked at lock time, when the
  // OS may already have paused it — see SOUNDING_GRACE_MS.
  videoSounding: () => boolean
}

// expo-video pauses itself as the activity stops, and that can land before the
// 'background' AppState event does. A status frame that says "paused" at lock time
// is therefore not evidence the listener paused; "playing within the last second" is.
const SOUNDING_GRACE_MS = 1000

export function useMediaTimeline(opts: {
  audioUrl: string
  // A video backend (server stream or YT embed) is mounted and ready to sound.
  hasVideo: boolean
  showVideo: boolean
  // Now-playing info for the lock screen while the audio backend is sounding.
  meta?: AudioMeta
  // Called as audio plays while the app is backgrounded/locked (see useAudio).
  onBackgroundProgress?: () => void
}): MediaTimeline {
  const { audioUrl, hasVideo, showVideo, meta, onBackgroundProgress } = opts
  const audio = useAudio(audioUrl, onBackgroundProgress)

  const videoActive = showVideo && hasVideo
  const [yt, setYt] = useState<YtStatus>({ playing: false, positionMs: 0, durationMs: 0 })
  const ytRef = useRef<YtPlayerHandle | null>(null)

  // Rate is the timeline's, fanned out to both backends so they never drift.
  const [rate, setRateState] = useState(1)
  const setRate = useCallback((r: number) => {
    setRateState(r)
    audio.setRate(r)
    ytRef.current?.setRate(r)
  }, [audio])

  // Handoff so the two never sound at once and position is continuous across a switch.
  // The newest video frame lives in a ref: React state is only told about a frame that
  // differs, and never while backgrounded (nobody is looking; a render is pure cost).
  const audioRef = useRef(audio); audioRef.current = audio
  const ytStateRef = useRef(yt)
  const lastVideoPlayingAtRef = useRef(0)
  const onYtStatus = useCallback((next: YtStatus) => {
    ytStateRef.current = next
    if (next.playing) lastVideoPlayingAtRef.current = Date.now()
    if (AppState.currentState !== 'active') return
    setYt(prev => (prev.playing === next.playing && prev.positionMs === next.positionMs && prev.durationMs === next.durationMs ? prev : next))
  }, [])
  const videoSounding = useCallback(
    () => ytStateRef.current.playing || Date.now() - lastVideoPlayingAtRef.current < SOUNDING_GRACE_MS,
    [],
  )
  const prevActive = useRef(false)
  useEffect(() => {
    const a = audioRef.current
    if (videoActive && !prevActive.current) {
      // Entering the video view — silence the audio element; the video carries the
      // sound. Unconditional: `a.playing` is React state and can be a lock behind.
      a.pause()
      // Forget the previous video session's last frame: until the new player reports,
      // the timeline is where the audio is, and nothing is sounding yet.
      ytStateRef.current = { playing: false, positionMs: a.getPositionMs(), durationMs: 0 }
      lastVideoPlayingAtRef.current = 0
      setYt(ytStateRef.current)
    } else if (!videoActive && prevActive.current) {
      // Back to audio-only — resume from wherever the video left off.
      a.seek(ytStateRef.current.positionMs)
      if (videoSounding()) a.play()
    }
    prevActive.current = videoActive
    // The audio backend owns the OS media session only while it's the sounding one
    // (audio-only mode). Claiming it here is what lets playback survive a lock — the
    // AppState listener in VideoDocument flips to audio on background, and this keeps
    // it alive with lock-screen controls. Released while the video (WebView) sounds.
    a.setLockScreen(!videoActive && !!audioUrl, meta)
  }, [videoActive, audioUrl, meta, videoSounding])

  if (videoActive) {
    return {
      playing: yt.playing,
      positionMs: yt.positionMs,
      // YT duration can lag a frame on mount — fall back to the audio duration.
      durationMs: yt.durationMs > 0 ? yt.durationMs : audio.durationMs,
      rate,
      play: () => ytRef.current?.play(),
      pause: () => ytRef.current?.pause(),
      seek: (ms: number) => ytRef.current?.seek(ms),
      setRate,
      getPositionMs: () => ytStateRef.current.positionMs,
      setLockScreen: audio.setLockScreen,
      videoActive,
      ytRef,
      onYtStatus,
      videoSounding,
    }
  }
  return {
    playing: audio.playing,
    positionMs: audio.positionMs,
    durationMs: audio.durationMs,
    rate,
    play: audio.play,
    pause: audio.pause,
    seek: audio.seek,
    setRate,
    getPositionMs: audio.getPositionMs,
    setLockScreen: audio.setLockScreen,
    videoActive,
    ytRef,
    onYtStatus,
    videoSounding,
  }
}
