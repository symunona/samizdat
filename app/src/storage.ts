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
const URL_LAST_USED_KEY = 'samizdat_url_last_used'

export async function saveUrlLastUsed(url: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(URL_LAST_USED_KEY)
    const map: Record<string, string> = raw ? JSON.parse(raw) : {}
    map[url] = new Date().toISOString()
    await AsyncStorage.setItem(URL_LAST_USED_KEY, JSON.stringify(map))
  } catch { /* best-effort */ }
}

export async function loadUrlLastUsedMap(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(URL_LAST_USED_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

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
