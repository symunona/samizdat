// One React Query cache for the three server-side services that can be BROKEN
// (yt-dlp proxy, export mirror, LLM providers). Settings renders them in full;
// the drawer only needs "is anything degraded?" — sharing these hooks keeps the
// two from double-fetching or disagreeing.
import { useQuery } from '@tanstack/react-query'
import { useConnection } from './ConnectionContext'
import { usePersistHealth } from './store/persistHealth'
import { fetchYtdlpProxyStatus } from './proxyStatus'
import { fetchExportStats } from './exportStats'
import { fetchLLMStatus } from './llmStatus'

function useConnected() {
  const { activeUrl, token, status } = useConnection()
  return { activeUrl, token, enabled: status === 'connected' && !!activeUrl && !!token }
}

export function useProxyStatus() {
  const { activeUrl, token, enabled } = useConnected()
  return useQuery({
    queryKey: ['ytdlpStatus', activeUrl],
    queryFn: () => fetchYtdlpProxyStatus(activeUrl!, token!),
    enabled,
    // 20s: the proxy host (a home node over Tailscale) comes and goes, and the
    // card must flip back to green on its own.
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: 1,
  })
}

export function useExportStats() {
  const { activeUrl, token, enabled } = useConnected()
  return useQuery({
    queryKey: ['exportStats', activeUrl],
    queryFn: () => fetchExportStats(activeUrl!, token!),
    enabled,
    // The GET also triggers a server-side re-export — poll slowly, refetch on demand.
    staleTime: 60_000,
    retry: 1,
  })
}

export function useLLMStatus() {
  const { activeUrl, token, enabled } = useConnected()
  return useQuery({
    queryKey: ['llmStatus', activeUrl],
    queryFn: () => fetchLLMStatus(activeUrl!, token!),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  })
}

// useServiceAlert is true when a service the user relies on is degraded — the
// signal behind the drawer dot. A provider dropped from config ("retired") is
// history, not an alert. The one client-side member of the set is the offline
// replica's write path: when it fails the app keeps working but stops saving.
export function useServiceAlert(): boolean {
  const { data: proxy } = useProxyStatus()
  const { data: exp } = useExportStats()
  const { data: llm } = useLLMStatus()
  const persistBroken = usePersistHealth((s) => s.failure !== null)
  const proxyDown = !!proxy?.configured && !proxy.ok
  // A stale yt-dlp breaks every video ingest on every proxy, so it belongs in
  // the same dot — it is a broken service, just not a broken proxy.
  const ytdlpStale = !!proxy?.ytdlp?.stale
  const exportBroken = !!exp?.enabled && !!exp.last_error
  // Only the routing chain can break a pipeline: a 'retired' provider is history
  // and an 'available' one (discovered from an env key, nothing routes to it) is
  // an offer, not a dependency.
  const llmBroken = !!llm?.providers.some(
    (p) => (p.role === 'primary' || p.role === 'fallback') && p.status === 'error',
  )
  return persistBroken || proxyDown || ytdlpStale || exportBroken || llmBroken
}
