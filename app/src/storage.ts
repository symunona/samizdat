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

const LAST_URL_KEY = 'samizdat_last_url'

const THEME_KEY = 'samizdat_theme'

export async function saveTheme(theme: 'dark' | 'light'): Promise<void> {
  await AsyncStorage.setItem(THEME_KEY, theme)
}

export async function loadTheme(): Promise<'dark' | 'light'> {
  try {
    const raw = await AsyncStorage.getItem(THEME_KEY)
    return raw === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

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
