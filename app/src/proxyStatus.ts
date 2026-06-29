// Client for the yt-dlp proxy health endpoint (GET /api/v1/ytdlp/status).
// Kept separate from api.ts to avoid touching that file while it's being edited.
import { ApiError } from './api'

export interface YtdlpProxyStatus {
  configured: boolean
  proxy: string
  ok: boolean
  exit_ip: string
  error: string
  checked_at: string
  last_ok_at: string
}

export async function fetchYtdlpProxyStatus(serverUrl: string, token: string): Promise<YtdlpProxyStatus> {
  const url = serverUrl.trim().replace(/\/+$/, '')
  const res = await fetch(`${url}/api/v1/ytdlp/status`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `/api/v1/ytdlp/status failed: HTTP ${res.status}`)
  return res.json() as Promise<YtdlpProxyStatus>
}
