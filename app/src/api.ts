// Samizdat server client (Milestone 1: pair + health + multi-URL).

export type PairResult = {
  device_token: string
  device_id: string
  server_urls?: string[]  // ordered: localhost → LAN → Tailscale
}
export type Health = { status: string; version?: string; time?: string }
export type Me = { device_id: string; name?: string; server_version?: string }

function base(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function health(url: string): Promise<Health> {
  return json<Health>(await fetch(`${base(url)}/api/v1/health`), '/api/v1/health')
}

export async function pair(url: string, code: string, name?: string): Promise<PairResult> {
  const res = await fetch(`${base(url)}/api/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  })
  return json<PairResult>(res, 'pair')
}

export async function me(url: string, token: string): Promise<Me> {
  const res = await fetch(`${base(url)}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Me>(res, '/api/v1/me')
}

// Try each URL in order; return the first one that successfully connects.
// Returns null if all fail.
export async function findReachable(
  urls: string[],
  token: string,
): Promise<{ url: string; info: Me } | null> {
  for (const url of urls) {
    try {
      const info = await me(url, token)
      return { url, info }
    } catch {
      // try next
    }
  }
  return null
}

export type Document = {
  id: string
  canonical_url: string
  title: string
  markdown: string
  fetched_at: string
}

export async function fetchDocument(serverUrl: string, token: string, id: string): Promise<Document> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Document>(res, '/api/v1/documents/:id')
}

export async function fetchDocuments(serverUrl: string, token: string): Promise<Document[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Document[]>(res, '/api/v1/documents')
}

export type DeviceInfo = {
  id: string
  name: string
  created_at: string
}
export type DeviceListResult = {
  devices: DeviceInfo[]
  current_device_id: string
}

export async function fetchDevices(serverUrl: string, token: string): Promise<DeviceListResult> {
  const res = await fetch(`${base(serverUrl)}/api/v1/devices`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<DeviceListResult>(res, '/api/v1/devices')
}

export async function fetchReadingProgress(
  serverUrl: string,
  token: string,
  docId: string,
): Promise<{ scroll_y: number } | null> {
  try {
    const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/progress`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.status === 404) return null
    return json<{ scroll_y: number }>(res, '/api/v1/documents/:id/progress')
  } catch {
    return null
  }
}

export async function saveReadingProgress(
  serverUrl: string,
  token: string,
  docId: string,
  scrollY: number,
): Promise<void> {
  await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/progress`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scroll_y: scrollY }),
  })
}

export async function submitScrapeJob(
  serverUrl: string,
  token: string,
  url: string,
): Promise<{ job_id: string }> {
  const res = await fetch(`${base(serverUrl)}/api/v1/jobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  })
  return json<{ job_id: string }>(res, '/api/v1/jobs')
}
