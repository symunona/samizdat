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

const LAST_URL_KEY = 'samizdat_last_url'

export async function saveLastSuccessfulUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(LAST_URL_KEY, url)
}

export async function loadLastSuccessfulUrl(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(LAST_URL_KEY)
  } catch {
    return null
  }
}
