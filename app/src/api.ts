// Samizdat server client (Milestone 1: pair + health + multi-URL).

export type PairResult = {
  device_token: string
  device_id: string
  server_urls?: string[]  // ordered: localhost → LAN → Tailscale
}
export type Health = { status: string; version?: string; time?: string }
export type Me = { device_id: string; name?: string; server_version?: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

function base(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new ApiError(res.status, `${what} failed: HTTP ${res.status}`)
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

// Try lastSuccessfulUrl up to 3 times first, then fall through to remaining URLs in order.
// Re-throws ApiError so callers can distinguish auth failures from network failures.
export async function findReachable(
  urls: string[],
  token: string,
  lastSuccessfulUrl?: string | null,
): Promise<{ url: string; info: Me } | null> {
  if (lastSuccessfulUrl && urls.includes(lastSuccessfulUrl)) {
    for (let i = 0; i < 3; i++) {
      try {
        const info = await me(lastSuccessfulUrl, token)
        return { url: lastSuccessfulUrl, info }
      } catch (e) {
        if (e instanceof ApiError) throw e
        // network error — retry
      }
    }
  }
  for (const url of urls) {
    if (url === lastSuccessfulUrl) continue
    try {
      const info = await me(url, token)
      return { url, info }
    } catch (e) {
      if (e instanceof ApiError) throw e
      // network error — try next
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
  excerpt: string
  hero_image_url: string
  author: string
  annotation_count?: number
}

export type MediaAsset = {
  id: string
  document_id: string
  original_url: string
  kind: 'hero' | 'content'
  width: number | null
  height: number | null
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
  last_seen_at?: string
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

export async function revokeDevice(serverUrl: string, token: string, deviceId: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/devices/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `revoke device failed: HTTP ${res.status}`)
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

// ── Feeds & Subscriptions ────────────────────────────────────────────────────

export type Feed = {
  id: string
  url: string
  kind: string
  title: string
  last_polled_at: string | null
  created_at: string
  updated_at: string
}

export type Subscription = {
  id: string
  feed_id: string
  interval_h: number
  next_run_at: string
  created_at: string
  updated_at: string
}

export type FeedItem = {
  id: string
  feed_id: string
  url: string
  status: 'pending' | 'scraped' | 'skipped'
  seen_at: string
}

export async function fetchFeeds(serverUrl: string, token: string): Promise<Feed[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/feeds`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Feed[]>(res, '/api/v1/feeds')
}

export async function fetchSubscriptions(serverUrl: string, token: string): Promise<Subscription[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/subscriptions`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Subscription[]>(res, '/api/v1/subscriptions')
}

export async function createSubscription(
  serverUrl: string, token: string, url: string, intervalH = 24,
): Promise<{ feed: Feed; subscription: Subscription }> {
  const res = await fetch(`${base(serverUrl)}/api/v1/subscriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, interval_h: intervalH }),
  })
  return json<{ feed: Feed; subscription: Subscription }>(res, '/api/v1/subscriptions')
}

export async function deleteSubscription(serverUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `delete subscription failed: HTTP ${res.status}`)
}

export async function pollSubscriptionNow(serverUrl: string, token: string, id: string): Promise<{ job_id: string }> {
  const res = await fetch(`${base(serverUrl)}/api/v1/subscriptions/${encodeURIComponent(id)}/poll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<{ job_id: string }>(res, `/api/v1/subscriptions/${id}/poll`)
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

export type Job = {
  id: string
  kind: string
  payload: string
  status: 'queued' | 'running' | 'done' | 'dead'
  attempts: number
  run_after: string
  last_error: string
  result: string
  created_at: string
  updated_at: string
}

export async function fetchJobs(
  serverUrl: string, token: string,
  opts: { status?: string; kind?: string } = {},
): Promise<Job[]> {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.kind) params.set('kind', opts.kind)
  const qs = params.toString()
  const res = await fetch(`${base(serverUrl)}/api/v1/jobs${qs ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Job[]>(res, '/api/v1/jobs')
}

export async function retryJob(serverUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/jobs/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `retry job failed: HTTP ${res.status}`)
}

export async function clearCompletedJobs(serverUrl: string, token: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/jobs`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `clear jobs failed: HTTP ${res.status}`)
}

export async function deleteDocument(serverUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `delete document failed: HTTP ${res.status}`)
}

export async function fetchDocumentMedia(
  serverUrl: string,
  token: string,
  docId: string,
): Promise<MediaAsset[]> {
  try {
    const res = await fetch(
      `${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/media`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return json<MediaAsset[]>(res, '/api/v1/documents/:id/media')
  } catch {
    return []
  }
}

// ── Annotations ──────────────────────────────────────────────────────────────

export type Annotation = {
  id: string
  document_id: string
  highlight_id: string | null
  exact: string
  prefix: string
  suffix: string
  pos_start: number
  pos_end: number
  color: string
  note: string
  created_at: string
  updated_at: string
}

export async function fetchDocumentHtml(serverUrl: string, token: string, docId: string): Promise<string> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/html`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `fetchDocumentHtml failed: HTTP ${res.status}`)
  return res.text()
}

export async function fetchAnnotations(serverUrl: string, token: string, docId: string): Promise<Annotation[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/annotations`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Annotation[]>(res, '/api/v1/documents/:id/annotations')
}

export async function createAnnotation(
  serverUrl: string, token: string, docId: string,
  data: { exact: string; prefix: string; suffix: string; pos_start: number; pos_end: number; color: string; note: string; highlight_id?: string },
): Promise<Annotation> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/annotations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return json<Annotation>(res, '/api/v1/documents/:id/annotations POST')
}

export async function updateAnnotation(
  serverUrl: string, token: string, id: string,
  data: { note: string; color: string },
): Promise<Annotation> {
  const res = await fetch(`${base(serverUrl)}/api/v1/annotations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return json<Annotation>(res, '/api/v1/annotations/:id PUT')
}

export async function deleteAnnotation(serverUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/annotations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `deleteAnnotation failed: HTTP ${res.status}`)
}

// ── Tags ──────────────────────────────────────────────────────────────────────

export type Tag = {
  id: string
  name: string
  color: string
  created_at: string
  updated_at: string
  rev: number
  deleted_at: string | null
  doc_count?: number
  ann_count?: number
}

export async function fetchTags(serverUrl: string, token: string): Promise<Tag[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/tags`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Tag[]>(res, '/api/v1/tags')
}

export async function createTag(
  serverUrl: string, token: string,
  data: { name: string; color?: string },
): Promise<Tag> {
  const res = await fetch(`${base(serverUrl)}/api/v1/tags`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return json<Tag>(res, '/api/v1/tags POST')
}

export async function deleteTag(serverUrl: string, token: string, id: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/tags/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `deleteTag failed: HTTP ${res.status}`)
}

export async function fetchTagDocuments(serverUrl: string, token: string, tagId: string): Promise<Document[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/tags/${encodeURIComponent(tagId)}/documents`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Document[]>(res, '/api/v1/tags/:id/documents')
}

export async function fetchTagAnnotations(serverUrl: string, token: string, tagId: string): Promise<Annotation[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/tags/${encodeURIComponent(tagId)}/annotations`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Annotation[]>(res, '/api/v1/tags/:id/annotations')
}

export async function fetchDocumentTags(serverUrl: string, token: string, docId: string): Promise<Tag[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/tags`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Tag[]>(res, '/api/v1/documents/:id/tags')
}

export async function addDocumentTag(serverUrl: string, token: string, docId: string, tagId: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/tags`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: tagId }),
  })
  if (!res.ok) throw new ApiError(res.status, `addDocumentTag failed: HTTP ${res.status}`)
}

export async function removeDocumentTag(serverUrl: string, token: string, docId: string, tagId: string): Promise<void> {
  const res = await fetch(
    `${base(serverUrl)}/api/v1/documents/${encodeURIComponent(docId)}/tags/${encodeURIComponent(tagId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new ApiError(res.status, `removeDocumentTag failed: HTTP ${res.status}`)
}

export async function fetchAnnotationTags(serverUrl: string, token: string, annId: string): Promise<Tag[]> {
  const res = await fetch(`${base(serverUrl)}/api/v1/annotations/${encodeURIComponent(annId)}/tags`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Tag[]>(res, '/api/v1/annotations/:id/tags')
}

export async function addAnnotationTag(serverUrl: string, token: string, annId: string, tagId: string): Promise<void> {
  const res = await fetch(`${base(serverUrl)}/api/v1/annotations/${encodeURIComponent(annId)}/tags`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: tagId }),
  })
  if (!res.ok) throw new ApiError(res.status, `addAnnotationTag failed: HTTP ${res.status}`)
}

export async function removeAnnotationTag(
  serverUrl: string, token: string, annId: string, tagId: string,
): Promise<void> {
  const res = await fetch(
    `${base(serverUrl)}/api/v1/annotations/${encodeURIComponent(annId)}/tags/${encodeURIComponent(tagId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new ApiError(res.status, `removeAnnotationTag failed: HTTP ${res.status}`)
}
