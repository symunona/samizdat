import '../src/theme'
import { useEffect, useState } from 'react'
import { Slot, useRouter, useSegments } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UnistylesRuntime } from 'react-native-unistyles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadConnection, loadTheme } from '../src/storage'
import type { StoredConnection } from '../src/storage'
import { ConnectionProvider } from '../src/ConnectionContext'
import { ToastProvider } from '../src/ToastContext'
import { ConfirmProvider } from '../src/ConfirmContext'
import { useSyncEffect } from '../src/store/useSyncEffect'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

function SyncEffects() {
  useSyncEffect()
  return null
}

export default function RootLayout() {
  const router = useRouter()
  const segments = useSegments()
  const [conn, setConn] = useState<StoredConnection | null | 'loading'>('loading')

  useEffect(() => {
    loadTheme().then((t) => UnistylesRuntime.setTheme(t))
  }, [])

  useEffect(() => {
    loadConnection().then((c: StoredConnection | null) => setConn(c))
  }, [segments])

  useEffect(() => {
    if (conn === 'loading') return

    const inConnect = segments[0] === 'connect'

    if (!conn && !inConnect) {
      router.replace('/connect')
    } else if (conn && inConnect) {
      router.replace('/')
    }
  }, [conn, segments, router])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider>
          <SyncEffects />
          <ToastProvider>
            <ConfirmProvider>
              <Slot />
            </ConfirmProvider>
          </ToastProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  )
}
