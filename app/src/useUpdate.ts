import { Platform } from 'react-native'
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
  // APK update is a native concept — never surface it on the web build.
  const isNative = Platform.OS !== 'web'
  return { build: data ?? null, available: isNative && !!data && isUpdateAvailable(data) }
}

// Web-only: the served bundle can go stale in an open tab after a redeploy.
// Compare THIS tab's content-hashed entry bundle (`index-<hash>.js`) to the one
// the server currently serves in its index.html. A mismatch means app/dist was
// re-exported with new assets → prompt a reload. We key off the bundle hash, NOT
// a git commit or /health: the served web assets are what actually went stale,
// and they're independent of the server binary's build commit (a server-only
// rebuild must not raise a phantom "new version"). Expo content-hashes the entry
// file, so the hash is a precise identity — a rebuild with no changes keeps the
// same hash (no false prompt), and after a reload the tab loads the new hash and
// the prompt clears.
const ENTRY_BUNDLE_RE = /\/index-([A-Za-z0-9]+)\.js/

function ownBundleHash(): string | null {
  if (typeof document === 'undefined') return null
  for (const sc of Array.from(document.scripts)) {
    const m = sc.src.match(ENTRY_BUNDLE_RE)
    if (m) return m[1]
  }
  return null
}

async function servedBundleHash(): Promise<string | null> {
  // Relative to the origin serving this tab (the web build is always same-origin
  // with its server). no-store so an HTTP cache can't mask a fresh deploy.
  const res = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } })
  const html = await res.text()
  const m = html.match(ENTRY_BUNDLE_RE)
  return m ? m[1] : null
}

export function useWebReloadAvailable(): boolean {
  const { status } = useConnection()
  const own = ownBundleHash()
  const { data: served } = useQuery({
    queryKey: ['webBundleHash'],
    queryFn: servedBundleHash,
    enabled: Platform.OS === 'web' && status === 'connected' && !!own,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  })
  if (Platform.OS !== 'web' || !own || !served) return false
  return served !== own
}
