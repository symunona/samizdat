// Web audio backend — a plain HTML5 <audio> element. Metro resolves this file
// for web builds in place of useAudio.ts (which uses expo-audio on native).
import { useEffect, useRef, useState } from 'react'
import type { AudioControl } from './useAudio'

export type { AudioControl, AudioMeta } from './useAudio'

export function useAudio(source: string): AudioControl {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [positionMs, setPositionMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [rate, setRate] = useState(1)
  const rateRef = useRef(1)

  // ONE element for the life of the screen — same contract as the native backend:
  // an empty source (a failed connection probe) is ignored, and a real change keeps
  // the position and the play state instead of starting over paused at 0.
  const loadedRef = useRef('')
  useEffect(() => {
    const a = new Audio()
    a.preload = 'metadata'
    ref.current = a
    const onTime = () => setPositionMs(a.currentTime * 1000)
    const onDur = () => setDurationMs((isFinite(a.duration) ? a.duration : 0) * 1000)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onDur)
    a.addEventListener('durationchange', onDur)
    a.addEventListener('play', onPlay)
    a.addEventListener('pause', onPause)
    a.addEventListener('ended', onPause)
    return () => {
      a.pause()
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onDur)
      a.removeEventListener('durationchange', onDur)
      a.removeEventListener('play', onPlay)
      a.removeEventListener('pause', onPause)
      a.removeEventListener('ended', onPause)
      a.src = ''
      ref.current = null
    }
  }, [])

  useEffect(() => {
    const a = ref.current
    if (!a || !source || source === loadedRef.current) return
    const resumeAt = loadedRef.current ? a.currentTime : 0
    const wasPlaying = !!loadedRef.current && !a.paused
    loadedRef.current = source
    a.src = source
    a.addEventListener('loadedmetadata', () => {
      a.playbackRate = rateRef.current // a new resource resets the rate
      if (resumeAt > 0) a.currentTime = resumeAt
      if (wasPlaying) a.play().catch(() => {})
    }, { once: true })
  }, [source])

  return {
    playing,
    positionMs,
    durationMs,
    rate,
    play: () => { ref.current?.play().catch(() => {}) },
    pause: () => ref.current?.pause(),
    seek: (ms: number) => {
      const a = ref.current
      if (!a || !Number.isFinite(ms)) return
      const dur = Number.isFinite(a.duration) ? a.duration : 0
      if (dur <= 0) return // metadata not loaded yet — avoid a non-finite currentTime
      a.currentTime = Math.max(0, Math.min(ms / 1000, dur))
    },
    setRate: (r: number) => {
      rateRef.current = r
      if (ref.current) ref.current.playbackRate = r
      setRate(r)
    },
    getPositionMs: () => (ref.current?.currentTime ?? 0) * 1000,
    // Web keeps its own <audio>; the tab stays alive when backgrounded, so no
    // native media session to claim. No-op to satisfy the shared interface.
    setLockScreen: () => {},
  }
}
