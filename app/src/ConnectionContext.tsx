import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { findReachable } from './api'
import type { Me } from './api'
import { loadConnection } from './storage'
import type { StoredConnection } from './storage'

type ConnectionStatus = 'loading' | 'connected' | 'disconnected'

export type ConnectionState = {
  status: ConnectionStatus
  activeUrl: string | null
  serverUrls: string[]
  token: string | null
  deviceId: string | null
  serverInfo: Me | null
  lastChecked: Date | null
  probe: () => void
  reload: () => void
}

const Ctx = createContext<ConnectionState>({
  status: 'loading',
  activeUrl: null,
  serverUrls: [],
  token: null,
  deviceId: null,
  serverInfo: null,
  lastChecked: null,
  probe: () => {},
  reload: () => {},
})

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<ConnectionStatus>('loading')
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<Me | null>(null)
  const [lastChecked, setLastChecked] = useState<Date | null>(null)
  const [stored, setStored] = useState<StoredConnection | null>(null)
  const [storageLoaded, setStorageLoaded] = useState(false)

  const reload = useCallback(() => {
    loadConnection().then((c) => {
      setStored(c)
      setStorageLoaded(true)
    })
  }, [])

  useEffect(() => { reload() }, [reload])

  const probe = useCallback(async (conn: StoredConnection | null) => {
    if (!conn) {
      setStatus('disconnected')
      setActiveUrl(null)
      setServerInfo(null)
      setLastChecked(new Date())
      return
    }
    try {
      const found = await findReachable(conn.serverUrls, conn.token)
      if (found) {
        setActiveUrl(found.url)
        setServerInfo(found.info)
        setStatus('connected')
      } else {
        setActiveUrl(null)
        setServerInfo(null)
        setStatus('disconnected')
      }
    } catch {
      setStatus('disconnected')
    }
    setLastChecked(new Date())
  }, [])

  useEffect(() => {
    if (!storageLoaded) return
    probe(stored)
    const interval = setInterval(() => probe(stored), 30_000)
    return () => clearInterval(interval)
  }, [stored, storageLoaded, probe])

  return (
    <Ctx.Provider value={{
      status,
      activeUrl,
      serverUrls: stored?.serverUrls ?? [],
      token: stored?.token ?? null,
      deviceId: stored?.deviceId ?? null,
      serverInfo,
      lastChecked,
      probe: () => probe(stored),
      reload,
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useConnection(): ConnectionState {
  return useContext(Ctx)
}
