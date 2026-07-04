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
import ShareIntentBridge from '../src/ShareIntentBridge'
import WebReloadBanner from '../src/WebReloadBanner'
import { useSyncEffect } from '../src/store/useSyncEffect'
import { useDebugLogStore } from '../src/store/debugLogStore'
import { setDebugLogTarget, logToServer } from '../src/debugLog'

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

// Streams JS + WebView logs to the server's device-log channel when connected
// and the toggle is on. Also installs a global uncaught-error handler so crashes
// reach the channel. See src/debugLog.ts and app/CLAUDE.md.
function DebugLogBridge() {
  const { activeUrl, token, deviceId, status } = useConnection()
  const enabled = useDebugLogStore((s) => s.enabled)
  const hydrate = useDebugLogStore((s) => s.hydrate)

  useEffect(() => { void hydrate() }, [hydrate])

  useEffect(() => {
    const on = enabled && status === 'connected'
    setDebugLogTarget(on ? activeUrl : null, on ? token : null, deviceId, on)
  }, [activeUrl, token, deviceId, status, enabled])

  // Route uncaught JS errors into the channel. On native, ErrorUtils is the
  // global handler; on web we listen for window error/rejection events.
  useEffect(() => {
    if (Platform.OS === 'web') {
      const onErr = (e: ErrorEvent) => logToServer('error', 'uncaught', e.message, e.error?.stack ?? '')
      const onRej = (e: PromiseRejectionEvent) => logToServer('error', 'unhandledRejection', e.reason)
      window.addEventListener('error', onErr)
      window.addEventListener('unhandledrejection', onRej)
      return () => {
        window.removeEventListener('error', onErr)
        window.removeEventListener('unhandledrejection', onRej)
      }
    }
    const g = globalThis as unknown as {
      ErrorUtils?: { getGlobalHandler: () => (e: unknown, f: boolean) => void; setGlobalHandler: (h: (e: unknown, f: boolean) => void) => void }
    }
    const prev = g.ErrorUtils?.getGlobalHandler()
    g.ErrorUtils?.setGlobalHandler((e: unknown, isFatal: boolean) => {
      logToServer('error', 'uncaught', `${isFatal ? 'FATAL ' : ''}`, e)
      prev?.(e, isFatal)
    })
    return () => { if (prev) g.ErrorUtils?.setGlobalHandler(prev) }
  }, [])

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
          <DebugLogBridge />
          <ToastProvider>
            <ConfirmProvider>
              <ScrapeQueueProvider>
                <ShareIntentBridge />
                <Slot />
                <WebReloadBanner />
              </ScrapeQueueProvider>
            </ConfirmProvider>
          </ToastProvider>
        </ConnectionProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  )
}
