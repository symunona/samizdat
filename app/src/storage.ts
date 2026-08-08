// The ONE thing still kept in AsyncStorage: the connection record.
//
// It has to outlive the local database. If the replica is corrupt, unopenable, or
// wiped, this record is the only way back to the server — without it the app has no
// URL and no token, and there is nothing to re-pull from. Every other preference lives
// in the replica's `settings` table (src/prefs.ts); see app/CLAUDE.md, "DB layer is the
// only storage".

import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'samizdat_connection'

export interface StoredConnection {
  token: string
  deviceId: string
  serverUrls: string[]  // ordered: localhost → LAN → Tailscale
}

export async function saveConnection(conn: StoredConnection): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(conn))
}

export async function loadConnection(): Promise<StoredConnection | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as StoredConnection) : null
  } catch {
    return null
  }
}

export async function clearConnection(): Promise<void> {
  await AsyncStorage.removeItem(KEY)
}

export async function removeServerUrl(url: string): Promise<void> {
  const conn = await loadConnection()
  if (!conn) return
  const updated = { ...conn, serverUrls: conn.serverUrls.filter(u => u !== url) }
  await saveConnection(updated)
}
