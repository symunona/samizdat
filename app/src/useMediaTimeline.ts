// useMediaTimeline — one playback timeline shared by the bottom seeker/transcript
// and the (optional) YouTube video view. It merges TWO backends behind the existing
// `AudioControl` shape so the seeker + transcript code never branch on which one is
// playing:
//   • audio backend  — the platform-split `useAudio` (offline local file OR stream)
//   • youtube backend — the platform-split `YtPlayer` component, driven by ref +
//                       reporting progress via `onStatus` (state lives here)
//
// `videoActive` picks the backend. Rate is owned here and fanned out to both so speed
// stays synced. A handoff effect prevents double audio: entering the video pauses the
// <audio> element (YT provides the sound); leaving it resumes audio from YT's position.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useAudio } from './useAudio'
import type { AudioControl } from './useAudio'
import type { YtPlayerHandle, YtStatus } from './YtPlayer.types'

export type MediaTimeline = AudioControl & {
  videoActive: boolean
  // Rendering handles for the caller's <YtPlayer> (only mounted when the video shows).
  ytRef: RefObject<YtPlayerHandle | null>
  onYtStatus: (s: YtStatus) => void
}

export function useMediaTimeline(opts: {
  audioUrl: string
  ytId: string | undefined
  showVideo: boolean
}): MediaTimeline {
  const { audioUrl, ytId, showVideo } = opts
  const audio = useAudio(audioUrl)

  const videoActive = showVideo && !!ytId
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
  const audioRef = useRef(audio); audioRef.current = audio
  const ytStateRef = useRef(yt); ytStateRef.current = yt
  const prevActive = useRef(false)
  useEffect(() => {
    const a = audioRef.current
    if (videoActive && !prevActive.current) {
      // Entering the video view — silence the audio element; YT carries the sound.
      if (a.playing) a.pause()
    } else if (!videoActive && prevActive.current) {
      // Back to audio-only — resume from wherever the video left off.
      const { positionMs, playing } = ytStateRef.current
      a.seek(positionMs)
      if (playing) a.play()
    }
    prevActive.current = videoActive
  }, [videoActive])

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
      videoActive,
      ytRef,
      onYtStatus: setYt,
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
    videoActive,
    ytRef,
    onYtStatus: setYt,
  }
}
