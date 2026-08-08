import { Platform } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import * as db from './db'

// Offline media cache management. Mirrors the sync path in VideoDocument.tsx:
// audio assets are downloaded to FileSystem.documentDirectory and their local URI
// is recorded in the replica's `media_files` table. This module enumerates and
// deletes those cached files so the user can reclaim space.
//
// `expo-file-system` is native-only. On web the module still imports cleanly, but
// every function is a safe no-op / empty result so a web build never crashes.

// Capability guard: FileSystem has no real filesystem on web (documentDirectory
// is null there). Treat that as "no offline cache available".
const NATIVE_FS = Platform.OS !== 'web' && !!FileSystem.documentDirectory

export interface OfflineMediaItem {
  docId: string
  uri: string
  sizeBytes: number
  exists: boolean
}

// listOfflineMedia enumerates every synced audio file. Stale rows (file gone from
// disk) are repaired: the row is dropped and the entry skipped, so the returned list
// only ever reflects real, on-disk media.
export async function listOfflineMedia(): Promise<OfflineMediaItem[]> {
  if (!NATIVE_FS) return []
  const items: OfflineMediaItem[] = []
  for (const { documentId, uri } of await db.listMediaFiles()) {
    try {
      const info = await FileSystem.getInfoAsync(uri)
      if (!info.exists) {
        // Stale row — the file was deleted out from under us. Repair and skip.
        await db.setMediaFile(documentId, null)
        continue
      }
      items.push({
        docId: documentId,
        uri,
        sizeBytes: typeof info.size === 'number' ? info.size : 0,
        exists: true,
      })
    } catch {
      // Unreadable entry — treat as stale.
      await db.setMediaFile(documentId, null)
    }
  }
  return items
}

// deleteOfflineMedia removes the on-disk file and its `media_files` row. The
// server-side resume position is intentionally left intact.
export async function deleteOfflineMedia(docId: string): Promise<void> {
  if (!NATIVE_FS) return
  const uri = await db.getMediaFile(docId)
  if (uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
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
