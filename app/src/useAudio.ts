// Native audio backend (expo-audio). The web build resolves useAudio.web.ts
// instead (HTML5 <audio>), so expo-audio never enters the web bundle.
import { useState } from 'react'
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'

export type AudioControl = {
  playing: boolean
  positionMs: number
  durationMs: number
  rate: number
  play: () => void
  pause: () => void
  seek: (ms: number) => void
  setRate: (rate: number) => void
}

export function useAudio(source: string): AudioControl {
  const player = useAudioPlayer(source)
  const status = useAudioPlayerStatus(player)
  const [rate, setRateState] = useState(1)
  return {
    playing: status?.playing ?? false,
    positionMs: Math.floor((status?.currentTime ?? 0) * 1000),
    durationMs: Math.floor((status?.duration ?? 0) * 1000),
    rate,
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (ms: number) => { if (Number.isFinite(ms) && ms >= 0) player.seekTo(ms / 1000) },
    // shouldCorrectPitch keeps voices natural at faster speeds (podcast-friendly).
    setRate: (r: number) => { player.setPlaybackRate(r, 'high'); setRateState(r) },
  }
}
