// Web server-video backend — a plain HTML5 <video> playing the server-fetched
// stream. Metro resolves this for web in place of ServerVideoPlayer.tsx (expo-video
// on native), so expo-video never enters the web bundle. Same YtPlayerHandle/
// YtStatus contract, so useMediaTimeline drives it exactly like YtPlayer.
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { YtPlayerHandle } from './YtPlayer.types'
import type { ServerVideoPlayerProps } from './ServerVideoPlayer'

const ServerVideoPlayer = forwardRef<YtPlayerHandle, ServerVideoPlayerProps>(function ServerVideoPlayer(
  { src, startMs, rate, onStatus, onError }, ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus
  const onErrorRef = useRef(onError); onErrorRef.current = onError
  const startRef = useRef(startMs); startRef.current = startMs
  const rateRef = useRef(rate); rateRef.current = rate

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const emit = () => onStatusRef.current({
      playing: !v.paused && !v.ended,
      positionMs: Math.floor((v.currentTime || 0) * 1000),
      durationMs: Math.floor((isFinite(v.duration) ? v.duration : 0) * 1000),
    })
    const onLoaded = () => {
      try { if (startRef.current > 0) v.currentTime = startRef.current / 1000 } catch { /* metadata race */ }
      v.playbackRate = rateRef.current
      v.play().catch(() => {})
      emit()
    }
    const onErr = () => onErrorRef.current?.(v.error?.code ?? 0)
    v.addEventListener('loadedmetadata', onLoaded)
    v.addEventListener('timeupdate', emit)
    v.addEventListener('durationchange', emit)
    v.addEventListener('play', emit)
    v.addEventListener('pause', emit)
    v.addEventListener('ended', emit)
    v.addEventListener('error', onErr)
    return () => {
      v.removeEventListener('loadedmetadata', onLoaded)
      v.removeEventListener('timeupdate', emit)
      v.removeEventListener('durationchange', emit)
      v.removeEventListener('play', emit)
      v.removeEventListener('pause', emit)
      v.removeEventListener('ended', emit)
      v.removeEventListener('error', onErr)
    }
  }, [])

  useImperativeHandle(ref, () => ({
    play: () => { videoRef.current?.play().catch(() => {}) },
    pause: () => videoRef.current?.pause(),
    seek: (ms: number) => {
      const v = videoRef.current
      if (!v || !Number.isFinite(ms)) return
      const dur = isFinite(v.duration) ? v.duration : 0
      if (dur <= 0) return
      v.currentTime = Math.max(0, Math.min(ms / 1000, dur))
    },
    setRate: (r: number) => { if (videoRef.current) videoRef.current.playbackRate = r },
  }), [])

  return (
    <video
      ref={videoRef}
      src={src}
      playsInline
      controls
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      style={{ width: '100%', height: '100%', backgroundColor: '#000' } as any}
    />
  )
})

export default ServerVideoPlayer
