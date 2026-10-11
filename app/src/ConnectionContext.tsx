import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { findReachable, ApiError } from './api'
import type { Me } from './api'
import { loadConnection, clearConnection } from './storage'
import { loadLastSuccessfulUrl, saveLastSuccessfulUrl, saveUrlLastUsed } from './prefs'
import type { StoredConnection } from './storage'
import { createLogger } from './logger'

const log = createLogger('connection')

type ConnectionStatus = 'loading' | 'connected' | 'disconnected'

export type ConnectionState = {
  status: ConnectionStatus
  error: string | null
  activeUrl: string | null
  serverUrls: string[]
  token: string | null
  deviceId: string | null
  serverInfo: Me | null
  lastChecked: Date | null
  probe: () => void
  reload: () => Promise<void>
  logout: () => Promise<void>
}

const Ctx = createContext<ConnectionState>({
  status: 'loading',
  error: null,
  activeUrl: null,
  serverUrls: [],
  token: null,
  deviceId: null,
  serverInfo: null,
  lastChecked: null,
  probe: () => {},
  reload: () => Promise.resolve(),
  logout: async () => {},
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<Me | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [stored, setStored] = useState<StoredConnection | null>(null)
  const [storageLoaded, setStorageLoaded] = useState(false)
  const lastSuccessfulUrlRef = useRef<string | null>(null)

  const reload = useCallback((): Promise<void> => {
    return Promise.all([loadConnection(), loadLastSuccessfulUrl()]).then(([c, lastUrl]) => {
      setStored(c)
      lastSuccessfulUrlRef.current = lastUrl
      setStorageLoaded(true)
    })
  }, [])

  const logout = useCallback(async () => {
    await clearConnection()
    setStored(null)
    setActiveUrl(null)
    setServerInfo(null)
    setStatus('disconnected')
    setStorageLoaded(true)
  }, [])

  useEffect(() => { reload() }, [reload])

  const probe = useCallback(async (conn: StoredConnection | null) => {
    if (!conn) {
      setError(null)
      setStatus('disconnected')
      setActiveUrl(null)
      setServerInfo(null)
      setLastChecked(new Date())
      return
    }
    try {
      const found = await findReachable(conn.serverUrls, conn.token, lastSuccessfulUrlRef.current)
      if (found) {
        setActiveUrl(found.url)
        setServerInfo(found.info)
        setError(null)
        setStatus('connected')
        saveUrlLastUsed(found.url)
        if (found.url !== lastSuccessfulUrlRef.current) {
          log.log(`server moved: ${lastSuccessfulUrlRef.current ?? 'none'} → ${found.url}`)
          lastSuccessfulUrlRef.current = found.url
          saveLastSuccessfulUrl(found.url)
        }
      } else {
        log.warn(`probe failed: none of ${conn.serverUrls.length} server URLs answered (was ${lastSuccessfulUrlRef.current ?? 'none'})`)
        setActiveUrl(null)
        setServerInfo(null)
        setError('Server unreachable')
        setStatus('disconnected')
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await clearConnection()
        setStored(null)
        setActiveUrl(null)
        setServerInfo(null)
        setError('Unauthorized — please reconnect')
        setStatus('disconnected')
      } else {
        log.warn('probe failed:', e instanceof Error ? e.message : e)
        setError(e instanceof Error ? e.message : 'Connection failed')
        setStatus('disconnected')
      }
    }
    setLastChecked(new Date())
  }, [])

  useEffect(() => {
    if (!storageLoaded) return
    probe(stored)
    // No probing behind a lock screen: every result re-renders each consumer, and
    // a phone in Doze answers slowly enough to read as "server unreachable". Coming
    // back to the foreground probes at once instead of waiting out the interval.
    const interval = setInterval(() => { if (AppState.currentState === 'active') probe(stored) }, 30_000)
    const app = AppState.addEventListener('change', s => { if (s === 'active') probe(stored) })
    return () => { clearInterval(interval); app.remove() }
  }, [stored, storageLoaded, probe])

  return (
    <Ctx.Provider value={{
      status,
      error,
      activeUrl,
      serverUrls: stored?.serverUrls ?? [],
      token: stored?.token ?? null,
      deviceId: stored?.deviceId ?? null,
      serverInfo,
      lastChecked,
      probe: () => probe(stored),
      reload,
      logout,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useConnection(): ConnectionState {
  return useContext(Ctx)
}
