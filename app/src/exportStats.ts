// Client for the auto-export stats endpoint (GET /api/v1/export/stats).
// Kept separate from api.ts to avoid touching that file while it's being edited.
import { ApiError } from './api'

export interface ExportStats {
  enabled: boolean
  dir: string
  doc_count: number
  annotation_count: number
  last_export_at: string
  last_error: string
}

export async function fetchExportStats(serverUrl: string, token: string): Promise<ExportStats> {
  const url = serverUrl.trim().replace(/\/+$/, '')
  const res = await fetch(`${url}/api/v1/export/stats`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `/api/v1/export/stats failed: HTTP ${res.status}`)
  return res.json() as Promise<ExportStats>
}
