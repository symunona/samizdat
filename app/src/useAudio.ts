// Native audio backend (expo-audio). The web build resolves useAudio.web.ts
// instead (HTML5 <audio>), so expo-audio never enters the web bundle.
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio'

export type AudioControl = {
  playing: boolean
  positionMs: number
  durationMs: number
  play: () => void
  pause: () => void
  seek: (ms: number) => void
}

export function useAudio(source: string): AudioControl {
  const player = useAudioPlayer(source)
  const status = useAudioPlayerStatus(player)
  return {
    playing: status?.playing ?? false,
    positionMs: Math.floor((status?.currentTime ?? 0) * 1000),
    durationMs: Math.floor((status?.duration ?? 0) * 1000),
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (ms: number) => player.seekTo(ms / 1000),
  }
}
