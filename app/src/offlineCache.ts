import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as FileSystem from 'expo-file-system/legacy'

// Offline media cache management. Mirrors the sync path in VideoDocument.tsx:
// audio assets are downloaded to FileSystem.documentDirectory and their local URI
// is persisted in AsyncStorage under `video_audio_<docId>`. This module enumerates
// and deletes those cached files so the user can reclaim space.
//
// `expo-file-system` is native-only. On web the module still imports cleanly, but
// every function is a safe no-op / empty result so a web build never crashes.

const OFFLINE_AUDIO_PREFIX = 'video_audio_'

// Capability guard: FileSystem has no real filesystem on web (documentDirectory
// is null there). Treat that as "no offline cache available".
const NATIVE_FS = Platform.OS !== 'web' && !!FileSystem.documentDirectory

export interface OfflineMediaItem {
  docId: string
  uri: string
  sizeBytes: number
  exists: boolean
}

// listOfflineMedia enumerates every synced audio file. Stale AsyncStorage keys
// (file gone from disk) are repaired: the key is removed and the entry skipped,
// so the returned list only ever reflects real, on-disk media.
export async function listOfflineMedia(): Promise<OfflineMediaItem[]> {
  if (!NATIVE_FS) return []
  const keys = await AsyncStorage.getAllKeys()
  const audioKeys = keys.filter((k) => k.startsWith(OFFLINE_AUDIO_PREFIX))
  const items: OfflineMediaItem[] = []
  for (const key of audioKeys) {
    const docId = key.slice(OFFLINE_AUDIO_PREFIX.length)
    const uri = await AsyncStorage.getItem(key)
    if (!uri) {
      await AsyncStorage.removeItem(key).catch(() => {})
      continue
    }
    try {
      const info = await FileSystem.getInfoAsync(uri)
      if (!info.exists) {
        // Stale key — the file was deleted out from under us. Repair and skip.
        await AsyncStorage.removeItem(key).catch(() => {})
        continue
      }
      items.push({
        docId,
        uri,
        sizeBytes: typeof info.size === 'number' ? info.size : 0,
        exists: true,
      })
    } catch {
      // Unreadable entry — treat as stale.
      await AsyncStorage.removeItem(key).catch(() => {})
    }
  }
  return items
}

// deleteOfflineMedia removes the on-disk file and its AsyncStorage pointer. The
// `video_pos_<docId>` resume position is intentionally left intact.
export async function deleteOfflineMedia(docId: string): Promise<void> {
  if (!NATIVE_FS) return
  const key = OFFLINE_AUDIO_PREFIX + docId
  const uri = await AsyncStorage.getItem(key)
  if (uri) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {})
  }
  await AsyncStorage.removeItem(key)
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
