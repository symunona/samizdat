// Minimal Samizdat server client (Milestone 1: pair + health).
// No persistence yet — the device token lives in component state for now.

export type PairResult = { device_token: string; device_id: string };
export type Health = { status: string; version?: string; time?: string };
export type Me = { device_id: string; name?: string; server_version?: string };

function base(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Public health check — confirms the server is reachable. */
export async function health(url: string): Promise<Health> {
  return json<Health>(await fetch(`${base(url)}/health`), "/health");
}

/** Exchange a one-time pairing code (from `sam qr`) for a device token. */
export async function pair(url: string, code: string): Promise<PairResult> {
  const res = await fetch(`${base(url)}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return json<PairResult>(res, "pair");
}

/** Authenticated identity check — drives the "we're online" state. */
export async function me(url: string, token: string): Promise<Me> {
  const res = await fetch(`${base(url)}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return json<Me>(res, "/me");
}
