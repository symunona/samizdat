import '../src/theme'
import { useEffect } from 'react'
import { Platform } from 'react-native'
import { setAudioModeAsync } from 'expo-audio'
import { Slot, useRouter, usePathname } from 'expo-router'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { UnistylesRuntime } from 'react-native-unistyles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadTheme } from '../src/storage'
import { ConnectionProvider, useConnection } from '../src/ConnectionContext'
import { ToastProvider } from '../src/ToastContext'
import { ConfirmProvider } from '../src/ConfirmContext'
import { ScrapeQueueProvider } from '../src/ScrapeQueueContext'
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

  // Keep audio playing when the app is backgrounded/locked and surface lock-screen
  // controls. `doNotMix` is required for those controls; the expo-audio config plugin
  // supplies the matching native background-audio entitlements at prebuild.
  useEffect(() => {
    if (Platform.OS === 'web') return
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' })
      .catch(() => {})
  }, [])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <ConnectionProvider>
          <NavigationGuard />
          <SyncEffects />
          <ToastProvider>
            <ConfirmProvider>
              <ScrapeQueueProvider>
                <Slot />
              </ScrapeQueueProvider>
            </ConfirmProvider>
          </ToastProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  )
}
