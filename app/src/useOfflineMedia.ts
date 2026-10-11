// What of one video Document is on this phone, and the moves between the three
// states the player shows: server only → audio on phone → audio + video on phone.
// Native only — on web there is no filesystem and the state stays 'server'.
import { useCallback, useEffect, useRef, useState } from 'react'
import { deleteOfflineMedia, deleteOfflineVideo, downloadOfflineMedia, findOfflineMedia } from './offlineCache'
import type { OfflineKind } from './offlineCache'

export type OfflineState = 'server' | 'audio' | 'video'

export function useOfflineMedia(docId: string) {
  const [found, setFound] = useState<{ audioUri: string | null; videoUri: string | null; sizeBytes: number }>(
    { audioUri: null, videoUri: null, sizeBytes: 0 },
  )
  const [busy, setBusy] = useState<OfflineKind | null>(null)
  const [percent, setPercent] = useState(0)
  const percentRef = useRef(0)

  const refresh = useCallback(async () => setFound(await findOfflineMedia(docId)), [docId])
  useEffect(() => { refresh().catch(() => {}) }, [refresh])

  const download = useCallback(async (kind: OfflineKind, url: string) => {
    setBusy(kind)
    setPercent(percentRef.current = 0)
    try {
      await downloadOfflineMedia(docId, kind, url, fraction => {
        // Progress fires per chunk; the button only shows whole percents.
        const p = Math.floor(fraction * 100)
        if (p !== percentRef.current) setPercent(percentRef.current = p)
      })
    } finally {
      setBusy(null)
      await refresh()
    }
  }, [docId, refresh])

  const remove = useCallback(async (kind: OfflineKind) => {
    if (kind === 'video') await deleteOfflineVideo(docId)
    else await deleteOfflineMedia(docId)
    await refresh()
  }, [docId, refresh])

  const state: OfflineState = !found.audioUri ? 'server' : found.videoUri ? 'video' : 'audio'
  return { ...found, state, busy, percent, download, remove }
}
