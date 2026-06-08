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
  return json<Health>(await fetch(`${base(url)}/health`), '/health')
}

export async function pair(url: string, code: string, name?: string): Promise<PairResult> {
  const res = await fetch(`${base(url)}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name }),
  })
  return json<PairResult>(res, 'pair')
}

export async function me(url: string, token: string): Promise<Me> {
  const res = await fetch(`${base(url)}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return json<Me>(res, '/me')
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
