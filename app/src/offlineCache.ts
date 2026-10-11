import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import * as db from './db'

// Offline media cache: the one place a video Document's files are downloaded to,
// found on and deleted from the phone. Audio lands in FileSystem.documentDirectory
// with its URI recorded in the replica's `media_files` table; the optional video
// sits beside it at a path derived from the Document id and has no row — a download
// only moves into place once complete, so the file existing IS the record.
//
// `expo-file-system` is native-only. On web the module still imports cleanly, but
// every function is a safe no-op / empty result so a web build never crashes.

// Capability guard: FileSystem has no real filesystem on web (documentDirectory
// is null there). Treat that as "no offline cache available".
const NATIVE_FS = Platform.OS !== 'web' && !!FileSystem.documentDirectory

const audioFilePath = (docId: string) => `${FileSystem.documentDirectory}video-audio-${docId}.m4a`
const videoFilePath = (docId: string) => `${FileSystem.documentDirectory}video-file-${docId}.mp4`

async function fileSize(uri: string): Promise<number | null> {
  const info = await FileSystem.getInfoAsync(uri)
  return info.exists ? (typeof info.size === 'number' ? info.size : 0) : null
}

export type OfflineKind = 'audio' | 'video'

// What of a Document is on this phone right now. A `media_files` row whose file is
// gone is repaired here, so a stale row can never claim "plays with no internet".
export async function findOfflineMedia(docId: string): Promise<{ audioUri: string | null; videoUri: string | null; sizeBytes: number }> {
  if (!NATIVE_FS) return { audioUri: null, videoUri: null, sizeBytes: 0 }
  let audioUri = await db.getMediaFile(docId)
  let audioSize: number | null = null
  if (audioUri) {
    audioSize = await fileSize(audioUri).catch(() => null)
    if (audioSize == null) { await db.setMediaFile(docId, null); audioUri = null }
  }
  const videoSize = await fileSize(videoFilePath(docId)).catch(() => null)
  return {
    audioUri,
    videoUri: videoSize == null ? null : videoFilePath(docId),
    sizeBytes: (audioSize ?? 0) + (videoSize ?? 0),
  }
}

// Download one file of a Document. Written to `.part` and moved into place only on a
// complete 200: `downloadAsync` resolves on ANY status and saves the body, so without
// the check a 404 page became "the audio", and an interrupted download a short file
// that looked finished.
export async function downloadOfflineMedia(
  docId: string, kind: OfflineKind, url: string, onProgress: (fraction: number) => void,
): Promise<void> {
  const dest = kind === 'audio' ? audioFilePath(docId) : videoFilePath(docId)
  const part = `${dest}.part`
  await FileSystem.deleteAsync(part, { idempotent: true })
  const job = FileSystem.createDownloadResumable(url, part, {}, p => {
    if (p.totalBytesExpectedToWrite > 0) onProgress(p.totalBytesWritten / p.totalBytesExpectedToWrite)
  })
  try {
    const res = await job.downloadAsync()
    if (res?.status !== 200) throw new Error(`download ${kind}: HTTP ${res?.status ?? 'none'}`)
    await FileSystem.moveAsync({ from: part, to: dest })
  } finally {
    await FileSystem.deleteAsync(part, { idempotent: true }) // gone already on success
  }
  if (kind === 'audio') await db.setMediaFile(docId, dest)
}

// Drop the video and keep the audio — the step back from "audio + video on phone".
export async function deleteOfflineVideo(docId: string): Promise<void> {
  if (!NATIVE_FS) return
  await FileSystem.deleteAsync(videoFilePath(docId), { idempotent: true })
}

export interface OfflineMediaItem {
  docId: string
  uri: string
  sizeBytes: number
  exists: boolean
}

// listOfflineMedia enumerates every synced Document (its audio plus the video, if
// that was downloaded too). Stale rows (file gone from disk) are repaired: the row is
// dropped and the entry skipped, so the returned list only ever reflects real,
// on-disk media.
export async function listOfflineMedia(): Promise<OfflineMediaItem[]> {
  if (!NATIVE_FS) return []
  const items: OfflineMediaItem[] = []
  for (const { documentId } of await db.listMediaFiles()) {
    const found = await findOfflineMedia(documentId)
    if (!found.audioUri) {
      // Stale row, already repaired — a video left behind has no way back to it.
      await deleteOfflineVideo(documentId)
      continue
    }
    items.push({ docId: documentId, uri: found.audioUri, sizeBytes: found.sizeBytes, exists: true })
  }
  return items
}

// deleteOfflineMedia removes the on-disk files and the `media_files` row. The
// server-side resume position is intentionally left intact.
export async function deleteOfflineMedia(docId: string): Promise<void> {
  if (!NATIVE_FS) return
  const uri = await db.getMediaFile(docId)
  if (uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
  await deleteOfflineVideo(docId).catch(() => {})
  await db.setMediaFile(docId, null)
}

export function totalOfflineBytes(items: OfflineMediaItem[]): number {
  return items.reduce((sum, it) => sum + it.sizeBytes, 0)
}

// formatBytes renders a byte count as a human-readable size (e.g. "12.4 MB").
export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const value = n / Math.pow(1024, i)
  const rounded = i === 0 ? value : Math.round(value * 10) / 10
  return `${rounded} ${units[i]}`
}
