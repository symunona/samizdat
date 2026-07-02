// Shared contract for the platform-split YouTube backend (YtPlayer.web.tsx /
// YtPlayer.tsx). Kept in its own file so VideoDocument + both implementations can
// import the types without pulling a platform-specific module into the wrong bundle.

// Progress snapshot the player reports up to the timeline (server of truth for the
// bottom seeker + transcript auto-scroll while the video view is active).
export type YtStatus = { playing: boolean; positionMs: number; durationMs: number }

// Imperative control surface — the timeline drives play/pause/seek/rate through this
// ref so the YouTube player behaves like just another AudioControl backend.
export type YtPlayerHandle = {
  play: () => void
  pause: () => void
  seek: (ms: number) => void
  setRate: (rate: number) => void
}

export type YtPlayerProps = {
  videoId: string
  startMs: number
  rate: number
  onStatus: (s: YtStatus) => void
}
