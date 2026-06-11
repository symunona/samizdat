import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { usePathname } from 'expo-router'
import { useConnection } from '../ConnectionContext'
import { requestSync } from './syncEngine'

const POLL_INTERVAL_MS = 30_000

export function useSyncEffect() {
  const { status, activeUrl, token } = useConnection()
  const pathname = usePathname()
  const connectedRef = useRef(false)

  // Unified trigger — every auto-sync goes through requestSync (debounced)
  function sync() {
    if (status === 'connected' && activeUrl && token) {
      requestSync(activeUrl, token)
    }
  }

  // On connect
  useEffect(() => {
    if (status === 'connected' && !connectedRef.current) {
      connectedRef.current = true
      sync()
    }
    if (status !== 'connected') {
      connectedRef.current = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, activeUrl, token])

  // On navigation
  useEffect(() => {
    sync()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  // On app foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') sync()
    })
    return () => sub.remove()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, activeUrl, token])

  // Periodic fallback — catches completed jobs within 30s
  useEffect(() => {
    if (status !== 'connected') return
    const interval = setInterval(sync, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, activeUrl, token])
}
