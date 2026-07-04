import { useQuery } from '@tanstack/react-query'
import { useConnection } from './ConnectionContext'
import { fetchLatestAndroidBuild, type AndroidBuild } from './api'
import { isUpdateAvailable } from './appVersion'

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
  return { build: data ?? null, available: !!data && isUpdateAvailable(data) }
}
