import '../src/theme'
import { useEffect, useState } from 'react'
import { Slot, useRouter, useSegments } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UnistylesRuntime } from 'react-native-unistyles'
import { loadConnection, loadTheme } from '../src/storage'
import type { StoredConnection } from '../src/storage'
import { ConnectionProvider } from '../src/ConnectionContext'
import { ToastProvider } from '../src/ToastContext'
import { ConfirmProvider } from '../src/ConfirmContext'

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
      <ConnectionProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Slot />
          </ConfirmProvider>
        </ToastProvider>
      </ConnectionProvider>
    </GestureHandlerRootView>
  )
}
