import { Platform } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { useConnection } from './ConnectionContext'
import { fetchLatestAndroidBuild, health, type AndroidBuild } from './api'
import { isUpdateAvailable, WEB_BUILD_COMMIT } from './appVersion'

// Shared source of truth for "is a newer hosted APK available?" — one React Query
// so the drawer badge and the Settings card never double-fetch or disagree.
// Polls periodically so the badge appears without opening Settings.
export function useLatestBuild() {
  const { activeUrl, token, status } = useConnection()
  return useQuery({
    queryKey: ['androidBuild', activeUrl],
    queryFn: () => fetchLatestAndroidBuild(activeUrl!, token!),
    enabled: status === 'connected' && !!activeUrl && !!token,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  })
}

export function useUpdateAvailable(): { build: AndroidBuild | null; available: boolean } {
  const { data } = useLatestBuild()
  // APK update is a native concept — never surface it on the web build.
  const isNative = Platform.OS !== 'web'
  return { build: data ?? null, available: isNative && !!data && isUpdateAvailable(data) }
}

// Web-only: the served bundle can go stale in an open tab after a redeploy. Poll
// the (public) /health commit and compare to the commit baked into this bundle;
// a mismatch means the server now serves newer assets → prompt a reload.
export function useWebReloadAvailable(): boolean {
  const { activeUrl, status } = useConnection()
  const { data } = useQuery({
    queryKey: ['health', activeUrl],
    queryFn: () => health(activeUrl!),
    enabled: Platform.OS === 'web' && status === 'connected' && !!activeUrl && !!WEB_BUILD_COMMIT,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  })
  if (Platform.OS !== 'web' || !WEB_BUILD_COMMIT || !data?.commit) return false
  return data.commit !== WEB_BUILD_COMMIT
}
