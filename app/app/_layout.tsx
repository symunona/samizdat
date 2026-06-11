import '../src/theme'
import { useEffect } from 'react'
import { Slot, useRouter, usePathname } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UnistylesRuntime } from 'react-native-unistyles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadTheme } from '../src/storage'
import { ConnectionProvider, useConnection } from '../src/ConnectionContext'
import { ToastProvider } from '../src/ToastContext'
import { ConfirmProvider } from '../src/ConfirmContext'
import { useSyncEffect } from '../src/store/useSyncEffect'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

// Runs inside ConnectionProvider — uses reactive connection state for routing.
// usePathname() (stable string) is used instead of useSegments() (new array ref
// every render) to avoid the infinite-update loop that triggers React error #185.
function NavigationGuard() {
  const router = useRouter()
  const pathname = usePathname()
  const { status, token } = useConnection()

  useEffect(() => {
    if (status === 'loading') return
    const inConnect = pathname === '/connect' || pathname.startsWith('/connect/')
    if (status === 'disconnected' && !token && !inConnect) {
      router.replace('/connect')
    } else if (status === 'connected' && inConnect) {
      router.replace('/')
    }
  }, [status, token, pathname, router])

  return null
}

function SyncEffects() {
  useSyncEffect()
  return null
}

export default function RootLayout() {
  useEffect(() => {
    loadTheme().then((t) => UnistylesRuntime.setTheme(t))
  }, [])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider>
          <NavigationGuard />
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
