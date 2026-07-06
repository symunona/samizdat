// Native server-video backend — plays the server-fetched video stream with
// expo-video, so there's no YouTube IFrame embed (and no error 152 / ads). It
// satisfies the SAME YtPlayerHandle/YtStatus contract as YtPlayer, so
// useMediaTimeline drives it unchanged (play/pause/seek/rate + a status frame).
// Metro resolves ServerVideoPlayer.web.tsx for web (a plain HTML5 <video>).
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { StyleSheet } from 'react-native'
import { useVideoPlayer, VideoView } from 'expo-video'
import type { YtPlayerHandle, YtStatus } from './YtPlayer.types'
import { createLogger } from './logger'

const log = createLogger('server-video')

export type ServerVideoPlayerProps = {
  // The server /documents/{id}/video stream URL (range-capable, so seek works).
  src: string
  startMs: number
  rate: number
  onStatus: (s: YtStatus) => void
  // Fired when the stream fails to load — the host falls back to the YT embed.
  onError?: (code: number) => void
}

const ServerVideoPlayer = forwardRef<YtPlayerHandle, ServerVideoPlayerProps>(function ServerVideoPlayer(
  { src, startMs, rate, onStatus, onError }, ref,
) {
  // Latest callbacks/values without re-creating the player on every render.
  const startRef = useRef(startMs); startRef.current = startMs
  const rateRef = useRef(rate); rateRef.current = rate
  const onStatusRef = useRef(onStatus); onStatusRef.current = onStatus
  const onErrorRef = useRef(onError); onErrorRef.current = onError

  const player = useVideoPlayer(src, p => {
    try { if (startRef.current > 0) p.currentTime = startRef.current / 1000 } catch (e) { log.error('seek on init', e) }
    p.playbackRate = rateRef.current
    p.play()
  })

  // Poll for progress → feed the shared timeline (same 250ms cadence as YtPlayer).
  useEffect(() => {
    const id = setInterval(() => {
      onStatusRef.current({
        playing: player.playing,
        positionMs: Math.floor((player.currentTime || 0) * 1000),
        durationMs: Math.floor((player.duration || 0) * 1000),
      })
    }, 250)
    const sub = player.addListener('statusChange', ({ error }) => {
      if (error) { log.error('video status error', error.message); onErrorRef.current?.(0) }
    })
    return () => { clearInterval(id); sub.remove() }
  }, [player])

  useImperativeHandle(ref, () => ({
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (ms: number) => { if (Number.isFinite(ms) && ms >= 0) player.currentTime = ms / 1000 },
    setRate: (r: number) => { player.playbackRate = r },
  }), [player])

  // nativeControls gives the player its own scrubber + fullscreen button.
  return <VideoView style={styles.fill} player={player} contentFit="contain" nativeControls />
})

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: '#000' } })

export default ServerVideoPlayer
