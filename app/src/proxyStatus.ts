// Client for the yt-dlp proxy health endpoint (GET /api/v1/ytdlp/status).
// Kept separate from api.ts to avoid touching that file while it's being edited.
import { ApiError } from './api'

export interface YtdlpProxyEntry {
  proxy: string
  label: string
  ok: boolean
  exit_ip: string
  error: string
  checked_at: string
  last_ok_at: string
  active: boolean // the entry jobs currently route through
}

// The binary's own version state. It rides the proxy endpoint on purpose: a
// stale yt-dlp fails every ingest on every egress IP, which reads as "the proxy
// broke" unless the card says otherwise.
export interface YtdlpVersion {
  installed: string
  latest: string
  age_days: number
  stale: boolean
  error: string
  checked_at: string
}

export interface YtdlpProxyStatus {
  configured: boolean
  // The flat fields describe the ACTIVE proxy — they predate the pool and stay
  // so an older app build keeps rendering.
  proxy: string
  ok: boolean
  exit_ip: string
  error: string
  checked_at: string
  last_ok_at: string
  proxies: YtdlpProxyEntry[] // every configured proxy, in preference order
  ytdlp?: YtdlpVersion       // absent from a pre-pool server
}

export async function fetchYtdlpProxyStatus(serverUrl: string, token: string): Promise<YtdlpProxyStatus> {
  const url = serverUrl.trim().replace(/\/+$/, '')
  const res = await fetch(`${url}/api/v1/ytdlp/status`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `/api/v1/ytdlp/status failed: HTTP ${res.status}`)
  const st = (await res.json()) as YtdlpProxyStatus
  // A pre-pool server sends no `proxies`; synthesize the one-entry list from the
  // flat fields so the card has a single shape to render.
  if (!Array.isArray(st.proxies)) {
    st.proxies = st.configured
      ? [{
          proxy: st.proxy,
          label: proxyLabel(st.proxy),
          ok: st.ok,
          exit_ip: st.exit_ip,
          error: st.error,
          checked_at: st.checked_at,
          last_ok_at: st.last_ok_at,
          active: true,
        }]
      : []
  }
  return st
}

// proxyLabel shortens a proxy URL to its node name, mirroring the server's
// proxypool.Label — only needed for the pre-pool fallback above.
export function proxyLabel(proxy: string): string {
  const m = /^[a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(proxy.trim())
  const host = m ? m[1] : proxy.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host
  const dot = host.indexOf('.')
  return dot > 0 ? host.slice(0, dot) : host
}
