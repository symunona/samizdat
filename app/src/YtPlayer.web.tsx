// Web YouTube backend — drives an embedded player via the YouTube IFrame Player
// API so the shared timeline can read currentTime/duration and control
// play/pause/seek/rate. Metro resolves this file for web; native uses YtPlayer.tsx.
//
// The plain `?src=` iframe used before is opaque (no currentTime, no control), which
// is exactly why the video could not share the bottom bar's timeline. The IFrame API
// exposes both, so the video becomes just another AudioControl-shaped backend.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { YtPlayerHandle, YtPlayerProps, YtStatus } from './YtPlayer.types'
import { createLogger } from './logger'

const log = createLogger('yt-player')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YT = any

// Load the IFrame API exactly once per page and resolve when `window.YT` is ready.
let ytApiPromise: Promise<void> | null = null
function loadYtApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  const w = window as unknown as { YT?: { Player?: unknown }; onYouTubeIframeAPIReady?: () => void }
  if (w.YT?.Player) return Promise.resolve()
  if (ytApiPromise) return ytApiPromise
  ytApiPromise = new Promise<void>((resolve) => {
    const prev = w.onYouTubeIframeAPIReady
    w.onYouTubeIframeAPIReady = () => { prev?.(); resolve() }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })
  return ytApiPromise
}

const YtPlayer = forwardRef<YtPlayerHandle, YtPlayerProps>(function YtPlayer(
  { videoId, startMs, rate, onStatus, onError }, ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YT>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Latest callback/rate without re-running the mount effect (which would tear down
  // and recreate the player on every render).
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus
  const onErrorRef = useRef(onError); onErrorRef.current = onError
  const rateRef = useRef(rate); rateRef.current = rate
  const startRef = useRef(startMs); startRef.current = startMs

  useEffect(() => {
    let cancelled = false
    const emit = (p: YT) => {
      if (!p?.getCurrentTime) return
      const state = p.getPlayerState?.()
      const s: YtStatus = {
        playing: state === 1, // YT.PlayerState.PLAYING
        positionMs: Math.floor((p.getCurrentTime() || 0) * 1000),
        durationMs: Math.floor((p.getDuration?.() || 0) * 1000),
      }
      onStatusRef.current(s)
    }
    loadYtApi().then(() => {
      if (cancelled || !hostRef.current) return
      const w = window as unknown as { YT: { Player: new (el: Element, o: object) => YT } }
      playerRef.current = new w.YT.Player(hostRef.current, {
        videoId,
        playerVars: {
          start: Math.floor(startRef.current / 1000),
          autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1,
        },
        events: {
          onReady: (e: { target: YT }) => {
            try { e.target.setPlaybackRate(rateRef.current) } catch (err) { log.error('setRate', err) }
            onStatusRef.current({
              playing: true,
              positionMs: startRef.current,
              durationMs: Math.floor((e.target.getDuration?.() || 0) * 1000),
            })
          },
          onStateChange: (e: { target: YT }) => emit(e.target),
          // 101 & 150 = embedding disabled by the video owner; host shows a fallback.
          onError: (e: { data: number }) => onErrorRef.current?.(Number(e.data)),
        },
      })
    }).catch(err => log.error('yt api load', err))
    // Poll currentTime so the seeker + transcript keep advancing during playback
    // (onStateChange only fires on state transitions, not while playing).
    pollRef.current = setInterval(() => emit(playerRef.current), 250)
    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
      try { playerRef.current?.destroy?.() } catch { /* already gone */ }
      playerRef.current = null
    }
  }, [videoId])

  useImperativeHandle(ref, () => ({
    play: () => playerRef.current?.playVideo?.(),
    pause: () => playerRef.current?.pauseVideo?.(),
    seek: (ms: number) => playerRef.current?.seekTo?.(ms / 1000, true),
    setRate: (r: number) => playerRef.current?.setPlaybackRate?.(r),
  }), [])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <div ref={hostRef} style={{ width: '100%', height: '100%' } as any} />
})

export default YtPlayer
