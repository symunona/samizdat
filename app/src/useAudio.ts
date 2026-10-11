// Native audio backend (expo-audio). The web build resolves useAudio.web.ts
// instead (HTML5 <audio>), so expo-audio never enters the web bundle.
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useAudioPlayer } from 'expo-audio'
import type { AudioStatus } from 'expo-audio'
import { createLogger } from './logger'

const log = createLogger('audio')

// Now-playing metadata shown on the OS lock screen / media notification.
export type AudioMeta = { title?: string; artist?: string; artworkUrl?: string }

export type AudioControl = {
  playing: boolean
  positionMs: number
  durationMs: number
  rate: number
  play: () => void
  pause: () => void
  seek: (ms: number) => void
  setRate: (rate: number) => void
  // The backend's position right now. `positionMs` is React state and is frozen
  // while the app is backgrounded — anything that runs then (the resume save) must
  // read this instead.
  getPositionMs: () => number
  // Claim (or release) the OS media session so this backend keeps playing when the
  // app is backgrounded/locked and surfaces lock-screen controls. On Android this is
  // REQUIRED for background playback beyond ~3 min. No-op on the web backend.
  setLockScreen: (active: boolean, meta?: AudioMeta) => void
}

type Snapshot = { playing: boolean; positionMs: number; durationMs: number }

// A failed stream is retried on this schedule (about two minutes in all — a tunnel,
// a Wi-Fi→mobile handover), then left alone until the user presses play.
const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000]
// Behind the lock there is no schedule: React Native stops every JS timer while the
// activity is paused, so a setTimeout set there fires on unlock, hours late. A locked
// phone retries at once, this many times (ExoPlayer has already retried the request
// itself before reporting), and the return to the foreground retries again.
const BACKGROUND_RETRIES = 3
// Playback this far past a retry means it worked; the next error gets a full budget.
const RETRY_PROVEN_MS = 10000

const isLocal = (src: string) => src.startsWith('file:')
// What a log line may say about a source: never the full URL, just where it lives.
const describe = (src: string) => (!src ? 'nothing' : isLocal(src) ? 'local file' : src.split('/').slice(0, 3).join('/'))
const toMs = (sec: number | undefined) => (Number.isFinite(sec) ? Math.floor((sec as number) * 1000) : 0)

// `onBackgroundProgress` is called on each status frame while the app is NOT active —
// the only heartbeat there is behind the lock (timers are stopped, see above).
export function useAudio(source: string, onBackgroundProgress?: () => void): AudioControl {
  // ONE player for the life of the screen. `useAudioPlayer(source)` keys the player
  // on its source, so every change — including the empty string a failed connection
  // probe produces — released the playing player and handed back a paused new one:
  // sound stopped mid-sentence on a locked phone. Sources go in through `replace`.
  const player = useAudioPlayer(null)
  const [snap, setSnap] = useState<Snapshot>({ playing: false, positionMs: 0, durationMs: 0 })
  const [rate, setRateState] = useState(1)

  const lastRef = useRef(snap) // newest status, whether or not React was told
  const loadedRef = useRef('') // the source the player holds
  const wantedRef = useRef('') // the source the caller last asked for
  const intentRef = useRef(false) // the listener wants sound
  const erroredRef = useRef(false)
  // Position + play intent to restore once a replaced source has loaded.
  const resumeRef = useRef<{ ms: number; play: boolean } | null>(null)
  const retriesRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retriedAtMsRef = useRef(0) // position of the last retry, to tell when it has held
  const endedRef = useRef(false)
  const onBackgroundProgressRef = useRef(onBackgroundProgress)
  onBackgroundProgressRef.current = onBackgroundProgress

  const livePositionMs = useCallback(() => {
    // The player is released before the screen's final save runs; fall back to the
    // last status frame (at most one update interval old).
    try { return toMs(player.currentTime) || lastRef.current.positionMs } catch { return lastRef.current.positionMs }
  }, [player])

  const load = useCallback((src: string, why: string) => {
    const from = loadedRef.current
    const ms = from ? livePositionMs() : 0
    resumeRef.current = from ? { ms, play: intentRef.current } : null
    log.log(`source ${why}: ${describe(from)} → ${describe(src)} at ${ms}ms, play=${intentRef.current}`)
    loadedRef.current = src
    try {
      // A finished or failed player still has playWhenReady set and would start the
      // new source on its own; only the listener's intent may do that.
      if (!intentRef.current) player.pause()
      player.replace(src)
      // Seek NOW, not when the load reports ready: ExoPlayer keeps a seek made while
      // preparing, and waiting a bridge round trip plays the first words of the file.
      if (ms > 0) player.seekTo(ms / 1000).catch(() => {})
    } catch (e) {
      log.error('replace failed', e)
    }
  }, [player, livePositionMs])

  const cancelRetry = useCallback(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
  }, [])

  useEffect(() => {
    if (!source) return // a connection blip is not a new source
    wantedRef.current = source
    const loaded = loadedRef.current
    if (source === loaded) return
    // The same stream on another host. The one playing still works and a swap is an
    // audible gap, so keep it — if it does die, the error path loads the wanted one.
    if (loaded && !isLocal(loaded) && !isLocal(source) && !erroredRef.current && lastRef.current.durationMs > 0) {
      log.log(`source kept: ${describe(loaded)} (server moved to ${describe(source)})`)
      return
    }
    load(source, loaded ? 'changed' : 'set')
  }, [source, load])

  useEffect(() => {
    const publish = () => setSnap(prev => {
      const next = lastRef.current
      return prev.playing === next.playing && prev.positionMs === next.positionMs && prev.durationMs === next.durationMs ? prev : next
    })
    // The `error` key rides on the same event but is not in the published type.
    const sub = player.addListener('playbackStatusUpdate', (st: AudioStatus & { error?: string }) => {
      const next = { playing: !!st.playing, positionMs: toMs(st.currentTime), durationMs: toMs(st.duration) }
      const active = AppState.currentState === 'active'
      const r = resumeRef.current
      // A source being swapped reports 0 until it has loaded and the seek has landed;
      // keep the numbers it is headed for so nothing reads the gap as "back at 0:00".
      if (r) {
        next.positionMs = r.ms
        if (next.durationMs <= 0) next.durationMs = lastRef.current.durationMs
      }
      lastRef.current = next

      if (st.error) {
        erroredRef.current = true
        if (!retryTimerRef.current) {
          const n = retriesRef.current
          retriesRef.current = n + 1
          retriedAtMsRef.current = next.positionMs
          const retry = () => load(wantedRef.current || loadedRef.current, `retry ${n + 1}`)
          if (!active && n < BACKGROUND_RETRIES) {
            log.error(`player error at ${next.positionMs}ms on ${describe(loadedRef.current)}: ${st.error} — retry ${n + 1} now (${AppState.currentState})`)
            retry()
          } else if (active && n < RETRY_DELAYS_MS.length) {
            log.error(`player error at ${next.positionMs}ms on ${describe(loadedRef.current)}: ${st.error} — retry ${n + 1} in ${RETRY_DELAYS_MS[n]}ms`)
            retryTimerRef.current = setTimeout(() => { retryTimerRef.current = null; retry() }, RETRY_DELAYS_MS[n])
          } else {
            log.error(`player error at ${next.positionMs}ms on ${describe(loadedRef.current)}: ${st.error} — giving up until play or the foreground`)
          }
        }
      } else if (st.isLoaded) {
        if (st.didJustFinish) endedRef.current = true
        if (r) {
          erroredRef.current = false
          resumeRef.current = null
          if (r.play) player.play()
        } else if (erroredRef.current) {
          // Dead until a retry (or play) reloads it; its "paused" is not a choice.
        } else if (st.playing) {
          intentRef.current = true
          if (next.positionMs - retriedAtMsRef.current > RETRY_PROVEN_MS) retriesRef.current = 0
        } else if (!st.isBuffering) {
          // Paused from outside React: the lock-screen control, a phone call. A later
          // source swap must not start it again.
          intentRef.current = false
        }
      }
      // Locked or backgrounded: nobody is looking, so React is told nothing. The
      // refs above keep the truth; 'active' publishes it once.
      if (active) publish()
      else onBackgroundProgressRef.current?.()
    })
    const app = AppState.addEventListener('change', s => {
      if (s !== 'active') return
      publish()
      // Whatever gave up behind the lock gets a fresh run now that timers work again.
      if (erroredRef.current && intentRef.current && !retryTimerRef.current && !resumeRef.current) {
        retriesRef.current = 0
        load(wantedRef.current || loadedRef.current, 'retry on foreground')
      }
    })
    return () => {
      sub.remove()
      app.remove()
      cancelRetry()
    }
  }, [player, load, cancelRetry])

  const play = useCallback(() => {
    intentRef.current = true
    retriesRef.current = 0
    if (resumeRef.current) {
      resumeRef.current.play = true // still loading: start when it is ready
    } else if (erroredRef.current) {
      cancelRetry() // do not make the listener wait out a scheduled retry
      load(wantedRef.current || loadedRef.current, 'reload on play')
    } else {
      // A finished track sits at its end with nothing left to play.
      if (endedRef.current) player.seekTo(0).catch(() => {})
      endedRef.current = false
      player.play()
    }
  }, [player, load, cancelRetry])

  const pause = useCallback(() => {
    intentRef.current = false
    if (resumeRef.current) resumeRef.current.play = false
    player.pause()
  }, [player])

  const seek = useCallback((ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) return
    endedRef.current = false
    if (resumeRef.current) resumeRef.current.ms = ms // still loading: land there instead
    player.seekTo(ms / 1000).catch(() => {})
  }, [player])

  // shouldCorrectPitch keeps voices natural at faster speeds (podcast-friendly).
  const setRate = useCallback((r: number) => { player.setPlaybackRate(r, 'high'); setRateState(r) }, [player])

  const setLockScreen = useCallback((active: boolean, meta?: AudioMeta) => {
    // Claiming the session starts a foreground service. Android 12+ may refuse that
    // from the background, and expo-audio reports the refusal natively, not as a
    // throw — so the only trace of a claim made too late is this line.
    if (active && AppState.currentState !== 'active') log.warn(`lock-screen session claimed while ${AppState.currentState}`)
    try {
      player.setActiveForLockScreen(active, meta, { showSeekForward: true, showSeekBackward: true })
    } catch (e) {
      log.error('setActiveForLockScreen failed', e)
    }
  }, [player])

  return {
    playing: snap.playing,
    positionMs: snap.positionMs,
    durationMs: snap.durationMs,
    rate,
    play,
    pause,
    seek,
    setRate,
    getPositionMs: livePositionMs,
    setLockScreen,
  }
}
