// Client for the Router's ad-hoc completion endpoint. Sibling of llmModels.ts /
// llmStatus.ts: those ask about providers, this one asks a question. Every call
// is metered server-side in the same ledger a pipeline step writes to.
import { ApiError } from './api'

export type AskRequest = {
  prompt: string
  /** The user's master prompt. The server prepends it to the message. */
  system?: string
  provider?: string
  model?: string
}

export type AskResult = {
  reply: string
  model: string
  provider: string
  tokens_in: number
  tokens_out: number
}

export async function askLLM(
  serverUrl: string, token: string, req: AskRequest, signal?: AbortSignal,
): Promise<AskResult> {
  const res = await fetch(`${serverUrl.trim().replace(/\/+$/, '')}/api/v1/llm/ask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok) {
    // The server answers a provider failure with a readable reason (no key, out of
    // credits, box down) — show that, not "HTTP 502".
    let detail = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch { /* keep the status */ }
    throw new ApiError(res.status, detail)
  }
  return (await res.json()) as AskResult
}
